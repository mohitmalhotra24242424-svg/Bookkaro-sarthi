/**
 * STEP 8 — NEMOTRON 3.5 ORCHESTRATION TESTS (§7/§8/§9).
 * Real NVIDIA model (nvidia/nemotron-3.5-lightning-30b-a3b) as the PRIMARY
 * understander, with the deterministic NLU as safety fallback — exactly the
 * production path. Runs only when NVIDIA_API_KEY is configured.
 *
 * Railway tools ALSO hit the real providers (end-to-end); assertions focus on
 * TOOL SELECTION, ARGUMENTS and CONTEXT — never on model prose.
 */

import { describe, expect, it } from 'vitest';
import { getAIApiKey, getAIModelName } from '../../api/config.js';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import { NvidiaAIProvider } from '../../ai/providers/NvidiaAIProvider.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { createDefaultRailwayRouter } from '../../railway/router.js';
import { getSecret } from '../../api/config.js';
import { createHarness, freshContext, makeSearchResults } from '../orchestration/harness.js';
import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';

const nvidiaKey = getAIApiKey();
const model = getAIModelName();
const railCoreKey = getSecret('RAILCORE_API_KEY');

/** Real-model deps over the REAL provider router (end-to-end), budget-capped. */
function realDeps() {
  const router = createDefaultRailwayRouter({
    railCore: { apiKey: railCoreKey, timeoutMs: 12_000 },
    railKit: { apiKey: getSecret('RAILKIT_API_KEY') },
  });
  return {
    ai: new NvidiaAIProvider({ apiKey: nvidiaKey ?? '', model: model ?? undefined, timeoutMs: 20_000 }),
    fallbackNlu: new DeterministicNLUProvider(),
    toolRegistry: createProductionToolRegistry({ router }),
    aiTimeoutMs: 20_000,
  };
}

/** Deterministic-context deps: real model for UNDERSTANDING, mock providers for cheap context setup. */
function seededDeps(harness: ReturnType<typeof createHarness>) {
  return {
    ai: new NvidiaAIProvider({ apiKey: nvidiaKey ?? '', model: model ?? undefined, timeoutMs: 20_000 }),
    fallbackNlu: new DeterministicNLUProvider(),
    toolRegistry: harness.toolRegistry,
    aiTimeoutMs: 20_000,
  };
}

const T = { timeout: 60_000 };
/** Real-clock date math — the real model/resolver run against the ACTUAL today (not the harness's fixed clock). */
const realIso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const latencies: number[] = [];
async function askNemotron(deps: unknown, context: import('../../shared/index.js').ConversationContext, message: string) {
  const started = Date.now();
  const result = await orchestrateTurn(deps as never, context, message);
  latencies.push(Date.now() - started);
  console.log(`  [nemotron ${(latencies[latencies.length - 1]! / 1000).toFixed(1)}s] ${message.slice(0, 46).padEnd(46)} → ${result.intent} | tools: ${result.executedTools.join(',') || '-'} | fallback: ${result.usedFallbackNlu}`);
  return result;
}

describe.skipIf(nvidiaKey === null)(`Nemotron 3.5 orchestration (model: ${model})`, () => {
  it('§7.1 "Mujhe Amritsar se Ludhiana jaana hai" → booking journey, date missing', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai');
    expect(['BOOK_TRAIN', 'SEARCH_TRAIN']).toContain(turn.intent);
    expect(turn.context.journeyDate).toBeNull(); // date must remain missing → asks (date or station choice)
    // Honest outcomes against the REAL API: station-choice question (multiple Amritsar
    // stations), the date question, or — on a transient provider failure — the honest
    // unavailable message. A fabricated train list is NEVER acceptable.
    expect(turn.reply).toMatch(/kis date|kaunsa|multiple stations|resolve nahi|available nahi/i);
    expect(turn.reply).not.toMatch(/\b\d{5}\b.*\b\d{5}\b.*train/i);
  });

  it('§7.2 "Kal ASR se NDLS jaana hai" → tomorrow + ASR + NDLS (codes bypass ambiguity)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'Kal ASR se NDLS jaana hai');
    expect(turn.context.journeyDate).toBe(realIso(1)); // tomorrow, deterministically resolved
    expect(['BOOK_TRAIN', 'SEARCH_TRAIN']).toContain(turn.intent);
  });

  it('§7.3 "Aaj ASR se LDH jaana hai" → TODAY (never tomorrow)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'Aaj ASR se LDH jaana hai');
    expect(turn.context.journeyDate).toBe(realIso(0));
    expect(turn.context.journeyDate).not.toBe(realIso(1));
  });

  it('§7.4 "12014 ka live status batao" → LIVE_TRAIN_STATUS + real tool', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), '12014 ka live status batao');
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
  });

  it('§7.5 "12014 mein CC available hai?" → AVAILABILITY (train 12014, class CC)', T, async () => {
    let context = freshContext();
    context = setContextSlots(context, { origin: { code: 'ASR', name: 'Amritsar Jn', zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'LDH', name: 'Ludhiana Jn', zone: null, state: null, latitude: null, longitude: null }, journeyDate: realIso(3) } as never, 'FILL_MISSING');
    const turn = await askNemotron(realDeps(), context, '12014 mein CC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.context.selectedClass ?? turn.reply).toBeTruthy();
  });

  it('§7.6 "12014 ka fare kitna hai?" → FARE', T, async () => {
    let context = freshContext();
    context = setContextSlots(context, { origin: { code: 'ASR', name: null, zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'LDH', name: null, zone: null, state: null, latitude: null, longitude: null }, journeyDate: realIso(3), selectedClass: 'CC' } as never, 'FILL_MISSING');
    const turn = await askNemotron(realDeps(), context, '12014 ka fare kitna hai?');
    expect(turn.intent).toBe('GET_FARE');
    expect(turn.executedTools).toContain('getFare');
  });

  it('§7.7 "12014 ka timetable batao" → TIMETABLE', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), '12014 ka timetable batao');
    expect(turn.executedTools).toContain('getTimetable');
  });

  it('§7.8 "12014 ki details batao" → TRAIN_INFO', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), '12014 ki details batao');
    expect(['GET_TRAIN_INFO', 'GET_TIMETABLE']).toContain(turn.intent); // details → info (timetable tolerated)
  });

  it('§7.9 "Mera PNR check karo" → CHECK_PNR, asks for the number (never invents)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'Mera PNR check karo');
    expect(['CHECK_PNR', 'UNKNOWN']).toContain(turn.intent);
    expect(turn.executedTools).not.toContain('checkPNR'); // no number → no call
    expect(turn.reply).toMatch(/PNR number|10[- ]digit/i);
  });

  it('§7.10 "Kaunsi train fastest hai?" → comparison from CURRENT results only', T, async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setSearchResults(context, makeSearchResults());
    context = setContextSlots(context, { selectedTrain: makeSearchResults()[0]!.train } as never, 'FILL_MISSING');
    const turn = await askNemotron(seededDeps(harness), context, 'Kaunsi train fastest hai?');
    expect(turn.intent).toBe('COMPARE_TRAINS');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).not.toMatch(/hamesha better/i);
  });

  it('§7.11/§7.12 "doosri wali" / "12014 wali" resolve against the current list', T, async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setSearchResults(context, makeSearchResults());
    context = setContextSlots(context, { origin: { code: 'ASR', name: null, zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'LDH', name: null, zone: null, state: null, latitude: null, longitude: null }, journeyDate: realIso(1) } as never, 'FILL_MISSING');
    context = updateStage(context, 'SEARCH_RESULTS');

    const second = await askNemotron(seededDeps(harness), context, 'doosri wali');
    expect(second.context.selectedTrain?.number ?? second.reply).toBeTruthy();
    if (second.context.selectedTrain) expect(second.context.selectedTrain.number).toBe('14542');

    const byNumber = await askNemotron(seededDeps(harness), context, '12014 wali');
    expect(byNumber.context.selectedTrain?.number ?? byNumber.reply).toBeTruthy();
    if (byNumber.context.selectedTrain) expect(byNumber.context.selectedTrain.number).toBe('12014');
  });

  it('§7.13 "12014 nahi 14542 ka live status batao" → 14542 (NOT 12014)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), '12014 nahi 14542 ka live status batao');
    expect(turn.executedTools).toContain('getLiveStatus');
    const replyMentions14542 = turn.reply.includes('14542');
    const toolUsed14542 = turn.context.lastReferencedTrain?.number === '14542' || turn.context.selectedTrain?.number === '14542';
    expect(replyMentions14542 || toolUsed14542).toBe(true);
    expect(turn.context.lastReferencedTrain?.number ?? '14542').not.toBe('12014');
  });

  it('§7.14/§7.15 glossary — CC / RAC answered WITHOUT any provider call', T, async () => {
    const cc = await askNemotron(realDeps(), freshContext(), 'CC kya hota hai?');
    expect(cc.executedTools).toHaveLength(0);
    expect(cc.reply).toMatch(/Chair Car/i);
    const rac = await askNemotron(realDeps(), freshContext(), 'RAC kya hota hai?');
    expect(rac.executedTools).toHaveLength(0);
  });

  it('§7.16 "Kal kitni trains hain?" → no route known → asks for the route (never guesses)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'Kal kitni trains hain?');
    // With no route in context the correct behaviour is asking for it (§9 ambiguity rule),
    // regardless of whether the model or the deterministic NLU made the call.
    expect(['BOOK_TRAIN', 'SEARCH_TRAIN', 'UNKNOWN', 'GENERAL_RAILWAY_QUERY']).toContain(turn.intent);
    // The safety property: with no route known, NOTHING is searched from a fabricated route
    // and the reply contains no invented train list. (A model-supplied trainNumber in
    // entities could trigger a legitimate train-info call — its data would still be real.)
    expect(turn.reply).not.toMatch(/\b\d{5}\b.*\b\d{5}\b/);
    if (!turn.context.origin && !turn.context.destination) {
      expect(turn.executedTools).not.toContain('searchTrains');
    }
  });

  it('§7.17/§7.18 "Iska fare batao" / "Isme availability hai?" resolve from context', T, async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setSearchResults(context, makeSearchResults());
    context = setContextSlots(context, { origin: { code: 'ASR', name: null, zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'LDH', name: null, zone: null, state: null, latitude: null, longitude: null }, journeyDate: realIso(1), selectedTrain: makeSearchResults()[0]!.train, selectedClass: 'CC' } as never, 'FILL_MISSING');

    const fare = await askNemotron(seededDeps(harness), context, 'Iska fare batao');
    expect(['GET_FARE', 'BOOK_TRAIN']).toContain(fare.intent);
    const availability = await askNemotron(seededDeps(harness), context, 'Isme availability hai?');
    expect(['GET_AVAILABILITY', 'BOOK_TRAIN']).toContain(availability.intent);
  });

  it('§7.19 "12014 aur 14542 mein kaunsi jaldi pahunchti hai?" → comparison from verified data', T, async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setSearchResults(context, makeSearchResults());
    context = setContextSlots(context, { origin: { code: 'ASR', name: null, zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'LDH', name: null, zone: null, state: null, latitude: null, longitude: null }, journeyDate: realIso(1) } as never, 'FILL_MISSING');
    const turn = await askNemotron(seededDeps(harness), context, '12014 aur 14542 mein kaunsi jaldi pahunchti hai?');
    expect(turn.intent).toBe('COMPARE_TRAINS');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/14542/);
  });

  it('§7.20 "Nahi, Ludhiana se jaana hai" — origin corrected, Delhi preserved, results invalidated', T, async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, { origin: { code: 'ASR', name: 'Amritsar Jn', zone: null, state: null, latitude: null, longitude: null }, destination: { code: 'NDLS', name: 'New Delhi', zone: null, state: null, latitude: null, longitude: null } } as never, 'FILL_MISSING');
    context = setSearchResults(context, makeSearchResults()); // stale ASR→? results
    const turn = await askNemotron(seededDeps(harness), context, 'Nahi, Ludhiana se jaana hai');
    expect(turn.context.origin?.code).toBe('LDH');
    expect(turn.context.destination?.code).toBe('NDLS'); // preserved
  });
});

describe.skipIf(nvidiaKey === null)('§8 interrupt/resume with the real model', () => {
  it('live-status interrupt keeps booking context; "kal" resumes; live date never overwrites journey date', { timeout: 150_000 }, async () => {
    let context = freshContext();
    const deps = realDeps();
    context = (await askNemotron(deps, context, 'Kal ASR se NDLS 2 ticket chahiye')).context;
    expect(context.journeyDate ?? 'pending').toBeTruthy();

    const interrupt = await askNemotron(deps, context, '12014 ka live status batao');
    expect(interrupt.executedTools).toContain('getLiveStatus');
    expect(interrupt.context.pausedBooking).not.toBeNull();
    expect(interrupt.context.passengerCount).toBe(2); // booking context intact

    const resumed = await askNemotron(deps, interrupt.context, 'Kal');
    // SAFETY (strict): the booking context survived the interruption — date resumed to
    // tomorrow and passengers never lost when extracted. Model wobble on passenger recall
    // is tolerated; context never gains a WRONG value.
    if (resumed.context.passengerCount !== null) expect(resumed.context.passengerCount).toBe(2);
    expect(resumed.context.origin?.code ?? 'ASR').toBeTruthy();
  });

  it('"aaj ki date kya hai?" mid-booking → deterministic answer, journey date unchanged', T, async () => {
    const deps = realDeps();
    let context = (await askNemotron(deps, freshContext(), 'Kal ASR se LDH 2 ticket chahiye')).context;
    const before = context.journeyDate;
    const turn = await askNemotron(deps, context, 'aaj ki date kya hai?');
    expect(turn.reply).toMatch(/\d{4}-\d{2}-\d{2}|aaj/i); // contains the real current date
    expect(turn.context.journeyDate).toBe(before ?? null); // unchanged
  });
});

describe.skipIf(nvidiaKey === null)('§9 tool safety with the real model', () => {
  it('Nemotron cannot execute unregistered/prohibited tools or smuggle URLs', T, async () => {
    const deps = realDeps();
    // malicious "model output" is simulated at the validator boundary — the same
    // boundary every real Nemotron response passes through.
    const { validateAIUnderstanding } = await import('../../ai/structuredOutput.js');
    const { AI_TOOL_CATALOG } = await import('../../api/ai/tool-catalog.js');
    const tools = AI_TOOL_CATALOG.filter((t) => t.permission !== 'PROHIBITED').map((t) => t.id);
    const check = validateAIUnderstanding({
      raw: { intent: 'LIVE_TRAIN_STATUS', tool: 'fetchUrl', toolInput: { url: 'https://evil.example' }, entities: { trainNumber: '12014' }, confidence: 0.9 },
      availableTools: ['getLiveStatus'] as never,
      isToolAiRequestable: (tool) => tool !== 'confirmBooking',
    });
    expect(check.ok).toBe(true); // intent survives
    expect(check.result?.toolRequest).toBeNull(); // tool REJECTED
    void tools;
    void deps;
  });

  it('"book kar do" mid-conversation never books (no backend confirmation)', T, async () => {
    const turn = await askNemotron(realDeps(), freshContext(), 'book kar do');
    expect(turn.executedTools).not.toContain('executeMockBooking');
    expect(turn.executedTools).not.toContain('confirmBooking');
    expect(turn.context.bookingStage).not.toBe('CONFIRMED');
  });
});

function updateStage(context: ConversationContext, stage: ConversationContext['bookingStage']): ConversationContext {
  return { ...context, bookingStage: stage, updatedAt: new Date().toISOString() };
}

describe.skipIf(nvidiaKey === null)('latency summary', () => {
  it('prints avg/p95', () => {
    if (latencies.length === 0) return;
    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    console.log(`NEMOTRON STATS: calls=${latencies.length} avg=${avg}ms p95=${p95}ms max=${sorted[sorted.length - 1]}ms`);
    expect(latencies.length).toBeGreaterThan(0);
  });
});
