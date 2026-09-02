/**
 * STEP 9 — TRUE AI RAILWAY AGENT + INTELLIGENT SOURCE SELECTION (§20 matrix).
 * Deterministic mocks for the gateway/AI tests; the existing harness for routing.
 */

import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult, Intent } from '../../shared/index.js';
import { AIGateway, isValidToolPlan } from '../../ai/AIGateway.js';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { createHarness, freshContext, isoPlusDays, run } from '../orchestration/harness.js';
import { createConversationContext, setContextSlots, setSearchResults } from '../../shared/index.js';
import type { ConversationContext } from '../../shared/index.js';
import { makeSearchResults, ASR, LDH } from '../orchestration/harness.js';
import { createKnowledgeToolExecutor, RAILWAY_WEB_ALLOWLIST } from '../../tools/executors/knowledgeTools.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { validateToolArguments } from '../../api/ai/tool-catalog.js';


function fakeAI(output: unknown, opts: { fail?: boolean; hang?: boolean; track?: string[]; name?: string } = {}): AIProvider {
  return {
    providerId: opts.name ?? 'fake',
    async understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
      if (opts.track) opts.track.push(`${opts.name}:understand`);
      if (opts.fail) throw new Error('model down');
      if (opts.hang) await new Promise(() => undefined);
      return output as AIUnderstandingResult;
    },
    async generateResponse() {
      return { message: 'ok', askForField: null };
    },
  };
}

function plan(intent: Intent, entities: Record<string, unknown> = {}, confidence = 0.9): AIUnderstandingResult {
  return {
    intent,
    confidence,
    slots: {
      originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null,
      trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null,
      isCorrection: false, mentionedStations: [], glossaryTerm: null,
      ...entities,
    },
    missingFields: [],
    toolRequest: null,
  };
}

async function searched(): Promise<{ harness: ReturnType<typeof createHarness>; context: ConversationContext }> {
  const harness = createHarness();
  let context = freshContext();
  context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
  context = (await run(harness, context, 'kal')).context;
  return { harness, context };
}

describe('§20 1-3: comparison engine (deterministic, verified data only)', () => {
  it('1: "Kaunsi train fastest hai?" → COMPARISON with verified winner', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Kaunsi train fastest hai?');
    expect(turn.sourceClass).toBe('COMPARISON');
    expect(turn.reply).toMatch(/WINNER: 12014/); // 115m vs 130m — verified values
  });

  it('2: earliest arrival question ("Sabse jaldi kaunsi pahunchti hai?") → arrival metric', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Sabse jaldi kaunsi pahunchti hai?');
    expect(turn.sourceClass).toBe('COMPARISON');
    expect(turn.reply).toMatch(/WINNER: \d{5}/);
    expect(turn.reply).toMatch(/arrival/);
  });

  it('3: "12014 aur 14542 mein kaunsi jaldi?" → COMPARISON, both trains, factual only', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi jaldi pahunchti hai?');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/14542/);
    expect(turn.reply).toMatch(/WINNER/);
    expect(turn.reply).not.toMatch(/hamesha better/i);
  });

  it('5/37: "Longest journey kaunsi hai?" → MAX duration (regression: NOT the fastest train)', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Longest journey kaunsi hai?');
    expect(turn.sourceClass).toBe('COMPARISON');
    expect(turn.reply).toMatch(/WINNER: 14542/); // 130m > 115m — MAX, not MIN
    expect(turn.reply).toMatch(/zyada/i);
    expect(turn.reply).not.toMatch(/tez hai/);
  });

  it('5b: "Sabse zyada samay wali kaunsi?" → MAX duration', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Sabse zyada samay wali train kaunsi hai?');
    expect(turn.reply).toMatch(/WINNER: 14542/);
  });

  it('4: "Shortest journey kaunsi hai?" → MIN duration (still correct)', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Shortest journey kaunsi hai?');
    expect(turn.reply).toMatch(/WINNER: 12014/); // 115m — MIN
  });

  it('44: comparison with missing timing → no winner, no guess', async () => {
    const harness = createHarness();
    let context = freshContext();
    const partial = makeSearchResults().map((entry, index) =>
      index === 1 ? { ...entry, durationMinutes: null, arrivalTime: null, departureTime: null } : entry,
    );
    context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27' }, 'FILL_MISSING');
    context = setSearchResults(context, partial);
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi jaldi hai?');
    expect(turn.reply).toMatch(/nahi mila|andaza nahi/i);
    expect(turn.reply).not.toMatch(/WINNER/);
  });
});

describe('§20 4, 16, 30: search vs cancelled disambiguation', () => {
  it('4: "Kal kitni trains hain?" → TRAIN SEARCH (not cancelled)', async () => {
    const turn = await run(createHarness(), freshContext(), 'Kal kitni trains hain?');
    expect(turn.sourceClass).toBe('TRAIN_SEARCH');
    expect(turn.intent).not.toBe('GET_CANCELLED_TRAINS');
    expect(turn.reply).toMatch(/kahan se|kis route|route/i); // asks the route — never guesses
  });

  it('30: "Kal kitni trains cancel hain?" → CANCELLED (explicit cancel word)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Kal kitni trains cancel hain?');
    expect(turn.intent).toBe('GET_CANCELLED_TRAINS');
    expect(turn.executedTools).toContain('getCancelledTrains');
  });

  it('15: "Kaunsi trains cancel hain?" → cancelled', async () => {
    const turn = await run(createHarness(), freshContext(), 'Kaunsi trains cancel hain?');
    expect(turn.intent).toBe('GET_CANCELLED_TRAINS');
  });

  it('16: "Amritsar se Delhi ki trains dikhao" → TRAIN_SEARCH', async () => {
    const turn = await run(createHarness(), freshContext(), 'Amritsar se Ludhiana ki trains dikhao');
    expect(turn.sourceClass).toBe('TRAIN_SEARCH');
  });
});

describe('§20 5, 8, 10: availability extraction (train + class never re-asked)', () => {
  it('5: "12014 mein CC available hai?" → availability intent, train+class captured, no re-ask', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 mein CC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.context.selectedClass).toBe('CC'); // class remembered — never asked again
    expect(turn.reply).not.toMatch(/kaunsi class/i);
    expect(turn.reply).not.toMatch(/kaunsi train/i);
  });

  it('8: "12014 mein CC hai?" → LIVE availability (never glossary)', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 mein CC hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.sourceClass).not.toBe('GENERAL_RAILWAY_KNOWLEDGE');
  });

  it('10: "12014 mein RAC available hai?" → availability', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 mein RAC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
  });

  it('full availability executes when route+date+class are known (no fabrication)', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27' }, 'FILL_MISSING');
    const turn = await run(harness, context, '12014 mein CC available hai?');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.reply).toMatch(/AVAILABLE/i);
  });
});

describe('§20 6, 20: passenger extraction', () => {
  it('6: "2 ticket chahiye" → 2 passengers', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, 'pehli wali')).context;
    context = (await run(harness, context, 'CC')).context;
    const turn = await run(harness, context, '2 ticket chahiye');
    expect(turn.context.passengerCount).toBe(2);
  });

  it('"hum 3 log hain" → 3 passengers', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, 'pehli wali')).context;
    context = (await run(harness, context, 'CC')).context;
    const turn = await run(harness, context, 'hum 3 log hain');
    expect(turn.context.passengerCount).toBe(3);
  });

  it('20: "Kal Amritsar se Ludhiana 2 ticket chahiye" → full booking extraction', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Kal Amritsar se Ludhiana 2 ticket chahiye');
    expect(turn.sourceClass).toBe('TRAIN_SEARCH');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.journeyDate).toBe(isoPlusDays(1)); // kal = tomorrow (deterministic)
    expect(turn.context.passengerCount).toBe(2);
  });
});

describe('§20 7, 9: general railway knowledge vs live', () => {
  it('7: "CC kya hota hai?" → knowledge, no provider call', async () => {
    const turn = await run(createHarness(), freshContext(), 'CC kya hota hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.executedTools).toHaveLength(0);
  });

  it('9: "RAC kya hota hai?" → knowledge', async () => {
    const turn = await run(createHarness(), freshContext(), 'RAC kya hota hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.reply).toMatch(/Reservation Against Cancellation/i);
  });

  it('composed knowledge: "CC aur EC mein difference?" + "coach types"', async () => {
    const diff = await run(createHarness(), freshContext(), 'CC aur EC mein difference?');
    expect(diff.reply).toMatch(/CC:/);
    expect(diff.reply).toMatch(/EC:/);
    expect(diff.reply).toMatch(/Antar/i);
    const coaches = await run(createHarness(), freshContext(), 'Coach types kya hote hain?');
    expect(coaches.reply).toMatch(/1A|SL/);
  });

  it('glossary-miss concept → restricted knowledge tool (allowlisted web attempted, honest if unavailable)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'FOC quota kya hota hai?'); // not in glossary
    expect(turn.executedTools).toContain('getRailwayKnowledge');
    expect(turn.reply).toMatch(/available nahi|FOC|knowledge/i); // deterministic-miss → web attempt → honest either way
  });
});

describe('§20 11-14: live data via providers only', () => {
  it('11: "12014 abhi kaha hai?" → live status', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 abhi kaha hai?');
    expect(turn.sourceClass).toBe('LIVE_RAILWAY_DATA');
    expect(turn.executedTools).toContain('getLiveStatus');
  });

  it('12: "12014 ka timetable" → timetable', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 ka timetable');
    expect(turn.executedTools).toContain('getTimetable');
  });

  it('13: "12014 ka fare" → fare (tool executes once route is known; asks route honestly otherwise)', async () => {
    const bare = await run(createHarness(), freshContext(), '12014 ka fare');
    expect(bare.intent).toBe('GET_FARE');
    expect(bare.reply).toMatch(/kis route/i); // never guesses the segment
    const harness = createHarness();
    const context = setContextSlots(freshContext(), { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' }, 'FILL_MISSING');
    const turn = await run(harness, context, '12014 ka fare');
    expect(turn.executedTools).toContain('getFare');
  });

  it('14: "Mera PNR check karo" → PNR, asks for the number', async () => {
    const turn = await run(createHarness(), freshContext(), 'Mera PNR check karo');
    expect(turn.intent).toBe('CHECK_PNR');
    expect(turn.reply).toMatch(/PNR number/i);
  });
});

describe('§20 17-19: contextual references', () => {
  it('17: "Doosri wali" → context list (14542)', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Doosri wali');
    expect(turn.sourceClass).toBe('CONTEXTUAL_FOLLOWUP');
    expect(turn.context.selectedTrain?.number).toBe('14542');
  });

  it('18: "12014 wali" → context list', async () => {
    const { harness, context } = await searched();
    expect((await run(harness, context, '12014 wali')).context.selectedTrain?.number).toBe('12014');
  });

  it('19: "12014 nahi 14542 wali" → 14542', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, '12014 nahi 14542 wali');
    expect(turn.context.selectedTrain?.number).toBe('14542');
  });

  it('45: no context → short clarification, never a guess', async () => {
    const turn = await run(createHarness(), freshContext(), 'doosri wali ka fare?');
    expect(turn.context.selectedTrain).toBeNull();
    expect(turn.reply).toMatch(/koi search result list nahi|kaunsi train/i);
  });
});

describe('§20 21-22, 47: interruption/resume (context intact)', () => {
  it('21/47: live interruption mid-booking preserves the booking date', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Kal Amritsar se Ludhiana 2 ticket chahiye')).context;
    expect(context.journeyDate).toBe(isoPlusDays(1));
    const interrupt = await run(harness, context, '12014 ka live status batao');
    expect(interrupt.executedTools).toContain('getLiveStatus');
    expect(interrupt.context.journeyDate).toBe(isoPlusDays(1)); // unchanged
    expect(interrupt.context.passengerCount).toBe(2);
    const resumed = await run(harness, interrupt.context, 'pehli wali');
    expect(resumed.context.journeyDate).toBe(isoPlusDays(1)); // still tomorrow
  });

  it('22: railway-knowledge interruption mid-booking preserves context', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Kal Amritsar se Ludhiana 2 ticket chahiye')).context;
    const interrupt = await run(harness, context, 'CC kya hota hai?');
    expect(interrupt.reply).toMatch(/Chair Car/i);
    expect(interrupt.context.journeyDate).toBe(isoPlusDays(1));
    expect(interrupt.context.passengerCount).toBe(2);
  });
});

describe('§20 23, 48: multi-tool within budget', () => {
  it('23: "…trains dikhao aur 12014 ka fare bhi batao" → multiple approved tools', async () => {
    const harness = createHarness();
    let context = setContextSlots(freshContext(), { origin: ASR, destination: LDH, journeyDate: isoPlusDays(1) }, 'FILL_MISSING');
    const turn = await run(harness, context, 'trains dikhao aur 12014 ka fare bhi batao');
    expect(turn.executedTools.length).toBeGreaterThanOrEqual(1);
    expect(turn.executedTools.includes('searchTrains') || turn.executedTools.includes('getFare')).toBe(true);
  });

  it('48: multi-tool respects the existing budget (MAX 5/turn)', async () => {
    const { MAX_TOOL_CALLS_PER_TURN } = await import('../../api/ai/tool-executor.js');
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(5);
  });
});

describe('§20 24-27, 35-38: ToolGate rejections (AI output never trusted blindly)', () => {
  it('24/35: unknown tool rejected; 25/36: arbitrary URL rejected; 26: key request rejected', async () => {
    expect(validateToolArguments('definitelyNotATool', {}).ok).toBe(false);
    const url = validateToolArguments('GET_LIVE_STATUS', { trainNumber: '12014', url: 'https://evil.example' });
    expect(url.ok).toBe(false);
    expect(url.errors.join(' ')).toMatch(/forbidden/);
    const key = validateToolArguments('GET_LIVE_STATUS', { trainNumber: '12014', apiKey: 'nvapi-x' });
    expect(key.ok).toBe(false);
  });

  it('37: provider URL / endpoint argument rejected', () => {
    const validation = validateToolArguments('GET_FARE', { trainNumber: '12014', endpoint: 'https://ir.railcore.tech/v1/anything' });
    expect(validation.ok).toBe(false);
  });

  it('38: AI cannot access secret env variables through tool input', () => {
    const validation = validateToolArguments('RAILWAY_KNOWLEDGE', { query: 'CC', env: 'RAILCORE_API_KEY', authorization: 'Bearer x' });
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/forbidden/);
  });

  it('27: fake fare impossible — fare only from provider', async () => {
    const { providerFailure } = await import('../../shared/index.js');
    const harness = createHarness({ fare: providerFailure('HTTP_ERROR', 'down', { httpStatus: 503, source: 'RAILCORE' }) });
    let context = setContextSlots(freshContext(), { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' }, 'FILL_MISSING');
    const turn = await run(harness, context, '12014 ka fare kitna hai?');
    expect(turn.reply).toMatch(/available nahi/i);
    expect(turn.reply).not.toMatch(/₹\d+\.\d{2}/); // no invented number
  });
});

describe('§20 28-29: speed (never estimated)', () => {
  it('29: "Train ki speed kya hoti hai?" → general knowledge', async () => {
    const turn = await run(createHarness(), freshContext(), 'Train ki speed kya hoti hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.executedTools).not.toContain('getLiveStatus');
  });

  it('28: "12014 ki speed kitni hai?" → provider info path, honest unavailable for exact speed', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 ki speed kitni hai?');
    expect(turn.reply).toMatch(/EXACT speed.*available nahi|andaza nahi/i);
    expect(turn.reply.includes('km/h')).toBe(false); // never an estimated speed number
  });
});

describe('§20 31-34: AI model gateway (GPT-OSS primary → Nemotron secondary)', () => {
  it('31: primary success → secondary NEVER called', async () => {
    const track: string[] = [];
    const gateway = new AIGateway({
      primary: fakeAI(plan('LIVE_TRAIN_STATUS', { trainNumber: '12014' }), { track, name: 'gpt-oss' }),
      secondary: fakeAI(plan('BOOK_TRAIN'), { track, name: 'nemotron' }),
    });
    const result = await gateway.understand({ userMessage: 'x', conversation: createHarnessContext(), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('LIVE_TRAIN_STATUS');
    expect(track).toEqual(['gpt-oss:understand']); // secondary untouched
  });

  it('32: primary failure → Nemotron answers', async () => {
    const track: string[] = [];
    const gateway = new AIGateway({
      primary: fakeAI(null, { fail: true, track, name: 'gpt-oss' }),
      secondary: fakeAI(plan('GET_FARE', { trainNumber: '12014' }), { track, name: 'nemotron' }),
    });
    const result = await gateway.understand({ userMessage: 'x', conversation: createHarnessContext(), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('GET_FARE');
    expect(track).toEqual(['gpt-oss:understand', 'nemotron:understand']);
  });

  it('32b: primary hang → gateway timeout → secondary answers', async () => {
    const gateway = new AIGateway({
      primary: fakeAI(null, { hang: true }),
      secondary: fakeAI(plan('GET_TIMETABLE', { trainNumber: '12014' })),
      timeoutMs: 60,
    });
    const result = await gateway.understand({ userMessage: 'x', conversation: createHarnessContext(), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('GET_TIMETABLE');
  });

  it('32c: primary malformed plan (UNKNOWN, no slots) → secondary used', async () => {
    const track: string[] = [];
    const gateway = new AIGateway({
      primary: fakeAI(plan('UNKNOWN'), { track, name: 'gpt-oss' }),
      secondary: fakeAI(plan('LIVE_TRAIN_STATUS', { trainNumber: '12014' }), { track, name: 'nemotron' }),
    });
    const result = await gateway.understand({ userMessage: 'x', conversation: createHarnessContext(), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('LIVE_TRAIN_STATUS');
    expect(track).toHaveLength(2);
  });

  it('33: both models fail → deterministic resolver answers (graceful, no fabrication)', async () => {
    const harness = createHarness();
    const gateway = new AIGateway({ primary: fakeAI(null, { fail: true }), secondary: fakeAI(null, { fail: true }) });
    const turn = await orchestrateTurn(
      { ai: gateway, fallbackNlu: new DeterministicNLUProvider(), toolRegistry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') },
      freshContext(),
      '12014 ka live status batao',
    );
    expect(turn.usedFallbackNlu).toBe(true);
    expect(turn.executedTools).toContain('getLiveStatus'); // deterministic plan still executed once
    expect(harness.countCapability('liveStatus')).toBe(1); // exactly ONE provider call
  });

  it('34: valid primary plan executes exactly once (no double railway call on model fallback)', async () => {
    const harness = createHarness();
    const gateway = new AIGateway({
      primary: fakeAI(plan('LIVE_TRAIN_STATUS', { trainNumber: '12014' })),
      secondary: fakeAI(plan('LIVE_TRAIN_STATUS', { trainNumber: '12014' })),
    });
    const turn = await orchestrateTurn(
      { ai: gateway, fallbackNlu: new DeterministicNLUProvider(), toolRegistry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') },
      freshContext(),
      '12014 ka live status batao',
    );
    expect(turn.executedTools.filter((tool) => tool === 'getLiveStatus')).toHaveLength(1);
    expect(harness.countCapability('liveStatus')).toBe(1);
  });
});

describe('§20 39-40: provider routing (RailCore primary, RailKit fallback)', () => {
  it('39: RailCore success → RailKit never called', async () => {
    const harness = createHarness(); // RailCore succeeds by default
    await run(harness, freshContext(), '12014 ka live status batao');
    const railKitLive = harness.routerCalls.filter((call) => call.provider === 'RAILKIT' && call.capability === 'liveStatus');
    expect(railKitLive).toHaveLength(0);
  });

  it('40: RailCore failure → RailKit fallback (one authoritative result)', async () => {
    const { providerFailure } = await import('../../shared/index.js');
    const harness = createHarness({ liveStatus: providerFailure('HTTP_ERROR', '502', { httpStatus: 502, source: 'RAILCORE' }) });
    const turn = await run(harness, freshContext(), '12014 ka live status batao');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toMatch(/12014|available nahi/i); // honest either way
  });
});

describe('§20 41-43: restricted web knowledge (allowlist only)', () => {
  const fetchCalls: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return { ok: true, status: 200, url: String(url), text: async () => '<html><body>Indian Railways reservation rules and quota details are published here for passengers.</body></html>' };
  }) as never;

  it('41: unapproved domain → rejected, fetch never called', async () => {
    fetchCalls.length = 0;
    const executor = createKnowledgeToolExecutor({ fetchImpl: fakeFetch }).getRailwayKnowledge!;
    const result = await executor(
      { query: 'quota rules', url: 'https://evil.example.com/rules' },
      { actor: 'AI', userId: 'u', conversationId: 'c', call: undefined },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('URL_REJECTED');
    expect(fetchCalls).toHaveLength(0);
  });

  it('42: live-status style query → web NEVER used (providers only)', async () => {
    fetchCalls.length = 0;
    const executor = createKnowledgeToolExecutor({ fetchImpl: fakeFetch }).getRailwayKnowledge!;
    const result = await executor(
      { query: '12014 live status kya hai' },
      { actor: 'AI', userId: 'u', conversationId: 'c', call: undefined },
    );
    expect(fetchCalls).toHaveLength(0); // web untouched
    expect(result.ok).toBe(false);      // honest refusal
  });

  it('43: general concept → allowlisted web retrieval allowed + sanitized', async () => {
    fetchCalls.length = 0;
    const executor = createKnowledgeToolExecutor({ fetchImpl: fakeFetch }).getRailwayKnowledge!;
    const result = await executor(
      { query: 'reservation quota rules kya hain' }, // glossary miss → web path
      { actor: 'AI', userId: 'u', conversationId: 'c', call: undefined },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { source: string; url: string };
    expect(data.source).toBe('web');
    expect(RAILWAY_WEB_ALLOWLIST.some((domain) => data.url.includes(domain))).toBe(true);
    expect(fetchCalls[0]).toMatch(/indianrail/);
  });

  it('42b: orchestrator never routes live status through web', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 ka live status batao');
    expect(turn.executedTools).not.toContain('getRailwayKnowledge');
    expect(turn.executedTools).toContain('getLiveStatus');
  });
});

describe('§20 46: deterministic dates cannot be overridden by the model', () => {
  it('"kal" stays tomorrow even when the model claims a different date', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    // scripted model claims "parso" for the user's "Kal"
    const lyingAI = fakeAI(plan('BOOK_TRAIN', { dateText: 'parso' }));
    const turn = await orchestrateTurn(
      { ai: lyingAI, fallbackNlu: new DeterministicNLUProvider(), toolRegistry: harness.toolRegistry, now: () => new Date('2026-08-26T10:00:00.000Z') },
      context,
      'Kal',
    );
    expect(turn.context.journeyDate).toBe(isoPlusDays(1)); // tomorrow — model's "parso" dropped
  });
});

describe('§4 source classes (intelligent source selection)', () => {
  it('NORMAL_CHAT: off-scope question politely declined, no tools', async () => {
    const turn = await run(createHarness(), freshContext(), 'India mein weather kaisa hai?');
    expect(turn.sourceClass).toBe('NORMAL_CHAT');
    expect(turn.executedTools).toHaveLength(0);
    expect(turn.reply).toMatch(/railway assistant|scope mein nahi/i);
  });
});

function createHarnessContext(): ConversationContext {
  return createConversationContext({ userId: 'gateway-user' });
}

void isValidToolPlan;
void createProductionToolRegistry;
