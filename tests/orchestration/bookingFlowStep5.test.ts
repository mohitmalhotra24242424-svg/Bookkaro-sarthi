/**
 * STEP 5 — conversational booking journey (36-case matrix, §25). All MOCK.
 */

import { describe, expect, it } from 'vitest';
import { RailwayProviderRouter } from '../../railway/index.js';
import type { RailwayProvider } from '../../railway/index.js';
import { providerSuccess } from '../../shared/index.js';
import type { ConversationContext, ProviderId, RailwayCapability, Station, TrainSearchResult } from '../../shared/index.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { createInMemoryDraftStore } from '../../tools/executors/index.js';
import { createMockWalletService } from '../../wallet/index.js';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { createHarness, freshContext, isoPlusDays, run, ASR, LDH } from './harness.js';
import type { HarnessRouterScript } from './harness.js';

// ── low-balance harness for the insufficient-wallet case ──
function lowBalanceHarness(): ReturnType<typeof createHarness> {
  const base = createHarness();
  const registry = createProductionToolRegistry({
    router: lowBalanceRouter(),
    draftStore: createInMemoryDraftStore(),
    walletService: createMockWalletService({ seedBalanceMinor: 10_000 }), // ₹100 — fare ₹425 needed
  });
  return { ...base, toolRegistry: registry, deps: { ...base.deps, toolRegistry: registry } };
}

function lowBalanceSearchResults(): TrainSearchResult[] {
  return [
    {
      train: { number: '12014', name: 'Amritsar Shatabdi', originStation: ASR, destinationStation: LDH, departureTime: '05:00', arrivalTime: '06:55', runsOn: ['MON'], travelClasses: ['CC', 'EC'], pantryCar: null },
      fromStation: ASR, toStation: LDH, departureTime: '05:00', arrivalTime: '06:55', durationMinutes: 115,
    },
  ];
}

function lowBalanceRouter(): RailwayProviderRouter {
  const make = (id: ProviderId, caps: RailwayCapability[]): RailwayProvider =>
    ({
      providerId: id,
      displayName: `${id}-fake`,
      capabilities: caps,
      supports: (c: RailwayCapability) => caps.includes(c),
      stationLookup: () => Promise.resolve(providerSuccess('RAILCORE', [ASR, LDH] as Station[])),
      trainSearch: () => Promise.resolve(providerSuccess('RAILCORE', lowBalanceSearchResults())),
      trainInfo: () => Promise.resolve(providerSuccess('RAILCORE', {})),
      timetable: () => Promise.resolve(providerSuccess('RAILCORE', {})),
      liveStatus: () => Promise.resolve(providerSuccess('RAILCORE', {})),
      availability: () => Promise.resolve(providerSuccess('RAILCORE', {})),
      fare: () => Promise.resolve(providerSuccess('RAILCORE', {
        trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', journeyDate: '2026-08-27',
        travelClass: 'CC', quota: 'GN', currency: 'INR',
        breakdown: { baseFareMinor: null, reservationChargeMinor: null, superfastChargeMinor: null, dynamicFareMinor: null, cateringChargeMinor: null, gstMinor: null, totalMinor: 40500 },
        source: 'RAILCORE', retrievedAt: '2026-08-26T00:00:00Z',
      })),
      pnr: () => Promise.resolve(providerSuccess('RAILKIT', {})),
      cancelledTrains: () => Promise.resolve(providerSuccess('RAILKIT', [])),
    }) as unknown as RailwayProvider;
  return new RailwayProviderRouter({
    providers: [
      make('RAILCORE', ['stationLookup', 'trainSearch', 'trainInfo', 'timetable', 'liveStatus', 'availability', 'fare']),
      make('RAILKIT', ['trainSearch', 'trainInfo', 'timetable', 'liveStatus', 'availability', 'fare', 'pnr', 'cancelledTrains']),
    ],
    // Fixed test clock (same as the main harness): 'kal' from the harness clock must
    // never become "past" when the REAL date rolls forward — date validation is
    // deterministic against the injected clock, not the wall clock.
    now: () => new Date('2026-08-26T10:00:00.000Z'),
  });
}

/** Drive a conversation to a given point using the standard harness. */
async function driveTo(harness: ReturnType<typeof createHarness>, stage: 'searched' | 'trainSelected' | 'classChosen' | 'atReview' | 'confirmed'): Promise<ConversationContext> {
  let context = freshContext();
  context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
  context = (await run(harness, context, 'kal')).context;
  if (stage === 'searched') return context;
  context = (await run(harness, context, 'pehli wali')).context;
  if (stage === 'trainSelected') return context;
  context = (await run(harness, context, 'CC')).context;
  if (stage === 'classChosen') return context;
  context = (await run(harness, context, '2')).context;
  for (const answer of ['Rahul', '30', 'M', 'Priya', '28', 'F']) {
    context = (await run(harness, context, answer)).context;
  }
  if (stage === 'atReview') return context;
  context = (await run(harness, context, 'haan')).context;
  return context; // confirmed
}

describe('1-5: booking conversation + missing slots', () => {
  it('1: complete booking conversation reaches CONFIRMED via the deterministic mock boundary', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'confirmed');
    expect(context.bookingStage).toBe('CONFIRMED');
  });

  it('2/3: missing origin or destination → asked naturally (never re-asks known fields)', async () => {
    const harness = createHarness();
    const originTurn = await run(harness, freshContext(), 'Ludhiana jaana hai');
    expect(originTurn.reply).toMatch(/kahan se/i);

    const destTurn = await run(harness, freshContext(), 'Amritsar se jaana hai');
    expect(destTurn.context.origin?.code).toBe('ASR');
    expect(destTurn.reply).toMatch(/kahan tak/i);
  });

  it('4: missing date → "Kis date ko jaana hai?" (§3 example)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai');
    expect(turn.reply).toMatch(/kis date/i);
  });

  it('5: missing passenger count → asked after availability/fare (never before)', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'trainSelected');
    const classTurn = await run(harness, context, 'CC');
    expect(classTurn.reply).toMatch(/AVAILABLE/i);
    expect(classTurn.reply).toMatch(/kitne passengers/i); // count asked BEFORE names
  });
});

describe('6-9: train selection', () => {
  it('6: by number "12014 wali"', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'searched');
    const turn = await run(harness, context, '12014 wali');
    expect(turn.context.selectedTrain?.number).toBe('12014');
  });

  it('7/8: first and second train', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'searched');
    expect((await run(harness, context, 'pehli wali')).context.selectedTrain?.number).toBe('12014');
    expect((await run(harness, context, 'doosri wali')).context.selectedTrain?.number).toBe('14542');
  });

  it('9: invalid selection asks for clarification and does NOT continue', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'searched');
    const turn = await run(harness, context, '99999 wali');
    expect(turn.context.selectedTrain).toBeNull();
    expect(turn.context.bookingStage).toBe('SEARCH_RESULTS'); // state unchanged
    expect(turn.reply).toMatch(/current result list mein nahi/i);
  });
});

describe('10-12: class / availability / fare', () => {
  it('10: class selection offers provider-returned classes only', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'searched');
    const turn = await run(harness, context, 'pehli wali');
    expect(turn.reply).toMatch(/CC .*EC|classes.*CC/i); // 12014 offers CC/EC from the result
  });

  it('11: availability checked fresh through the router after class', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'trainSelected');
    const before = harness.countCapability('availability');
    const turn = await run(harness, context, 'CC');
    expect(harness.countCapability('availability')).toBe(before + 1);
    expect(turn.context.lastAvailability?.status).toBe('AVAILABLE');
    expect(turn.reply).toMatch(/AVAILABLE \(32 seats\)|AVAILABLE hain \(32 seats\)/i);
  });

  it('12: fare NOT shown mid-flow (user request) — only in the FINAL review, fully separated', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'trainSelected');
    const turn = await run(harness, context, 'CC');
    expect(turn.reply).not.toMatch(/Railway fare:/i); // mid-flow reply: availability + passenger question only
    expect(turn.panel?.kind ?? null).not.toBe('fare');

    // Complete passengers → the FINAL REVIEW carries the fully separated breakdown.
    let reviewContext = turn.context;
    reviewContext = (await run(harness, reviewContext, '2')).context;
    for (const answer of ['Rahul', '30', 'M', 'Priya', '28', 'F']) {
      reviewContext = (await run(harness, reviewContext, answer)).context;
    }
    expect(reviewContext.bookingStage).toBe('WAITING_CONFIRMATION');
    const reviewText = [...reviewContext.messages].reverse().map((m) => m.content).join('\n');
    expect(reviewText).toMatch(/Railway fare: ₹405\.00/);
    expect(reviewText).toMatch(/service fee: ₹20\.00/i);
    expect(reviewText).toMatch(/Total: ₹425\.00/);
  });
});

describe('13-14: passengers', () => {
  it('13: multiple passengers collected one at a time with progress', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const nameTurn = await run(harness, context, '2');
    expect(nameTurn.reply).toMatch(/Passenger 1 of 2 .*naam/i);
    expect(nameTurn.panel?.kind).toBe('passengers');
  });

  it('14: passenger correction restarts collection cleanly (change passenger)', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    context = (await run(harness, context, '2')).context;
    context = (await run(harness, context, 'Rahul')).context;
    context = (await run(harness, context, '30')).context;
    const change = await run(harness, context, 'passenger change karna hai');
    expect(change.context.passengers).toHaveLength(0);
    expect(change.reply).toMatch(/Passenger 1 .*naam/i);
  });
});

describe('15-18: mid-flow changes (§12)', () => {
  it('15: train change "12014 nahi 14542" invalidates class + availability + fare and re-asks class', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    expect(context.selectedTrain?.number).toBe('12014');
    expect(context.lastAvailability).not.toBeNull();

    const change = await run(harness, context, '12014 nahi 14542');
    expect(change.context.selectedTrain?.number).toBe('14542');
    expect(change.context.selectedClass).toBeNull();      // class invalidated
    expect(change.context.lastAvailability).toBeNull();   // availability invalidated
    expect(change.context.lastFareQuote).toBeNull();      // fare invalidated
    expect(change.context.passengers).toHaveLength(0);    // passengers invalidated
    expect(change.reply).toMatch(/14542 select ho gayi.*kaunsi class/is);
  });

  it('15b: "train change karni hai" without a number asks which', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const change = await run(harness, context, 'train change karni hai');
    expect(change.context.selectedTrain).toBeNull();
    expect(change.reply).toMatch(/kaunsi train/i);
  });

  it('16: date change re-runs the search (stale results dropped)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const before = harness.countCapability('trainSearch');
    const change = await run(harness, context, 'date change karni hai');
    expect(change.reply).toMatch(/kis date/i);
    const done = await run(harness, change.context, 'parso');
    expect(harness.countCapability('trainSearch')).toBe(before + 1);
    expect(done.context.journeyDate).toBe(isoPlusDays(2));
    expect(done.context.selectedTrain).toBeNull(); // stale selection gone
  });

  it('17: class change "CC nahi EC" re-checks availability AND fare freshly (offered classes only)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const availBefore = harness.countCapability('availability');
    const fareBefore = harness.countCapability('fare');
    const change = await run(harness, context, 'CC nahi EC');
    expect(change.context.selectedClass).toBe('EC');
    expect(harness.countCapability('availability')).toBe(availBefore + 1); // §34
    expect(harness.countCapability('fare')).toBe(fareBefore + 1);          // §35
  });

  it('17b: class NOT offered by the train → honest re-ask (never fake availability)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen'); // 12014 offers CC/EC
    const change = await run(harness, context, 'CC nahi SL');
    expect(change.context.selectedClass).toBeNull();        // wrong class never set
    expect(change.reply).toMatch(/SL class available nahi hai.*CC.*EC/i);
    expect(change.context.lastAskedField).toBe('selectedClass');
  });

  it('18: destination change invalidates the whole selection and re-searches (§36)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const searchesBefore = harness.countCapability('trainSearch');
    const change = await run(harness, context, 'Ludhiana ki jagah Chandigarh');
    expect(change.context.origin?.code).toBe('ASR');
    expect(change.context.destination?.code).toBe('CHD');
    expect(change.context.selectedTrain).toBeNull();       // old train gone
    expect(change.context.selectedClass).toBeNull();       // old class gone
    expect(change.context.passengers).toHaveLength(0);     // passenger details gone
    expect(change.context.lastFareQuote).toBeNull();       // stale fare gone
    expect(change.context.lastAvailability).toBeNull();    // stale availability gone
    expect(harness.countCapability('trainSearch')).toBe(searchesBefore + 1); // FRESH search for the new route
  });
});

describe('19-22: interrupts during booking (§11)', () => {
  it('19/20: live-status interrupt during passenger details resumes exactly where it left off', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    context = (await run(harness, context, '2')).context;
    context = (await run(harness, context, 'Rahul')).context; // name done → age asked

    const interrupt = await run(harness, context, 'Waise 12014 abhi kaha hai?');
    expect(interrupt.intent).toBe('LIVE_TRAIN_STATUS');
    expect(interrupt.reply).toMatch(/12014/);
    expect(interrupt.reply).toMatch(/Passenger 1 .*age/i); // resume question
    expect(interrupt.context.passengerDraft?.name).toBe('Rahul'); // nothing lost
    expect(interrupt.context.bookingStage).toBe('PASSENGER_DETAILS_REQUIRED');
  });

  it('21/22: fare interrupt mid-booking answers from the provider and resumes', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    context = (await run(harness, context, '2')).context;
    const interrupt = await run(harness, context, 'is train ka total fare kitna hoga?');
    expect(interrupt.executedTools).toContain('getFare');
    expect(interrupt.reply).toMatch(/Railway fare/i);
    expect(interrupt.reply).toMatch(/Passenger 1 .*naam/i); // back to passenger collection
  });
});

describe('23-26: review + confirmation safety (§13/§14)', () => {
  it('23: final review shows everything (train, journey, date, class, passengers, fares)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'atReview');
    const review = [...context.messages].reverse().find((message) => message.content.includes('BOOKING REVIEW'))!;
    const text = review.content;
    expect(text).toMatch(/12014/);
    expect(text).toMatch(/ASR → LDH/);
    expect(text.match(/Passengers: 2/));
    expect(text).toMatch(/Rahul · 30y · M/);
    expect(text).toMatch(/Railway fare: ₹405\.00/);
    expect(text).toMatch(/Total: ₹425\.00/);
    expect(text).toMatch(/confirm karun/i);
  });

  it('24: explicit confirmation runs ONLY the deterministic mock booking', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'atReview');
    const turn = await run(harness, context, 'haan');
    expect(turn.executedTools).toContain('executeMockBooking');
    expect(turn.executedTools).not.toContain('confirmBooking');
    expect(turn.context.bookingStage).toBe('CONFIRMED');
    expect(turn.reply).toMatch(/DEMO booking complete/i);
  });

  it('25: "haan" BEFORE the review never books', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    context = (await run(harness, context, '2')).context;
    const premature = await run(harness, context, 'haan');
    expect(premature.executedTools).not.toContain('executeMockBooking');
    expect(premature.context.bookingStage).not.toBe('CONFIRMED');
  });

  it('26: "book kar do" BEFORE the review never books', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'trainSelected');
    const premature = await run(harness, context, 'book kar do');
    expect(premature.executedTools).not.toContain('executeMockBooking');
    expect(premature.context.bookingStage).not.toBe('CONFIRMED');
    expect(premature.reply).not.toMatch(/booking complete/i);
  });
});

describe('27-33: money + mock safety (§15-§18)', () => {
  it('27: insufficient wallet balance fails honestly (deterministic check, no AI decision)', async () => {
    const harness = lowBalanceHarness();
    let context = freshContext();
    for (const message of ['ASR se LDH jaana hai', 'kal', 'pehli wali', 'CC', '2', 'Rahul', '30', 'M', 'Priya', '28', 'F', 'haan']) {
      context = (await run(harness, context, message)).context;
    }
    expect(context.bookingStage).toBe('FAILED');
    const lastReply = [...context.messages].reverse().find((message) => message.role === 'assistant')!;
    expect(lastReply.content).toMatch(/complete nahi ho paayi/i);
    expect(lastReply.content).toMatch(/insufficient/i);
  });

  it('28: wallet balance is never invented (no getWallet execution in the flow)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'atReview');
    const turn = await run(harness, context, 'haan');
    expect(turn.reply).toMatch(/DEMO booking complete/i); // balance handled by the deterministic executor only
    expect(turn.executedTools).not.toContain('getWallet'); // AI never queried/filled balance
  });

  it('29: fare cannot be invented — no fare → review/confirm refused', async () => {
    const harness = createHarness({ fare: providerSuccess('RAILCORE', {
      trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', journeyDate: null,
      travelClass: 'CC', quota: 'GN', currency: 'INR',
      breakdown: { baseFareMinor: null, reservationChargeMinor: null, superfastChargeMinor: null, dynamicFareMinor: null, cateringChargeMinor: null, gstMinor: null, totalMinor: null },
      source: 'RAILCORE', retrievedAt: '2026-08-26T00:00:00Z',
    }) });
    let context = freshContext();
    for (const message of ['ASR se LDH jaana hai', 'kal', 'pehli wali', 'CC', '2', 'Rahul', '30', 'M', 'Priya', '28', 'F']) {
      context = (await run(harness, context, message)).context;
    }
    expect(context.bookingStage).not.toBe('WAITING_CONFIRMATION'); // no review without a verified fare
    const confirm = await run(harness, context, 'haan');
    expect(confirm.executedTools).not.toContain('executeMockBooking');
  });

  it('31: PNR never invented — mock booking record has pnr: null and MOCK- id', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'atReview');
    const turn = await run(harness, context, 'haan');
    const reply = [...turn.context.messages].reverse().find((message) => message.role === 'assistant')!.content;
    expect(reply).toMatch(/MOCK-/);
    expect(reply).not.toMatch(/\b\d{10}\b/); // no real-looking PNR anywhere
  });

  it('32: mock booking cannot appear as a real booking (DEMO wording mandatory)', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'atReview');
    const turn = await run(harness, context, 'haan');
    expect(turn.reply).toMatch(/DEMO/i);
    expect(turn.reply).toMatch(/real railway ticket nahi/i);
  });

  it('33: failed booking is never reported as success', async () => {
    const harness = lowBalanceHarness();
    let context = freshContext();
    for (const message of ['ASR se LDH jaana hai', 'kal', 'pehli wali', 'CC', '2', 'Rahul', '30', 'M', 'Priya', '28', 'F', 'haan']) {
      context = (await run(harness, context, message)).context;
    }
    const reply = [...context.messages].reverse().find((message) => message.role === 'assistant')!.content;
    expect(reply).not.toMatch(/booking complete ho gayi|🎉 DEMO booking complete/i);
    expect(reply).toMatch(/nahi ho paayi/i);
  });
});

describe('30/34-36: invention + staleness guards', () => {
  it('30: availability cannot be invented (provider empty → UNKNOWN, no counts)', async () => {
    const harness = createHarness({ availability: providerSuccess('RAILCORE', {
      trainNumber: '12014', journeyDate: '2026-08-27', travelClass: 'CC', quota: 'GN',
      status: 'UNAVAILABLE', availableCount: null, racCount: null, waitlistNumber: null, asOf: null,
    }) });
    let context = freshContext();
    for (const message of ['ASR se LDH jaana hai', 'kal', 'pehli wali']) {
      context = (await run(harness, context, message)).context;
    }
    const turn = await run(harness, context, 'CC');
    expect(turn.reply).toMatch(/pata nahi chal paayi|UNAVAILABLE|abhi pata nahi/i);
    expect(turn.reply).not.toMatch(/\d+ seats AVAILABLE/i);
  });

  it('34: availability re-checked (never reused) after a train change', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    context = (await run(harness, context, '12014 nahi 14542')).context; // 14542 offers SL/3A
    const before = harness.countCapability('availability');
    const next = await run(harness, context, 'SL');
    expect(harness.countCapability('availability')).toBe(before + 1);
    expect(next.context.lastAvailability?.status).toBeTruthy();
  });

  it('35: fare re-checked after a class change (stale fare dropped)', async () => {
    const harness = createHarness();
    let context = await driveTo(harness, 'classChosen');
    expect(context.lastFareQuote?.breakdown.totalMinor).toBe(40500);
    const fareCallsBefore = harness.countCapability('fare');
    context = (await run(harness, context, 'CC nahi EC')).context;
    expect(context.selectedClass).toBe('EC');
    expect(harness.countCapability('fare')).toBe(fareCallsBefore + 1); // fresh provider quote for the new class
    expect(context.lastFareQuote).not.toBeNull();
  });

  it('36: route change wipes train/class/passengers/fare — only FRESH results remain', async () => {
    const harness = createHarness();
    const context = await driveTo(harness, 'classChosen');
    const searchesBefore = harness.countCapability('trainSearch');
    const change = await run(harness, context, 'Ludhiana ki jagah Beas');
    expect(change.context.selectedTrain).toBeNull();
    expect(change.context.selectedClass).toBeNull();
    expect(change.context.passengers).toHaveLength(0);
    expect(change.context.lastAvailability).toBeNull();
    expect(change.context.lastFareQuote).toBeNull();
    expect(harness.countCapability('trainSearch')).toBe(searchesBefore + 1); // old trains replaced by a fresh search
    expect(change.context.bookingStage).toBe('SEARCH_RESULTS'); // back at selection for the new route
  });
});

void orchestrateTurn;
void DeterministicNLUProvider;
