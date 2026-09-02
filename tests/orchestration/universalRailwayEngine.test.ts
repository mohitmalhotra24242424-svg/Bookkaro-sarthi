/**
 * UNIVERSAL RAILWAY QUESTION ENGINE — FOCUSED INTELLIGENCE UPGRADE.
 *
 * 25 required regression tests. They prove the engine answers natural railway
 * questions like a railway expert WITHOUT the user knowing intent/tool/provider/
 * station-code internals — and that it NEVER estimates, invents, or leaks.
 *
 * Everything here is a MOCK test (scripted provider + deterministic NLU +
 * production tool registry). No network, no real credentials.
 */

import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult } from '../../shared/index.js';
import { setContextSlots, setSearchResults, addConversationMessage } from '../../shared/index.js';
import type { ConversationContext, Train, TrainSearchResult } from '../../shared/index.js';
import { createHarness, freshContext, isoPlusDays, run, makeSearchResults, ASR, LDH } from './harness.js';
import { compareTrainsDeterministic } from '../../ai/orchestrator.js';
import {
  detectComparisonRequest,
  filterByDayPart,
  dayPartOfHour,
  pickBestByMetric,
  durationDifferenceBetween,
  isBestAmbiguous,
  classifyUniversalQuerySource,
  clockToMinutes,
  extractSearchFilterHint,
  parseTimeWindow,
  applySearchFilter,
  reconcileSearchFilter,
  hasAnyTimeSignal,
} from '../../ai/query-intelligence.js';
import { validateToolArguments } from '../../api/ai/tool-catalog.js';
import { canonicalLookupQuery } from '../../ai/slotResolution.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { nluSystemPrompt, conversationTranscriptHint } from '../../ai/providers/NvidiaAIProvider.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function train(
  number: string,
  name: string,
  dep: string | null,
  arr: string | null,
  dur: number | null,
  classes: string[],
  origin: Train['originStation'] = ASR,
  destination: Train['destinationStation'] = LDH,
): TrainSearchResult {
  const t: Train = {
    number,
    name,
    originStation: origin,
    destinationStation: destination,
    departureTime: dep,
    arrivalTime: arr,
    runsOn: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    travelClasses: classes,
    pantryCar: null,
  };
  return { train: t, fromStation: origin, toStation: destination, departureTime: dep, arrivalTime: arr, durationMinutes: dur };
}

/** The 4-bucket fixture: one train per day-part, so filtering is observable. */
function dayPartResults(): TrainSearchResult[] {
  return [
    train('12014', 'Amritsar Shatabdi', '05:00', '06:55', 115, ['CC', 'EC']),
    train('14542', 'ASR LDH Express', '14:00', '17:00', 180, ['SL', '3A']),
    train('12626', 'Evening Express', '18:00', '21:00', 210, ['SL']),
    train('12627', 'Night Express', '22:00', '02:00', 240, ['SL']),
  ];
}

/** Two-turn default search → context with 2 results (12014, 14542). */
async function searched(): Promise<{ harness: ReturnType<typeof createHarness>; context: ConversationContext }> {
  const harness = createHarness();
  let context = freshContext();
  context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
  context = (await run(harness, context, 'Kal')).context;
  return { harness, context };
}

/** Scriptable AI provider returning raw untrusted JSON like a real model. */
class ScriptedAI implements AIProvider {
  readonly providerId = 'scripted-test-ai';
  constructor(private readonly rawUnderstand: unknown) {}
  async understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    return this.rawUnderstand as AIUnderstandingResult;
  }
  async generateResponse(): Promise<{ message: string; askForField: null }> {
    return { message: 'ok', askForField: null };
  }
}

function plan(intent: string, slots: Record<string, unknown>): AIUnderstandingResult {
  return {
    intent: intent as AIUnderstandingResult['intent'],
    confidence: 0.9,
    slots: {
      originQuery: null, destinationQuery: null, journeyDate: null, dateText: null,
      passengerCount: null, trainNumber: null, secondTrainNumber: null,
      travelClass: null, pnr: null, resultReference: null,
      isCorrection: false, mentionedStations: [], glossaryTerm: null,
      ...slots,
    },
    missingFields: [],
    toolRequest: null,
  };
}

// ── 1-2: station + search + duration; "kal" = tomorrow ──────────────────────

describe('universal engine: station+search+duration & tomorrow', () => {
  it('1: station+search returns VERIFIED duration for every result', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    expect(context.origin?.code).toBe('ASR');
    expect(context.destination?.code).toBe('LDH');
    const results = context.lastSearchResults ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.durationMinutes !== null)).toBe(true);
    expect(results[0]!.durationMinutes).toBeGreaterThan(0);
  });

  it('2: "Kal" resolves deterministically to tomorrow (never the model date)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Kal Amritsar se Ludhiana jaana hai');
    expect(turn.context.journeyDate).toBe(isoPlusDays(1));
  });
});

// ── 3: morning (time-of-day) filtering ───────────────────────────────────────

describe('universal engine: intelligent time-of-day filtering', () => {
  it('3: "kuber subah" query filters the verified list to morning trains only', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const turn = await run(harness, freshContext(), 'Kal Amritsar se Ludhiana subah jaana hai');
    const reply = turn.reply.toLowerCase();
    // The assistant visibly acknowledges its understanding of the filter…
    expect(reply).toMatch(/samajh gaya/);
    expect(reply).toMatch(/subah/);
    expect(reply).toMatch(/12014/); // morning bucket contains Shatabdi (05:00)
    // …and the acknowledgment lists ONLY morning departures — never the night express.
    const ack = turn.reply.match(/samajh gaya[\s\S]*?dikha raha hoon\./i)?.[0] ?? turn.reply;
    expect(ack).toContain('12014');
    expect(ack).not.toContain('12627');
  });

  it('deterministic day-part classification is pure and correct', () => {
    const results = dayPartResults();
    const morning = filterByDayPart(results, 'morning');
    expect(morning.map((entry) => entry.train.number)).toEqual(['12014']);
    expect(filterByDayPart(results, 'night').map((entry) => entry.train.number)).toEqual(['12627']);
    expect(filterByDayPart(results, 'afternoon').map((entry) => entry.train.number)).toEqual(['14542']);
    expect(detectComparisonRequest('sabse tez kaunsi hai')).not.toBeNull();
    expect(detectComparisonRequest('longest journey kaunsi hai')?.direction).toBe('max');
    expect(detectComparisonRequest('sabse pehle nikalti hai')?.metric).toBe('departure');
  });

  it('after-midnight (00:00–04:59) is MORNING/early-morning, NOT night — a 4:55am train is not a "raat" train', () => {
    // Regression: 'raat ki trains' must not swallow early-morning (post-midnight)
    // departures. Night = 21:00–23:59; 00:00–11:59 = morning.
    expect(dayPartOfHour(4)).toBe('morning'); // 04:00 → early-morning
    expect(dayPartOfHour(5)).toBe('morning');
    expect(dayPartOfHour(12)).toBe('afternoon');
    expect(dayPartOfHour(19)).toBe('evening');
    expect(dayPartOfHour(21)).toBe('night');
    expect(dayPartOfHour(23)).toBe('night');

    // The Shatabdi-shaped train departs 04:55 / arrives ~06:57 → a morning train.
    const earlyMorning = train('12014', 'Amritsar Shatabdi', '04:55', '06:57', 122, ['CC', 'EC']);
    expect(filterByDayPart([earlyMorning], 'morning').map((e) => e.train.number)).toEqual(['12014']);
    expect(filterByDayPart([earlyMorning], 'night')).toEqual([]);

    const nightTrain = train('14734', 'Night Express', '23:30', '05:00', 330, ['SL']);
    expect(filterByDayPart([nightTrain], 'night').map((e) => e.train.number)).toEqual(['14734']);
    expect(filterByDayPart([nightTrain], 'morning')).toEqual([]);
  });
});

// ── 4-7: earliest/longest/comparison ─────────────────────────────────────────

describe('universal engine: earliest / longest / two-train comparison', () => {
  it('4: earliest arrival → arrival-min winner (12014, 06:55)', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Sabse jaldi kaunsi pahunchti hai?');
    expect(turn.reply).toMatch(/WINNER: 12014/);
    expect(turn.reply).toMatch(/arrival/i);
  });

  it('5: earliest departure → departure-min winner', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'earliest departure wali kaunsi hai?');
    expect(turn.reply).toMatch(/WINNER: 12014/);
  });

  it('6: longest journey → MAX duration winner (14542, NOT the fastest train)', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Longest journey kaunsi hai?');
    expect(turn.reply).toMatch(/WINNER: 14542/);
    expect(turn.reply).toMatch(/zyada/i);
    expect(turn.reply).not.toMatch(/tez hai/);
  });

  it('7: compare two explicit trains on provided duration only', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi jaldi hai?');
    expect(turn.intent).toBe('COMPARE_TRAINS');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/14542/);
    expect(turn.reply).toMatch(/WINNER/);
  });

  it('universal comparison engine returns the {winner, metric, verifiedValue, comparedTrains, source} shape', () => {
    const [a, b] = makeSearchResults();
    const result = compareTrainsDeterministic([a, b], a, b, 'duration', 'min');
    expect(result.source).toBe('deterministic');
    expect(result.winner).toBe('12014');
    expect(result.metric).toBe('duration');
    expect(result.verifiedValue).toBe('115');
    expect(result.comparedTrains).toEqual(['12014', '14542']);
  });

  it('pickBestByMetric refuses to pick when a candidate lacks the winner field (no estimate)', () => {
    const [a, b] = makeSearchResults();
    const withoutDuration = [{ ...b, durationMinutes: null, arrivalTime: null, departureTime: null }];
    const request = detectComparisonRequest('sabse tez kaunsi hai')!;
    expect(pickBestByMetric([a, ...withoutDuration], request)).toBeNull();
  });
});

// ── 8: duration difference ("doosri wali fastest se kitni slow") ─────────────

describe('universal engine: duration difference', () => {
  it('8/17: "doosri wali fastest se kitni slow hai?" → deterministic 15-minute difference', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'doosri wali fastest se kitni slow hai?');
    expect(turn.reply).toMatch(/14542/);
    expect(turn.reply).toMatch(/15 minute/);
    expect(turn.reply).toMatch(/dheere|slower/i);
    expect(turn.context.selectedTrain).toBeNull(); // informational, never a booking pick
  });

  it('durationDifferenceBetween is pure and correct', () => {
    const [a, b] = makeSearchResults();
    const diff = durationDifferenceBetween(a, b)!;
    expect(diff.minutes).toBe(15);
    expect(diff.aNumber).toBe('12014');
    expect(diff.bNumber).toBe('14542');
    expect(diff.bLonger).toBe(true);
    expect(durationDifferenceBetween(a, a)).toBeNull(); // same train → no diff
  });
});

// ── 9: "best" with no criteria asks a clarification ─────────────────────────

describe('universal engine: ambiguous "best"', () => {
  it('9: "kaunsi best hai?" with no criteria → short clarification, never a guessed winner', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'kaunsi best hai?');
    expect(turn.reply).toMatch(/kis criteria|kis.*best|best chahiye/i);
  });

  it('isBestAmbiguous detects the not-actionable case, and the explicit-basis case', () => {
    expect(isBestAmbiguous('kaunsi best hai', false)).toBe(true);
    expect(isBestAmbiguous('sabse tez wali best hai', false)).toBe(false);
  });
});

// ── 10-13: knowledge vs live availability distinction ───────────────────────

describe('universal engine: knowledge vs live (RAC/CC)', () => {
  it('10: "CC kya hota hai?" → GENERAL knowledge, no provider call', async () => {
    const turn = await run(createHarness(), freshContext(), 'CC kya hota hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.executedTools).toHaveLength(0);
  });

  it('11: "12014 mein CC available hai?" → LIVE availability, never glossary', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 mein CC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.sourceClass).not.toBe('GENERAL_RAILWAY_KNOWLEDGE');
  });

  it('12: "RAC kya hota hai?" → knowledge (Reservation Against Cancellation)', async () => {
    const turn = await run(createHarness(), freshContext(), 'RAC kya hota hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.reply).toMatch(/Reservation Against Cancellation/i);
  });

  it('13: "12014 mein RAC available hai?" → LIVE availability query (never glossary)', async () => {
    const harness = createHarness();
    const context = setContextSlots(
      freshContext(),
      { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' },
      'FILL_MISSING',
    );
    const turn = await run(harness, context, '12014 mein RAC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.sourceClass).not.toBe('GENERAL_RAILWAY_KNOWLEDGE');
  });
});

// ── 14-15: exact-speed honesty vs speed knowledge ────────────────────────────

describe('universal engine: speed honesty', () => {
  it('14: "12014 ki speed kitni hai?" → exact speed honestly unavailable, no invented km/h', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 ki speed kitni hai?');
    expect(turn.reply).toMatch(/EXACT speed.*available nahi|andaza nahi/i);
    expect(turn.reply).not.toMatch(/\d+\s*km\/h/i);
  });

  it('15: "Train ki speed kya hoti hai?" → general knowledge, no live provider', async () => {
    const turn = await run(createHarness(), freshContext(), 'Train ki speed kya hoti hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.executedTools).not.toContain('getLiveStatus');
  });
});

// ── 16: search-then-fastest follow-up ────────────────────────────────────────

describe('universal engine: search-then-fastest follow-up', () => {
  it('16: after a search, "kaunsi train sabse tez hai?" returns the verified winner', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'kaunsi train sabse tez hai?');
    expect(turn.sourceClass).toBe('COMPARISON');
    expect(turn.reply).toMatch(/WINNER: 12014/);
  });
});

// ── 18: multi-capability decomposition (within budget) ───────────────────────

describe('universal engine: multi-capability planning', () => {
  it('18: journey + live status decomposes into multiple approved capabilities, no arbitrary HTTP', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Kal Amritsar se Ludhiana jaana hai aur 12014 ka live status batao');
    expect(turn.sourceClass).toBe('MULTI_CAPABILITY_QUERY');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.executedTools).toContain('searchTrains');
    // never an arbitrary web/fetch capability
    expect(turn.executedTools).not.toContain('fetchUrl');
  });
});

// ── 19: provider-missing-duration → no winner, no estimate ───────────────────

describe('universal engine: missing duration never estimated', () => {
  it('19: fastest ask with one train lacking duration → honest unavailable, no winner', async () => {
    const harness = createHarness({}, { searchResults: [
      train('12014', 'Amritsar Shatabdi', '05:00', '06:55', 115, ['CC']),
      train('14542', 'ASR LDH Express', '08:10', '10:20', null, ['SL']),
    ] });
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi jaldi hai?');
    expect(turn.reply).toMatch(/nahi mila|andaza nahi/i);
    expect(turn.reply).not.toMatch(/WINNER/);
  });

  it('bad time strings are never treated as numeric', () => {
    expect(clockToMinutes('garbage')).toBeNull();
    expect(clockToMinutes('05:00')).toBe(300);
  });
});

// ── 20-22: ToolGate rejections (never trusts AI blindly) ─────────────────────

describe('universal engine: ToolGate / safety rejections', () => {
  it('20: AI requests an unregistered tool → rejected + recorded; only whitelisted tool runs', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      '12014 ka live status batao',
      {
        ai: new ScriptedAI({
          intent: 'LIVE_TRAIN_STATUS',
          confidence: 0.9,
          tool: 'fetchUrl',
          toolInput: { url: 'https://evil.example/x' },
          entities: { trainNumber: '12014' },
        }),
      },
    );
    expect(turn.safetyRejections.join(' ')).toMatch(/unregistered tool "fetchUrl"/);
    expect(turn.executedTools).toEqual(['getLiveStatus']);
    expect(turn.reply).not.toContain('https://evil.example/x');
  });

  it('21: a URL/endpoint argument is rejected by the catalog validator', () => {
    const url = validateToolArguments('GET_LIVE_STATUS', { trainNumber: '12014', url: 'https://evil.example' });
    expect(url.ok).toBe(false);
    const endpoint = validateToolArguments('GET_FARE', { trainNumber: '12014', endpoint: 'https://ir.railcore.tech/v1/anything' });
    expect(endpoint.ok).toBe(false);
  });

  it('22: the AI can never select a provider / pass a secret env through a tool', () => {
    const provider = validateToolArguments('GET_LIVE_STATUS', { trainNumber: '12014', provider: 'RAILKIT' });
    expect(provider.ok).toBe(false);
    const env = validateToolArguments('RAILWAY_KNOWLEDGE', { query: 'CC', env: 'RAILCORE_API_KEY', authorization: 'Bearer x' });
    expect(env.ok).toBe(false);
  });
});

// ── 23-24: context preserved across informational/general interruptions ──────

describe('universal engine: context preserved across interruptions', () => {
  it('23: live-status info mid-booking preserves the booking date + passenger count', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Kal Amritsar se Ludhiana 2 ticket chahiye')).context;
    expect(context.journeyDate).toBe(isoPlusDays(1));
    const interrupt = await run(harness, context, '12014 ka live status batao');
    expect(interrupt.executedTools).toContain('getLiveStatus');
    expect(interrupt.context.journeyDate).toBe(isoPlusDays(1));
    expect(interrupt.context.passengerCount).toBe(2);
  });

  it('24: general-knowledge question mid-booking preserves the booking context', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Kal Amritsar se Ludhiana 2 ticket chahiye')).context;
    const interrupt = await run(harness, context, 'CC kya hota hai?');
    expect(interrupt.reply).toMatch(/Chair Car/i);
    expect(interrupt.context.journeyDate).toBe(isoPlusDays(1));
    expect(interrupt.context.passengerCount).toBe(2);
  });
});

// ── 25: normal chat → zero railway calls ─────────────────────────────────────

describe('universal engine: normal chat does zero railway work', () => {
  it('25: off-scope small talk → NORMAL_CHAT, no railway tool calls', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'India mein weather kaisa hai?');
    expect(turn.sourceClass).toBe('NORMAL_CHAT');
    expect(turn.executedTools).toHaveLength(0);
    expect(harness.routerCalls.filter((call) => call.capability !== 'stationLookup')).toHaveLength(0);
  });
});

// ── universal classifier (8 source classes) ──────────────────────────────────

describe('universal engine: the 8-class universal query classifier', () => {
  it('classifies the canonical 8 source classes deterministically', () => {
    expect(classifyUniversalQuerySource({ intent: 'LIVE_TRAIN_STATUS' })).toBe('LIVE_RAILWAY_DATA');
    expect(classifyUniversalQuerySource({ intent: 'BOOK_TRAIN' })).toBe('TRAIN_SEARCH');
    expect(classifyUniversalQuerySource({ intent: 'COMPARE_TRAINS' })).toBe('TRAIN_COMPARISON');
    expect(classifyUniversalQuerySource({ intent: 'GENERAL_RAILWAY_QUERY' })).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(classifyUniversalQuerySource({ intent: 'NORMAL_CHAT' })).toBe('NORMAL_CHAT');
  });

  it('a turn exercising more than one approved capability is MULTI_CAPABILITY_QUERY', () => {
    const cls = classifyUniversalQuerySource({
      intent: 'LIVE_TRAIN_STATUS',
      executedTools: ['getLiveStatus', 'getFare'],
    });
    expect(cls).toBe('MULTI_CAPABILITY_QUERY');
  });

  it('a short contextual follow-up is CONTEXTUAL_RAILWAY_QUERY', () => {
    const cls = classifyUniversalQuerySource({
      intent: 'GET_AVAILABILITY',
      executedTools: ['getAvailability'],
      wasFollowUp: true,
      message: 'usme CC available hai?',
    });
    expect(cls).toBe('CONTEXTUAL_RAILWAY_QUERY');
  });
});

// ── natural-language gaps the user hit in production (regression) ───────────

describe('universal engine: natural phrasing that previously returned "samajh nahi aaya"', () => {
  it('arrival-time: "12014 kitne baje pahunchi thi new delhi" → GET_TIMETABLE (scheduled arrival)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 kitne baje pahunchi thi new delhi');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.executedTools).toContain('getTimetable');
    expect(turn.reply).toMatch(/baje|timetable|pahunch/i);
    expect(turn.reply).not.toMatch(/samajh nahi paaya/i);
  });

  it('arrival-time at destination: "12014 kitne baje apni destination par pahunch thi" → GET_TIMETABLE', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 kitne baje apni destination par pahunch thi');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.executedTools).toContain('getTimetable');
    expect(turn.reply).not.toMatch(/samajh nahi paaya/i);
  });

  it('recurring arrival: "12014 kitne baje pahunchti hai" → GET_TIMETABLE', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 kitne baje pahunchti hai');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.executedTools).toContain('getTimetable');
  });

  it('possessive journey: "Tum ludhiana ki kal ki morning trains btao" → BOOK_TRAIN, asks origin, never dead-ends', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Tum ludhiana ki kal ki morning trains btao');
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.sourceClass).toBe('TRAIN_SEARCH');
    // The engine treats the sole station as the destination and asks for origin —
    // never "samajh nahi paaya".
    expect(turn.reply).toMatch(/kahan se|origin|boarding|se jaana/i);
    expect(turn.reply).not.toMatch(/samajh nahi paaya/i);
  });

  it('arrival-time reply is built from verified timetable data only (no fake clock)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 kitne baje pahunchi thi');
    // The mock timetable has a real LDh arrival (06:49); the reply must cite it.
    expect(turn.reply).toMatch(/06:49|baje/i);
    expect(turn.reply).not.toMatch(/samajh nahi paaya/i);
  });

  it('AI-first: even when the model labels an arrival-time query GET_TRAIN_INFO, the keyword guard remaps to GET_TIMETABLE', async () => {
    const harness = createHarness();
    // The model mislabels the question as GET_TRAIN_INFO (a known imperfection
    // of the live LLM). The orchestrator must correct it to the timetable.
    const turn = await run(harness, freshContext(), '12014 kitne baje new delhi pahunchti hai?', {
      ai: new ScriptedAI(plan('GET_TRAIN_INFO', { trainNumber: '12014' })),
    });
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.executedTools).toContain('getTimetable');
    expect(turn.reply).toMatch(/baje|pahunch/i);
  });
});

// ── natural-language time-filter gaps the user hit in production (regression) ─
// Fixes the Live complaint: "maine to sirf morning ki trains mangi thi — poore
// list kyu bheji?" The user asked for morning / "4am se 6am" trains but got all
// N trains. Root cause: the time-of-day filter was read only from the CURRENT
// message, but the search runs a few turns later (after station/date
// disambiguation), so "morning" was dropped and the full list was shown.
describe('universal engine: time-of-day filter is applied & persists across turns', () => {
  it('time-window parsing: "4am se 6am" → 04:00–06:00 (window wins over the day-part word)', () => {
    const window = parseTimeWindow('sirf 4am se 6am ke beech chahiye');
    expect(window).not.toBeNull();
    expect(window!.fromMin).toBe(4 * 60);
    expect(window!.toMin).toBe(6 * 60);
    const hint = extractSearchFilterHint('morning 4am se 6am ke beech');
    expect(hint?.kind).toBe('timeWindow');
    expect(hint?.fromMin).toBe(240);
    expect(hint?.toMin).toBe(360);
  });

  it('applySearchFilter narrows a verified list to an explicit clock window', () => {
    const filtered = applySearchFilter(dayPartResults(), { source: 'x', kind: 'timeWindow', fromMin: 4 * 60, toMin: 6 * 60 });
    expect(filtered.map((entry) => entry.train.number)).toEqual(['12014']); // only the 05:00 departure
  });

  it('same-turn morning search shows ONLY morning trains (cards + count), never the whole list', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const turn = await run(harness, freshContext(), 'Kal Amritsar se Ludhiana ke liye subah ki trains chahiye');
    const cards = turn.cards ?? [];
    // Only the 05:00 morning train survives; night/afternoon/evening are dropped.
    expect(cards.map((card) => card.number).sort()).toEqual(['12014']);
    expect(turn.context.lastSearchResults?.length).toBe(1);
    expect(turn.reply).not.toMatch(/1262[67]/);
  });

  it('persisted hint: "morning" survives a deferred search (date next turn) and filters the cards', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    let context = freshContext();
    const t1 = await run(harness, context, 'Amritsar se Ludhiana ke liye morning ki trains chahiye');
    // The filter is captured on context even though the search hasn't run yet.
    expect(t1.context.pendingSearchFilter?.dayPart).toBe('morning');
    expect(t1.reply).toMatch(/date|kal|kis date/i);
    context = t1.context;
    const t2 = await run(harness, context, 'Kal');
    // Deferred search now applies the persisted filter → only the morning train.
    expect((t2.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(t2.reply).toMatch(/subah|morning|05:00/i);
    expect(t2.reply).not.toMatch(/12627/);
  });

  it('refinement over an already-shown list narrows it WITHOUT re-searching or re-asking stations', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    const before = context.lastSearchResults?.length ?? 0;
    expect(before).toBe(4); // full list is on screen
    const turn = await run(harness, context, 'Par mujhe to sirf morning 4am se 6am ke beech chahiye');
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(turn.executedTools).toHaveLength(0); // no new provider search
    expect(turn.context.origin?.code).toBe('ASR'); // station context preserved, not re-asked
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.reply).toMatch(/04:00|subah|morning/i);
  });

  it('time-window refinement does not create a new journey when the NLU mis-reads "sirf" as a station', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    // The deterministic NLU reads "sirf" as a destination token; the refinement
    // must still fire (the time-filter is the dominant signal), not re-search.
    const turn = await run(harness, context, 'sirf subah wali chahiye');
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(turn.executedTools).toHaveLength(0);
  });

  it('reconciled filter lets the AI reading win ONLY when the user used time language (no invented filter)', () => {
    // deterministic read exists → it is authoritative
    expect(reconcileSearchFilter('morning 4am se 6am', { source: 'x', kind: 'dayPart', dayPart: 'morning' })?.kind).toBe('timeWindow');
    // AI-only hint, with a time signal the regex missed → accepted (AI genuinely understood)
    expect(reconcileSearchFilter('7:30 ke baad wali', { source: 'x', kind: 'timeWindow', fromMin: 450, toMin: 1440 })).not.toBeNull();
    // AI-only hint, but the user named NO time → rejected (AI must not invent a filter)
    expect(reconcileSearchFilter('Amritsar se Ludhiana jaana hai', { source: 'x', kind: 'dayPart', dayPart: 'morning' })).toBeNull();
    expect(hasAnyTimeSignal('Amritsar se Ludhiana jaana hai')).toBe(false);
  });

  it('the visible acknowledgment "Samajh gaya …" is shown when a filter is applied', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    const turn = await run(harness, context, 'sirf subah (morning) wali chahiye');
    expect(turn.reply).toMatch(/samajh gaya/i);
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
  });

  it('"amritsar jn se ldh jn" keeps the junction suffix glued to the station (no "jn"-garbage lookup)', async () => {
    const det = new DeterministicNLUProvider();
    const ctx = freshContext();
    const r = await det.understand({ userMessage: 'Mujhe morning trains chahiye amritsar jn se ldh jn ke liye kal ke liye', conversation: ctx, availableIntents: [], availableTools: [] });
    expect(r.slots.originQuery).toBe('amritsar jn');
    expect(r.slots.destinationQuery).toBe('ldh jn');
    expect(r.slots.mentionedStations).not.toContain('liye');
    expect(r.slots.mentionedStations).not.toContain('jn');
    expect(r.searchFilter?.dayPart).toBe('morning');
    // junction suffix is stripped for the provider lookup, never a bare "jn"
    expect(canonicalLookupQuery('amritsar jn')).toBe('amritsar');
    expect(canonicalLookupQuery('ldh jn')).toBe('ldh');
    expect(canonicalLookupQuery('new delhi jn')).toBe('new delhi');
  });

  it('a model that mis-picks the junction suffix "jn" as a station is corrected to the deterministic read', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const ai: AIProvider = {
      providerId: 'custom',
      async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
        // The model mis-reads the destination as the bare suffix "jn".
        return {
          intent: 'BOOK_TRAIN',
          confidence: 0.9,
          slots: { originQuery: 'amritsar jn', destinationQuery: 'jn', journeyDate: null, dateText: 'kal', passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
          missingFields: [],
          toolRequest: null,
          searchFilter: { source: input.userMessage, kind: 'dayPart', dayPart: 'morning' },
        };
      },
      async generateResponse() {
        return { message: '', askForField: null };
      },
    };
    const turn = await run(harness, freshContext(), 'Mujhe morning trains chahiye amritsar jn se ldh jn ke liye kal ke liye', { ai });
    // The bad bare "jn" is replaced by the deterministic "ldh jn" → LDH; the
    // search runs and only the morning train is shown (no "JN"-garbage list).
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.context.origin?.code).toBe('ASR');
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
  });

  it('full journey "amritsar jn se ldh jn" resolves codes and applies the morning filter to the cards', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const turn = await run(harness, freshContext(), 'Mujhe morning trains chahiye amritsar jn se ldh jn ke liye kal ke liye');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    // Only the morning train shows — the "jn" suffix no longer yields a garbage list.
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(turn.reply).toMatch(/samajh gaya/i);
  });

  it('natural Hinglish "… amritsar se ludhiana jn morning ki train kal" is understood (no chahiye/jaana)', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const turn = await run(harness, freshContext(), 'amritsar se ludhiana jn morning ki train kal');
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    // Only the morning trains — the user's everyday phrasing is honoured.
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(turn.reply).toMatch(/samajh gaya/i);
  });

  it('"ldh jn" resolves directly to LDH even when the provider returns fuzzy extra candidates', async () => {
    const stations: typeof ASR[] = [
      ASR, LDH,
      { code: 'GUH', name: 'Guldhar', zone: null, state: 'UP', latitude: null, longitude: null },
      { code: 'KLD', name: 'Kaldhari', zone: null, state: 'PB', latitude: null, longitude: null },
    ];
    const harness = createHarness({}, { searchResults: dayPartResults(), stations });
    const turn = await run(harness, freshContext(), 'kal amritsar jn se ldh jn morning');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    // Resolved directly — no station-choice prompt was left pending, no ambiguity.
    expect(turn.context.stationChoices).toBeNull();
    expect(turn.context.pendingStationResolution).toBeNull();
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
  });

  it('a real AI that reads a time phrase into searchFilter is honoured (no re-search), spoken window', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const ai: AIProvider = {
      providerId: 'custom',
      async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
        return {
          intent: 'BOOK_TRAIN',
          confidence: 0.9,
          slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
          missingFields: [],
          toolRequest: null,
          searchFilter: { source: input.userMessage, kind: 'timeWindow', fromMin: 450, toMin: 1440 }, // "7:30 ke baad"
        };
      },
      async generateResponse() {
        return { message: '', askForField: null };
      },
    };
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'Kal')).context;
    const turn = await run(harness, context, '7:30 ke baad wali', { ai });
    // The AI's structured reading is honoured — 05:00 (12014) falls outside, so only
    // the later trains remain, without a fresh provider search.
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['14542', '12626', '12627']);
    expect(turn.executedTools).toHaveLength(0);
    expect(turn.reply).toMatch(/samajh gaya/i);
  });
});

describe('multilingual natural language: Hinglish / English / Hindi (Devanagari)', () => {
  it('English "I need trains from Amritsar to Ludhiana tomorrow morning" → BOOK_TRAIN, morning only', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    const turn = await run(harness, freshContext(), 'I need trains from Amritsar to Ludhiana tomorrow morning');
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.context.journeyDate).not.toBeNull();
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
    expect(turn.reply).toMatch(/samajh gaya/i);
  });

  it('Hindi (Devanagari) "…अमृतसर से लुधियाना कल सुबह की ट्रेन चाहिए" → BOOK_TRAIN, morning only', async () => {
    // Devanagari station names resolve against a provider index that lists them as-written.
    const devStations = [
      { code: 'ASR', name: 'अमृतसर जं', zone: null, state: 'PB', latitude: null, longitude: null },
      { code: 'LDH', name: 'लुधियाना जं', zone: null, state: 'PB', latitude: null, longitude: null },
    ];
    const harness = createHarness({}, { searchResults: dayPartResults(), stations: devStations });
    const turn = await run(harness, freshContext(), 'मुझे अमृतसर से लुधियाना कल सुबह की ट्रेन चाहिए');
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    expect((turn.cards ?? []).map((card) => card.number)).toEqual(['12014']);
  });

  it('Hindi (Devanagari) still routes live-status / PNR / off-scope chat intents', async () => {
    const harness = createHarness();
    const live = await run(harness, freshContext(), '12014 का लाइव स्टेटस बताओ');
    expect(live.intent).toBe('LIVE_TRAIN_STATUS');
    const pnr = await run(harness, freshContext(), 'मेरा पीएनआर चेक करो');
    expect(pnr.intent).toBe('CHECK_PNR');
    const weather = await run(harness, freshContext(), 'दिल्ली का मौसम कैसा है');
    expect(weather.intent).toBe('NORMAL_CHAT');
  });

  it('English still routes live-status and PNR intents', async () => {
    const harness = createHarness();
    const live = await run(harness, freshContext(), 'What is the live status of train 12014');
    expect(live.intent).toBe('LIVE_TRAIN_STATUS');
    const pnr = await run(harness, freshContext(), 'Check my PNR status');
    expect(pnr.intent).toBe('CHECK_PNR');
  });
});

describe('AI role + day-part clock contract (AI interprets, deterministic enforces)', () => {
  const prompt = nluSystemPrompt(['BOOK_TRAIN', 'LIVE_TRAIN_STATUS']);

  it('prompt states the AI role: primary autonomous agent that decides the tool/API, server executes + verifies', () => {
    expect(prompt).toMatch(/understand/i);
    expect(prompt).toMatch(/primary autonomous agent/i);
    expect(prompt).toMatch(/decide which railway tool/i);
    expect(prompt).toMatch(/deterministic SERVER engine/i);
    expect(prompt).toMatch(/you request it/i);
    expect(prompt).toMatch(/AVAILABLE TOOLS/i);
    expect(prompt).toMatch(/YOU ARE NOT A RAILWAY DATABASE/i);
    expect(prompt).toMatch(/no special cases/i);
    expect(prompt).toMatch(/passing a city/i);
  });

  it('prompt states the authoritative day-part boundaries + the midnight rule (12 ke baad = morning, not night)', () => {
    expect(prompt).toMatch(/morning = 00:00–11:59/i);
    expect(prompt).toMatch(/night = 21:00–23:59/i);
    expect(prompt).toMatch(/4:55 AM train is a MORNING train/i);
    expect(prompt).toMatch(/12 baje ke baad/i);
    expect(prompt).toMatch(/never night/i);
  });

  it('deterministic engine agrees with the advertised clock (0–4 h = morning; 21–23 h = night)', () => {
    for (let h = 0; h <= 4; h += 1) expect(dayPartOfHour(h)).toBe('morning');
    expect(dayPartOfHour(5)).toBe('morning');
    expect(dayPartOfHour(12)).toBe('afternoon');
    expect(dayPartOfHour(21)).toBe('night');
    expect(dayPartOfHour(23)).toBe('night');
  });
});

describe('AI TOOL AGENT (primary autonomous): the model requests a tool/API and the server executes + renders it', () => {
  it('LIVE_TRAIN_STATUS: model requests getLiveStatus → executed, verified reply', async () => {
    const harness = createHarness();
    const ai: AIProvider = {
      providerId: 'custom-model',
      async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
        return {
          intent: 'LIVE_TRAIN_STATUS',
          confidence: 0.95,
          slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: '12014', secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
          missingFields: [],
          toolRequest: { tool: 'getLiveStatus', input: { trainNumber: '12014' }, rationale: 'user wants live status' },
          searchFilter: null,
        };
      },
      async generateResponse() {
        return { message: '', askForField: null };
      },
    };
    const turn = await run(harness, freshContext(), '12014 ka live status batao', { ai });
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toMatch(/12014/i);
    expect(turn.usedFallbackNlu).toBe(false);
  });

  it('GET_FARE: model requests getFare with casual keys (from/to) → normalized + rendered', async () => {
    const harness = createHarness();
    const ai: AIProvider = {
      providerId: 'custom-model',
      async understand(): Promise<AIUnderstandingResult> {
        return {
          intent: 'GET_FARE',
          confidence: 0.95,
          slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: '12014', secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
          missingFields: [],
          toolRequest: { tool: 'getFare', input: { trainNumber: '12014', from: 'ASR', to: 'LDH' }, rationale: 'fare between ASR-LDH on 12014' },
          searchFilter: null,
        };
      },
      async generateResponse() {
        return { message: '', askForField: null };
      },
    };
    const turn = await run(harness, freshContext(), 'Amritsar se Ludhiana ke liye fare?', { ai });
    expect(turn.executedTools).toContain('getFare');
    expect(turn.reply).toMatch(/₹|fare|405/i);
  });

  it('a protected tool (confirmBooking) is never executed via the AI path', async () => {
    const harness = createHarness();
    const ai: AIProvider = {
      providerId: 'custom-model',
      async understand(): Promise<AIUnderstandingResult> {
        return {
          intent: 'BOOK_TRAIN',
          confidence: 0.95,
          slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
          missingFields: [],
          toolRequest: { tool: 'confirmBooking', input: {}, rationale: 'book now' },
          searchFilter: null,
        };
      },
      async generateResponse() {
        return { message: '', askForField: null };
      },
    };
    const turn = await run(harness, freshContext(), 'book karo', { ai });
    // confirmBooking is NOT ai-requestable → the whole request is rejected, and no
    // booking tool is ever executed. The turn must NOT execute confirmBooking.
    expect(turn.executedTools).not.toContain('confirmBooking');
  });
});

describe('CONVERSATION MEMORY: the AI sees recent context so follow-ups are not treated as a new chat', () => {
  it('conversationTranscriptHint returns the recent user↔assistant tail, bounded and without the current turn', () => {
    let ctx = freshContext();
    // build a 4-turn history: prior user q, assistant reply, current user q
    ctx = setContextSlots(ctx, {}, 'FILL_MISSING', '2026-08-26T10:00:00.000Z');
    ctx = addConversationMessage(ctx, { role: 'user', content: '12014 ka fare kitna hai', intent: 'GET_FARE', toolName: 'getFare' }, '2026-08-26T10:00:00.000Z');
    ctx = addConversationMessage(ctx, { role: 'assistant', content: '12014 ka fare ₹405 hai', intent: 'GET_FARE', toolName: null }, '2026-08-26T10:00:05.000Z');
    ctx = addConversationMessage(ctx, { role: 'user', content: 'uska fare badha do 3A me', intent: 'GET_FARE', toolName: 'getFare' }, '2026-08-26T10:00:10.000Z');

    const hint = conversationTranscriptHint(ctx, 'uska fare badha do 3A me');
    expect(hint).toContain('Recent conversation');
    expect(hint).toContain('12014 ka fare kitna hai'); // prior user turn included
    expect(hint).toContain('12014 ka fare ₹405 hai'); // prior assistant reply included
    // the current (live) message must NOT be double-sent
    expect(hint).not.toContain('uska fare badha do 3A me');
  });

  it('conversationTranscriptHint stays empty on a fresh conversation (no prior turns)', () => {
    const hint = conversationTranscriptHint(freshContext(), 'hello');
    expect(hint).toBe('');
  });

  it('a real follow-up about the earlier train reuses the resolved context (no re-asking station)', async () => {
    const harness = createHarness({}, { searchResults: dayPartResults() });
    // 1) start a journey explicitly → origin/destination resolve + morning filter
    let context = freshContext();
    context = (await run(harness, context, 'amritsar se ludhiana kal subah ki train')).context;
    context = (await run(harness, context, 'ASR')).context;
    context = (await run(harness, context, 'LDH')).context;
    // 2) a short follow-up about the very same route must NOT re-ask the stations.
    const turn = await run(harness, context, 'subah wali hi chahiye');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.reply).toMatch(/subah|samajh/i);
  });
});

void setSearchResults; void LDH; void ASR;
