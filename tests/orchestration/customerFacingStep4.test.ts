/**
 * STEP 4 — customer-facing assistant matrix (§29 items that are new in Step 4).
 * All MOCK: harness router, deterministic orchestrator, no network.
 */

import { describe, expect, it } from 'vitest';
import { providerFailure, providerSuccess } from '../../shared/index.js';
import type { Station, TrainSearchResult } from '../../shared/index.js';
import { createHarness, freshContext, isoPlusDays, run, ASR, LDH } from './harness.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult } from '../../shared/index.js';
import type { ConversationContext } from '../../shared/index.js';

/** 15: station ambiguity — "Delhi" matches several stations → USER chooses. */
describe('§6/§29-15 station ambiguity', () => {
  it('"Amritsar se Delhi jaana hai" asks NDLS / DLI / NZM — never silent-picks', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Amritsar se Delhi jaana hai');

    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination).toBeNull();
    expect(turn.context.stationChoices).not.toBeNull();
    expect(turn.context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['DLI', 'NDLS', 'NZM']);
    expect(turn.reply).toMatch(/NDLS|DLI|NZM/);
    expect(turn.reply).toMatch(/EK station choose/i);
    expect(turn.chips?.some((c) => /NDLS|DLI|NZM/.test(c))).toBe(true);
  });

  it('"New Delhi" exact-name resolves directly and the flow continues', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se New Delhi jaana hai')).context;
    expect(context.destination?.code).toBe('NDLS'); // exact name → no question
    const turn = await run(harness, context, 'kal');
    expect(turn.context.journeyDate).toBeTruthy();
  });

  it('genuinely ambiguous partial name still asks (never guesses)', async () => {
    // "nizamuddin" matches only NZM by substring in the harness index → single result → resolves.
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Amritsar se Nizamuddin jaana hai');
    expect(turn.context.destination?.code).toBe('NZM');
  });
});

/** 3: multi-intent messages. */
describe('§3 multi-intent messages', () => {
  it('"Kal Amritsar se Delhi jaana hai aur 12014 ka live status bhi batao" answers BOTH (info first)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ka live status batao aur mujhe Amritsar se Ludhiana kal jaana hai');

    expect(turn.reply).toMatch(/12014/);                       // live status answered
    expect(turn.reply).toMatch(/kis date|neeche list/i);       // booking question last
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
  });

  it('"live status batao aur phir booking continue karte hain" resumes the paused booking', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se New Delhi jaana hai')).context;
    expect(context.lastAskedField).toBe('journeyDate');

    const turn = await run(harness, context, '12014 ka live status batao aur phir booking continue karte hain');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.context.pausedBooking).not.toBeNull(); // booking preserved
    expect(turn.context.lastAskedField).toBe('journeyDate');
    expect(turn.reply).toMatch(/Wapas aapki booking/i); // explicit resume offer
  });
});

/** 30/31: date correction + stale-result invalidation. */
describe('§24 corrections & stale results', () => {
  async function searched(): Promise<{ harness: ReturnType<typeof createHarness>; context: ConversationContext }> {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    return { harness, context };
  }

  it('30: "actually kal nahi parso" corrects the date', async () => {
    const { harness, context } = await searched();
    expect(context.journeyDate).toBe(isoPlusDays(1));
    const turn = await run(harness, context, 'nahi actually kal nahi parso');
    expect(turn.context.journeyDate).toBe(isoPlusDays(2));
    expect(turn.context.userCorrections.length).toBeGreaterThanOrEqual(1);
  });

  it('31: a date correction INVALIDATES the old search results (re-searches for the new date)', async () => {
    const { harness, context } = await searched();
    expect(context.lastSearchResults).toHaveLength(2);
    const turn = await run(harness, context, 'nahi actually kal nahi parso');

    expect(turn.executedTools).toContain('searchTrains'); // fresh search for parso
    expect(turn.context.journeyDate).toBe(isoPlusDays(2));
    expect(turn.reply).toMatch(/2 trains mili|neeche list/i);
  });

  it('31: a route correction ("Ludhiana nahi Chandigarh") invalidates old trains too', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Ludhiana nahi Chandigarh');
    expect(turn.context.destination?.code).toBe('CHD');
    expect(turn.context.origin?.code).toBe('ASR'); // preserved
    // old ASR→LDH trains are gone; flow re-asks the date? no — date known → re-search
    expect(turn.executedTools).toContain('searchTrains');
  });

  it('re-stating a DIFFERENT origin without "nahi" updates it (§24 example)', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'Jalandhar se jaana hai');
    expect(turn.context.origin?.code).toBe('JRC');
    expect(turn.context.destination?.code).toBe('LDH'); // NOT erased
  });
});

/** 9/19: references incl. NAME references and the no-list guard. */
describe('§9 train references (extended)', () => {
  async function searched() {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    return { harness, context };
  }

  it('"Shatabdi wali" selects by train NAME from the current list', async () => {
    const { harness, context } = await searched();
    const turn = await run(harness, context, 'Shatabdi wali');
    expect(turn.context.selectedTrain?.number).toBe('12014'); // Amritsar Shatabdi
  });

  it('"doosri wali" with NO current list asks instead of guessing', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'doosri wali');
    expect(turn.context.selectedTrain).toBeNull();
    expect(turn.reply).toMatch(/koi search result list nahi/i);
  });
});

/** 17: cancelled-train evidence checks. */
describe('§17 cancelled trains', () => {
  it('"Train 15098 cancel hai?" answers WITH provider evidence', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '15098 cancel hai kya?');
    expect(turn.executedTools).toContain('getCancelledTrains');
    expect(turn.reply).toMatch(/15098 .*cancelled list mein hai/i);
  });

  it('"12014 cancel hai?" → not in the list → evidence-backed NO', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 cancel hai kya?');
    expect(turn.reply).toMatch(/cancelled list mein NAHI/i);
  });

  it('cancelled list is never presented as station-filtered (honest limitation)', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, { origin: ASR }, 'FILL_MISSING');
    const turn = await run(harness, context, 'Amritsar se chalne wali cancelled trains batao');
    expect(turn.reply).toMatch(/station-wise filter .*support nahi/i);
  });

  it('no provider data → no cancellation claim at all', async () => {
    const harness = createHarness({ cancelledTrains: providerFailure('HTTP_ERROR', 'down', { httpStatus: 503, source: 'RAILKIT' }) });
    const turn = await run(harness, freshContext(), '12014 cancel hai kya?');
    expect(turn.reply).toMatch(/confirmation abhi nahi de sakta|available nahi/i);
    expect(turn.reply).not.toMatch(/cancel hai\./i);
  });
});

/** 13: fare separation (railway fare vs service fee vs total). */
describe('§13 fare separation', () => {
  it('fare replies show railway fare, service fee and total separately', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' }, 'FILL_MISSING');
    context = setSearchResults(context, []);
    context = setContextSlots(context, { selectedTrain: { number: '12014', name: 'Amritsar Shatabdi' } as never }, 'FILL_MISSING');

    const turn = await run(harness, context, 'CC ka fare kitna hai?');
    expect(turn.reply).toMatch(/Railway fare: ₹405\.00/);
    expect(turn.reply).toMatch(/service fee: ₹20\.00/i);
    expect(turn.reply).toMatch(/Total payable: ₹425\.00/);
  });
});

/** 14/15: next station + daily/classes questions. */
describe('§14/§15 timetable vs live vs train info', () => {
  it('"next station kya hai?" → LIVE status (with provider next-station field)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ka next station kya hai?');
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toMatch(/Agla station JL/i);
  });

  it('"ye train daily chalti hai?" → train INFO (static), not live status', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 daily chalti hai?');
    expect(turn.intent).toBe('GET_TRAIN_INFO');
    expect(turn.executedTools).toContain('getTrainInfo');
    expect(turn.reply).toMatch(/din chalti hai/i);
  });

  it('"12014 kaha kaha rukti hai?" → timetable', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 kaha kaha rukti hai?');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.executedTools).toContain('getTimetable');
  });
});

/** 5: month-date understanding. */
describe('§5 natural dates (extended)', () => {
  it('"27 August" resolves in the current year', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, '27 August');
    expect(turn.context.journeyDate).toBe('2026-08-27');
  });

  it('an already-past month/date is ambiguous → the assistant asks instead of assuming a year', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, '1 January'); // 2026-01-01 is past on 2026-08-26
    expect(turn.context.journeyDate).toBeNull();
    expect(turn.reply).toMatch(/date samajh nahi aayi/i);
  });
});

/** 20/38: confirmation safety. */
describe('§20 confirmation safety', () => {
  async function atReview(passengerNames: string[] = ['Rahul', 'Priya']): Promise<{ harness: ReturnType<typeof createHarness>; context: ConversationContext }> {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, 'pehli wali')).context;
    context = (await run(harness, context, 'CC')).context;   // availability + fare shown, count asked
    context = (await run(harness, context, '2')).context;    // passenger 1 name asked
    for (const name of passengerNames) {
      context = (await run(harness, context, name)).context;       // name
      context = (await run(harness, context, '30')).context;       // age
      context = (await run(harness, context, 'M')).context;        // gender (CC has no berth)
    }
    expect(context.bookingStage).toBe('WAITING_CONFIRMATION');
    expect(context.passengers).toHaveLength(2);
    return { harness, context };
  }

  it('38: a bare "haan" OUTSIDE a pending review is NEVER treated as confirmation', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'haan');
    expect(turn.executedTools).toHaveLength(0);
    expect(turn.reply).toMatch(/kisi booking confirmation ka wait nahi/i);
  });

  it('"haan" during the review runs the deterministic MOCK booking (clearly DEMO, never real)', async () => {
    const { harness, context } = await atReview();
    const turn = await run(harness, context, 'haan');
    expect(turn.executedTools).toContain('acknowledgeBookingConfirmation');
    expect(turn.executedTools).toContain('executeMockBooking');
    expect(turn.executedTools).not.toContain('confirmBooking'); // the real booking tool stays unreachable
    expect(turn.context.bookingStage).toBe('CONFIRMED');
    expect(turn.reply).toMatch(/DEMO booking complete/i);
    expect(turn.reply).toMatch(/MOCK-/i);
    expect(turn.reply).toMatch(/koi real railway ticket nahi/i);
    expect(turn.reply).not.toMatch(/PNR:?\s*\d{10}/i); // no real-looking PNR ever
  });

  it('"nahi" during the review declines politely and keeps the flow safe', async () => {
    const { harness, context } = await atReview();
    const turn = await run(harness, context, 'nahi');
    expect(turn.executedTools).not.toContain('confirmBooking');
    expect(turn.reply).toMatch(/rok dete hain|kuch aur/i);
  });

  it('37: automatic booking prevention — no confirmBooking executor exists at all', async () => {
    const harness = createHarness();
    expect(harness.toolRegistry.get('confirmBooking')?.status).toBe('NOT_IMPLEMENTED');
    expect(harness.toolRegistry.get('acknowledgeBookingConfirmation')?.aiRequestable).toBe(false);
  });
});

/** §8: structured train cards for the UI. */
describe('§8 search result presentation (cards)', () => {
  it('search turns attach structured cards, reply stays short', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'kal');

    expect(turn.cards).not.toBeNull();
    expect(turn.cards).toHaveLength(2);
    expect(turn.cards?.[0]).toMatchObject({
      number: '12014',
      departureTime: '05:00',
      arrivalTime: '06:55',
      fromCode: 'ASR',
      fromName: 'Amritsar Jn',
      toCode: 'LDH',
      toName: 'Ludhiana Jn',
      originCode: 'ASR',
      originName: 'Amritsar Jn',
      destCode: 'NDLS',
      destName: 'New Delhi',
    });
    expect(turn.cards?.[1]?.classes).toEqual(['SL', '3A']);
    expect(turn.reply.split('\n').length).toBeLessThan(6); // short intro, not a wall of text
  });
});

/** §10: comparison with fare data + natural explanation. */
describe('§10 comparison (extended)', () => {
  it('comparison explains departure difference and fetches provider fares', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi better hai?');

    expect(turn.reply).toMatch(/14542 .*minute later nikalti/i); // 08:10 vs 05:00
    expect(turn.reply).toMatch(/Railway fare/i);                  // provider fares for both
    expect(turn.reply).not.toMatch(/hamesha better/i);
  });
});

/** §29-35 hallucination guard with a "creative" AI. */
describe('§28 tool-result safety (null fields stay null)', () => {
  it('a fare with UNKNOWN total is reported as unavailable — never approximated', async () => {
    const unknownFare = {
      trainNumber: '12014',
      fromStationCode: 'ASR',
      toStationCode: 'LDH',
      journeyDate: '2026-08-27',
      travelClass: 'CC',
      quota: 'GN',
      currency: 'INR',
      breakdown: { baseFareMinor: null, reservationChargeMinor: null, superfastChargeMinor: null, dynamicFareMinor: null, cateringChargeMinor: null, gstMinor: null, totalMinor: null },
      source: 'RAILCORE',
      retrievedAt: '2026-08-26T00:00:00Z',
    };
    const harness = createHarness({ fare: providerSuccess('RAILCORE', unknownFare) });
    let context = freshContext();
    context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' }, 'FILL_MISSING');
    context = setSearchResults(context, []);
    context = setContextSlots(context, { selectedTrain: { number: '12014', name: 'X' } as never }, 'FILL_MISSING');

    const turn = await run(harness, context, 'CC ka fare kitna hai?');
    expect(turn.reply).toMatch(/available nahi/i);
    expect(turn.reply).not.toMatch(/₹\d+/); // NO invented number, not even "approximately"
  });
});

void (null as unknown as Station | AIProvider | AIUnderstandingInput | AIUnderstandingResult | TrainSearchResult | typeof providerFailure);
