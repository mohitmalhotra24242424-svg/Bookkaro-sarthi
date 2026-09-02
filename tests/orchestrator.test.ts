/**
 * STEP 6 — ORCHESTRATOR TESTS (§25 part 2).
 * Covers the api/ai envelope, multi-tool parallel execution, provider routing,
 * budget limits, booking safety and the full 37-case matrix items not already
 * covered by tests/tool-intent.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, isoPlusDays, run } from './orchestration/harness.js';
import { contextWithJourney } from './orchestration/railwayQueries.helpers.js';
import { runAiOrchestrator, detectMultiToolRequest } from '../api/ai/orchestrator.js';
import { executeAiToolCalls, MAX_TOOL_CALLS_PER_TURN } from '../api/ai/tool-executor.js';
import { createModelProvider } from '../api/ai/model-provider.js';
import { AIGateway } from '../ai/AIGateway.js';
import { createInMemoryDraftStore } from '../tools/executors/index.js';

function apiHarness(harness: ReturnType<typeof createHarness>) {
  return {
    deps: { ai: harness.deps.ai, registry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') },
    harness,
  };
}


describe('orchestrator envelope (§1)', () => {
  it('returns the exact Step-6 output shape', async () => {
    const { harness } = apiHarness(createHarness());
    const output = await runAiOrchestrator(
      { message: '12014 ka live status batao', conversationId: 'conv-1', context: freshContext() },
      { ai: harness.deps.ai, registry: harness.toolRegistry },
    );
    for (const key of ['intent', 'entities', 'requiredTools', 'toolArguments', 'response', 'missingSlots', 'interrupt', 'resumeContext', 'safety']) {
      expect(output, key).toHaveProperty(key);
    }
    expect(output.intent).toBe('LIVE_TRAIN_STATUS');
    expect(output.requiredTools).toContain('getLiveStatus');
    expect(output.safety.aiCanBook).toBe(false);
    expect(output.safety.aiCanMoveMoney).toBe(false);
    expect(output.safety.providersChosenBy).toBe('server-router');
  });

  it('interrupt/resume context is surfaced in the envelope', async () => {
    const { harness } = apiHarness(createHarness());
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const output = await runAiOrchestrator(
      { message: '12014 ka live status batao', conversationId: context.id, context },
      { ai: harness.deps.ai, registry: harness.toolRegistry },
    );
    expect(output.interrupt).toBe(true);
    expect(output.resumeContext).toMatchObject({ pausedAtStage: 'COLLECT_JOURNEY' });
    expect(output.response).toMatch(/Wapas aapki booking/i);
  });
});

describe('multi-tool selection + parallel execution (§10/§11/§25: 27-28)', () => {
  it('27/28: "12014 ka fare aur CC availability dono batao" → GET_FARE + GET_AVAILABILITY in PARALLEL', async () => {
    const base = createHarness();
    const { harness } = apiHarness(base);
    const context = contextWithJourney();

    const fareBefore = base.countCapability('fare');
    const availBefore = base.countCapability('availability');

    const output = await runAiOrchestrator(
      { message: '12014 ka fare aur CC availability dono batao', conversationId: context.id, context },
      { ai: harness.deps.ai, registry: harness.toolRegistry },
    );
    expect(output.intent).toBe('MULTI_TOOL_QUERY');
    expect(output.requiredTools.sort()).toEqual(['GET_AVAILABILITY', 'GET_FARE']);
    expect(base.countCapability('fare')).toBe(fareBefore + 1); // exactly one fare call
    expect(base.countCapability('availability')).toBe(availBefore + 1); // exactly one availability call
    expect(output.response).toMatch(/Railway fare: ₹405\.00/);
    expect(output.response).toMatch(/AVAILABLE/i);
  });

  it('detectMultiToolRequest stays quiet for single-tool questions', () => {
    expect(detectMultiToolRequest('12014 ka live status batao', contextWithJourney())).toBeNull();
    expect(detectMultiToolRequest('CC kya hota hai?', contextWithJourney())).toBeNull();
  });

  it('MAX_TOOL_CALLS_PER_TURN is enforced (no infinite loops)', async () => {
    const harness = createHarness();
    const requests = Array.from({ length: 8 }, () => ({ tool: 'GET_TRAIN_INFO', args: { trainNumber: '12014' } }));
    const { executions, budgetExhausted } = await executeAiToolCalls(requests, {
      userId: 'user-1',
      conversationId: 'conv-1',
      registry: harness.toolRegistry,
    });
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(5);
    expect(budgetExhausted).toBe(true);
    const rejected = executions.filter((execution) => !execution.ok && execution.error === 'budget exhausted');
    expect(rejected).toHaveLength(3);
  });
});

describe('provider routing through the executor (§4 / §25: 29-31)', () => {
  it('29: RailCore success → RailKit NEVER called (no duplicate requests)', async () => {
    const harness = createHarness(); // RailCore succeeds by default
    const { executions } = await executeAiToolCalls([{ tool: 'GET_LIVE_STATUS', args: { trainNumber: '12014' } }], {
      userId: 'user-1', conversationId: 'c', registry: harness.toolRegistry,
    });
    expect(executions[0]?.ok).toBe(true);
    const railKitLiveCalls = harness.routerCalls.filter((call) => call.provider === 'RAILKIT' && call.capability === 'liveStatus');
    expect(railKitLiveCalls).toHaveLength(0);
  });

  it('30: RailCore failure → RailKit fallback inside ONE tool execution', async () => {
    const { providerFailure, providerSuccess } = await import('../shared/index.js');
    const { RailwayProviderRouter } = await import('../railway/index.js');
    const { createProductionToolRegistry } = await import('../tools/executors/index.js');
    const calls: string[] = [];
    const railCore = {
      providerId: 'RAILCORE', displayName: 'RailCore', capabilities: ['liveStatus'],
      supports: (capability: string) => capability === 'liveStatus',
      liveStatus: () => { calls.push('RAILCORE'); return Promise.resolve(providerFailure('HTTP_ERROR', '502', { httpStatus: 502, source: 'RAILCORE' })); },
    } as never;
    const railKit = {
      providerId: 'RAILKIT', displayName: 'RailKit', capabilities: ['liveStatus'],
      supports: (capability: string) => capability === 'liveStatus',
      liveStatus: () => { calls.push('RAILKIT'); return Promise.resolve(providerSuccess('RAILKIT', { trainNumber: '12014', journeyDate: '2026-08-27', status: 'RUNNING', delayMinutes: 5, nextStationCode: null, currentStation: null, lastUpdatedAt: null, upcomingStops: null })); },
    } as never;
    const router = new RailwayProviderRouter({ providers: [railCore, railKit] });
    const registry = createProductionToolRegistry({ router });

    const { executions } = await executeAiToolCalls([{ tool: 'GET_LIVE_STATUS', args: { trainNumber: '12014' } }], {
      userId: 'user-1', conversationId: 'c', registry,
    });
    expect(calls).toEqual(['RAILCORE', 'RAILKIT']); // fallback order, both inside ONE tool call
    expect(executions[0]?.ok).toBe(true); // RailKit answered
    expect(executions[0]?.result?.data).toMatchObject({ trainNumber: '12014' });
  });

  it('31: both providers fail → honest unavailable, no fabrication', async () => {
    const { providerFailure } = await import('../shared/index.js');
    const harness = createHarness({
      trainSearch: providerFailure('HTTP_ERROR', 'down', { httpStatus: 503, source: 'RAILCORE' }),
    });
    // RailKit also fails for trainSearch: script overrides default for BOTH.
    const { executions } = await executeAiToolCalls([{ tool: 'GET_TRAIN_INFO', args: { trainNumber: '12014' } }], {
      userId: 'user-1', conversationId: 'c', registry: harness.toolRegistry,
    });
    // trainInfo default succeeds; instead force both-fail on cancelled (RailKit-only → router unsupported? no — unsupported ≠ failure)
    // Use fare with both providers failing:
    const harness2 = createHarness({ fare: providerFailure('PROVIDER_FAILURE', 'success:false', { source: 'RAILKIT' }) });
    const result2 = await executeAiToolCalls([{ tool: 'GET_FARE', args: { trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', travelClass: 'CC' } }], {
      userId: 'user-1', conversationId: 'c', registry: harness2.toolRegistry,
    });
    void executions;
    const execution = result2.executions[0]!;
    expect(execution.ok).toBe(false);
    expect(execution.result?.error?.code).toBe('RAILWAY_DATA_UNAVAILABLE');
    expect(execution.result?.data).toBeNull();
  });
});

describe('32: invalid tool rejected by the executor', () => {
  it('unknown ids, PROHIBITED ids and flow-level ids all refuse', async () => {
    const harness = createHarness();
    const { executions } = await executeAiToolCalls(
      [
        { tool: 'fetchUrl', args: { url: 'https://evil' } },
        { tool: 'CONFIRM_BOOKING', args: { draftId: 'x' } },
        { tool: 'WALLET_DEBIT', args: { amount: 500 } },
        { tool: 'COMPARE_TRAINS', args: {} }, // flow-level: handled conversationally
      ],
      { userId: 'u', conversationId: 'c', registry: harness.toolRegistry },
    );
    expect(executions[0]?.ok).toBe(false);
    expect(executions[0]?.error).toMatch(/unknown tool/);
    expect(executions[1]?.result?.error?.message).toMatch(/PROHIBITED/);
    expect(executions[2]?.result?.error?.message).toMatch(/PROHIBITED/);
    expect(executions[3]?.error).toMatch(/flow-level/);
    expect(harness.routerCalls).toHaveLength(0); // nothing reached any provider
  });
});

describe('model provider abstraction (§20)', () => {
  it('deterministic by default; keyed nvidia → Step-9 gateway (GPT-OSS primary → Nemotron secondary); gemini unchanged', async () => {
    expect(createModelProvider({ provider: 'deterministic', model: null, apiKey: null, baseUrl: null }).deterministic).toBe(true);
    expect(createModelProvider({ provider: 'nvidia', model: null, apiKey: null, baseUrl: null }).deterministic).toBe(true); // no key → deterministic
    const nvidia = createModelProvider({ provider: 'nvidia', model: 'nvidia/nemotron-3-nano-30b-a3b', apiKey: 'k', baseUrl: null });
    expect(nvidia.deterministic).toBe(false);
    expect(nvidia.name).toBe('nvidia-gateway:openai/gpt-oss-20b→nvidia/nemotron-3-nano-30b-a3b'); // GPT-OSS PRIMARY, Nemotron secondary
    expect(nvidia.provider).toBeInstanceOf(AIGateway);
    const gemini = createModelProvider({ provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k', baseUrl: null });
    expect(gemini.provider.providerId).toBe('gemini');
  });
});

describe('conversational matrix items (§25: 2-6, 19-26, 37)', () => {
  it('2-5: missing date / today / tomorrow / day-after + 6: passenger count', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    expect(context.journeyDate).toBeNull(); // 2 missing date
    context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'aaj')).context;
    expect(context.journeyDate).toBe(isoPlusDays(0)); // 3 today
    context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    expect(context.journeyDate).toBe(isoPlusDays(1)); // 4 tomorrow
    context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'parso')).context;
    expect(context.journeyDate).toBe(isoPlusDays(2)); // 5 day after
    context = (await run(harness, context, 'pehli wali')).context;
    context = (await run(harness, context, 'CC')).context;
    context = (await run(harness, context, '2')).context;
    expect(context.passengerCount).toBe(2); // 6 passenger count
  });

  it('18-21: comparison + references (first/second/number, neeche wali = last)', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;

    const fastest = await run(harness, context, 'fastest kaunsi hai?'); // 18 fastest comparison
    expect(fastest.intent).toBe('COMPARE_TRAINS');
    expect(fastest.reply).toMatch(/12014/);

    expect((await run(harness, context, 'pehli wali')).context.selectedTrain?.number).toBe('12014'); // 19
    expect((await run(harness, context, 'doosri wali')).context.selectedTrain?.number).toBe('14542'); // 20
    expect((await run(harness, context, '12014 wali')).context.selectedTrain?.number).toBe('12014'); // 21
    expect((await run(harness, context, 'neeche wali')).context.selectedTrain?.number).toBe('14542'); // last result
  });

  it('22/23: booking interruption + resume (live status mid-booking)', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Delhi jaana hai')).context;
    // Delhi is ambiguous → choose New Delhi first
    context = (await run(harness, context, 'New Delhi')).context;
    const interrupt = await run(harness, context, '12014 ka live status batao');
    expect(interrupt.executedTools).toContain('getLiveStatus');
    expect(interrupt.context.pausedBooking).not.toBeNull(); // 22
    const resumed = await run(harness, interrupt.context, 'kal');
    expect(resumed.context.journeyDate).toBe(isoPlusDays(1)); // 23
    expect(resumed.context.lastSearchResults?.length ?? 0).toBeGreaterThan(0);
  });

  it('24/25/26: corrections (origin / destination / date)', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se New Delhi jaana hai')).context;
    context = (await run(harness, context, 'Nahi, Jalandhar se jaana hai')).context;
    expect(context.origin?.code).toBe('JRC');
    expect(context.destination?.code).toBe('NDLS'); // 24 destination preserved

    const harness2 = createHarness();
    let context2 = (await run(harness2, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context2 = (await run(harness2, context2, 'Ludhiana nahi Chandigarh')).context;
    expect(context2.origin?.code).toBe('ASR');
    expect(context2.destination?.code).toBe('CHD'); // 25

    const harness3 = createHarness();
    let context3 = (await run(harness3, freshContext(), 'ASR se LDH jaana hai')).context;
    context3 = (await run(harness3, context3, 'kal')).context;
    context3 = (await run(harness3, context3, 'pehli wali')).context;
    context3 = (await run(harness3, context3, 'CC')).context;
    context3 = (await run(harness3, context3, '2')).context;
    context3 = (await run(harness3, context3, 'Rahul')).context;
    const corrected = await run(harness3, context3, 'nahi actually kal nahi parso');
    expect(corrected.context.journeyDate).toBe(isoPlusDays(2)); // 26 date-only change
    expect(corrected.context.origin?.code).toBe('ASR');
    expect(corrected.context.destination?.code).toBe('LDH');
  });

  it('passenger count correction "2 nahi 3 passengers" changes ONLY the count', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, 'pehli wali')).context;
    context = (await run(harness, context, 'CC')).context;
    context = (await run(harness, context, '2')).context;
    context = (await run(harness, context, 'Rahul')).context;
    const corrected = await run(harness, context, '2 nahi 3 passengers');
    expect(corrected.context.passengerCount).toBe(3);
    expect(corrected.context.passengers).toHaveLength(0); // details invalidated for the new count
    expect(corrected.context.selectedTrain?.number).toBe('12014'); // train preserved
  });

  it('37: automatic booking prevented — "book kar do" mid-flow never books', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const attempt = await run(harness, context, 'book kar do');
    expect(attempt.executedTools).not.toContain('confirmBooking');
    expect(attempt.executedTools).not.toContain('executeMockBooking');
    expect(attempt.context.bookingStage).not.toBe('CONFIRMED');
  });

  it('draft tools stay data-only (CREATE_BOOKING_DRAFT executes; CONFIRM_BOOKING does not)', async () => {
    const harness = createHarness();
    const { executions } = await executeAiToolCalls([
      { tool: 'CREATE_BOOKING_DRAFT', args: { originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2026-08-27', trainNumber: '12014', travelClass: 'CC', passengerCount: 2 } },
    ], { userId: 'user-1', conversationId: 'conv-1', registry: harness.toolRegistry });
    const draftExecution = executions[0]!;
    expect(draftExecution.ok).toBe(true);
    const draft = draftExecution.result?.data as { status: string; fareQuote: unknown };
    expect(draft.status).toBe('AWAITING_CONFIRMATION'); // fare attached; still only a DRAFT
    expect(draftExecution.result?.tool).not.toBe('confirmBooking');
  });
});

void createInMemoryDraftStore;
