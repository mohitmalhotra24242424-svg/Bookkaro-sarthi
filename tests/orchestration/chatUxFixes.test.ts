/**
 * Chat UX: hide-starter is frontend-only.
 * Server: gender chip "M", waitlist consent, Delhi station choice, class-wise berths.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult, Station } from '../../shared/index.js';
import { providerSuccess } from '../../shared/index.js';
import { berthsForClass } from '../../ai/replyTemplates.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { createHarness, freshContext, isoPlusDays, run, ASR, LDH, NDLS } from './harness.js';

/** Minimal station helper for a custom multi-station city index. */
function st(code: string, name: string): Station {
  return { code, name, zone: null, state: null, latitude: null, longitude: null };
}

const emptySlots = (): AIUnderstandingResult['slots'] => ({
  originQuery: null,
  destinationQuery: null,
  journeyDate: null,
  dateText: null,
  passengerCount: null,
  trainNumber: null,
  secondTrainNumber: null,
  travelClass: null,
  pnr: null,
  resultReference: null,
  isCorrection: false,
  mentionedStations: [],
  glossaryTerm: null,
});

describe('gender chip while collecting passengers', () => {
  it('NVIDIA NORMAL_CHAT on "M" still records gender', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '12014 mein CC chahiye')).context;
    context = (await run(harness, context, '1')).context;
    context = (await run(harness, context, 'Mohit')).context;
    context = (await run(harness, context, '30')).context;
    expect(context.lastAskedField).toBe('passengerGender');

    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      understand: async () => ({
        intent: 'NORMAL_CHAT',
        confidence: 0.9,
        slots: emptySlots(),
        missingFields: [],
        toolRequest: null,
      }),
      generateResponse: async () => ({ message: 'hi', askForField: null }),
    };
    const turn = await run(harness, context, 'M', { ai: steal });
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.reply).not.toMatch(/Weather, cricket/i);
    expect(turn.context.passengerDraft?.gender ?? turn.context.passengers[0]?.gender).toBe('M');
  });
});

describe('waitlist consent', () => {
  it('WAITLIST asks whether to continue before passenger details', async () => {
    const harness = createHarness({
      availability: providerSuccess('RAILCORE', {
        trainNumber: '14542',
        journeyDate: '2026-08-27',
        travelClass: '3A',
        quota: 'GN',
        status: 'WAITLIST',
        availableCount: null,
        racCount: null,
        waitlistNumber: 17,
        asOf: null,
      }),
    });
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const turn = await run(harness, context, '14542 mein 3A chahiye');
    expect(turn.reply).toMatch(/WAITLIST|Waitlist/i);
    expect(turn.reply).toMatch(/phir bhi book/i);
    expect(turn.context.lastAskedField).toBe('waitlistConsent');
    expect(turn.chips).toEqual(['haan', 'nahi']);
    expect(turn.reply).not.toMatch(/naam kya hai/i);
  });

  it('haan on waitlist continues to passenger count', async () => {
    const harness = createHarness({
      availability: providerSuccess('RAILCORE', {
        trainNumber: '14542',
        journeyDate: '2026-08-27',
        travelClass: '3A',
        quota: 'GN',
        status: 'WAITLIST',
        availableCount: null,
        racCount: null,
        waitlistNumber: 17,
        asOf: null,
      }),
    });
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '14542 mein 3A chahiye')).context;
    const turn = await run(harness, context, 'haan');
    expect(turn.context.waitlistAccepted).toBe(true);
    expect(turn.reply).toMatch(/Kitne passengers|naam kya hai/i);
    expect(turn.executedTools).not.toContain('executeMockBooking');
  });
});

describe('Delhi station choice', () => {
  it('chip-style NDLS selects New Delhi and continues', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Amritsar se Delhi jaana hai')).context;
    expect(context.stationChoices).not.toBeNull();
    const turn = await run(harness, context, 'NDLS — New Delhi');
    expect(turn.context.destination?.code).toBe('NDLS');
    expect(turn.reply).toMatch(/kis date/i);
  });

  it('"delhi se amritsar jaana hai kal" keeps kal, asks Delhi, does not drop dest', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe delhi se amritsar jaana hai kal');
    expect(turn.context.journeyDate).toBe(isoPlusDays(1));
    expect(turn.context.lastAskedField).toBe('origin');
    expect(turn.context.stationChoices?.field).toBe('origin');
    expect(turn.context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['DLI', 'NDLS', 'NZM']);
    expect(turn.context.origin?.code).not.toBe('DLI');
    expect(turn.context.destination?.name?.toLowerCase()).toMatch(/amritsar/);
    expect(turn.reply).toMatch(/EK station choose/i);
    expect(turn.reply).not.toMatch(/kis date/i);
    expect(turn.reply).not.toMatch(/Ajmer/i);

    const after = await run(harness, turn.context, 'NDLS — New Delhi');
    expect(after.context.origin?.code).toBe('NDLS');
    expect(after.context.destination?.code).toBe('ASR');
    expect(after.context.journeyDate).toBe(isoPlusDays(1));
    expect(after.cards?.length).toBeGreaterThan(0);
    expect(after.reply).not.toMatch(/kis date/i);
    expect(after.reply).not.toMatch(/Ajmer/i);
    expect(after.reply).not.toMatch(/\|[-:\\s|]+\|/);
  });

  it('NVIDIA invented DLI/ASR still looks up Delhi and keeps kal', async () => {
    const harness = createHarness();
    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      understand: async () => ({
        intent: 'SEARCH_TRAIN',
        confidence: 0.9,
        slots: { ...emptySlots(), originQuery: 'DLI', destinationQuery: 'ASR' },
        missingFields: [],
        toolRequest: null,
      }),
      generateResponse: async () => ({
        message: 'Delhi (DLI) se Ajmer (ASR) trains | Train | 12029 |\n|---|---|',
        askForField: null,
      }),
    };
    const turn = await run(harness, freshContext(), 'Mujhe delhi se amritsar jaana hai kal', { ai: steal });
    expect(turn.context.journeyDate).toBe(isoPlusDays(1));
    expect(turn.context.lastAskedField).toBe('origin');
    expect(turn.context.origin?.code).not.toBe('DLI');
    expect(turn.context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['DLI', 'NDLS', 'NZM']);
    expect(turn.reply).not.toMatch(/kis date/i);
    expect(turn.reply).not.toMatch(/Ajmer/i);
  });

  it('REGRESSION: both origin AND destination are multi-station cities — picking each resolves, never re-asks', async () => {
    // Real scenario (user report): "Ludhiana se Delhi kal" — Ludhiana AND Delhi are BOTH
    // multi-station cities. Origin is asked first, so the system stores a NAME-ONLY
    // destination placeholder {code:'', name:'Delhi'}. When the destination choice
    // resolves to DLI, FILL_MISSING must replace the placeholder — otherwise the pick
    // is dropped and it re-asks forever (the "Haridwar" case worked only because the
    // destination had no placeholder).
    const cities = [
      st('LDH', 'LUDHIANA JN'), st('LQTS', 'LUDHIANA QUICK TRANS'), st('DDL', 'DHANDARI KALAN'),
      st('DLI', 'DELHI'), st('NDLS', 'NEW DELHI'), st('NZM', 'DELHI NIZAMUDDIN'),
      st('HW', 'HARIDWAR JN'),
    ];
    const harness = createHarness({}, { stations: cities });

    let context = (await run(harness, freshContext(), 'Ludhiana se Delhi kal jaana hai')).context;
    expect(context.stationChoices?.field).toBe('origin');
    expect(context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['LDH', 'LQTS']);
    expect(context.destination).toEqual({ code: '', name: 'Delhi', zone: null, state: null, latitude: null, longitude: null });
    expect(context.journeyDate).toBe(isoPlusDays(1));

    // Pick origin LDH → destination becomes the pending choice.
    context = (await run(harness, context, 'LDH')).context;
    expect(context.origin?.code).toBe('LDH');
    expect(context.stationChoices?.field).toBe('destination');
    expect(context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['DLI', 'NDLS', 'NZM']);

    // THE BUG: "DLI" must resolve destination, NOT re-ask the station list.
    const turn = await run(harness, context, 'DLI');
    expect(turn.context.destination?.code).toBe('DLI');
    expect(turn.context.origin?.code).toBe('LDH');
    expect(turn.context.stationChoices).toBeNull();
    expect(turn.context.journeyDate).toBe(isoPlusDays(1)); // "kal" preserved across the whole flow
    // No redundant re-lookup of the destination (name-only placeholder already replaced by DLI).
    expect(turn.executedTools).not.toContain('lookupStation');
    expect(turn.context.lastAskedField).toBe('selectedTrain'); // everything set → results shown
    expect(turn.reply).not.toMatch(/EK station choose/i); // never re-asks the station choice
  });
});

describe('search replies stay on the template', () => {
  it('never lets NVIDIA overwrite search with a markdown table or Ajmer', async () => {
    const harness = createHarness();
    const liar: AIProvider = {
      providerId: 'nvidia-liar',
      understand: (input: AIUnderstandingInput) => new DeterministicNLUProvider().understand(input),
      generateResponse: async () => ({
        message: 'Delhi (DLI) se Ajmer (ASR) trains mili hain | Train | 12029 |\n|---|---|\n| 12029 | Ajmer |',
        askForField: null,
      }),
    };
    const turn = await run(harness, freshContext(), 'ASR se LDH jaana hai kal', { ai: liar });
    expect(turn.cards?.length).toBeGreaterThan(0);
    expect(turn.reply).not.toMatch(/Ajmer/i);
    expect(turn.reply).not.toMatch(/\|[-:\\s|]+\|/);
    expect(turn.reply).toMatch(/train/i);
  });
});

describe('train cards carry real origin/destination', () => {
  it('search cards expose provider origin/dest and this-journey from/to', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'kal');
    expect(turn.cards?.[0]?.originCode).toBe('ASR');
    expect(turn.cards?.[0]?.destCode).toBe('NDLS');
    expect(turn.cards?.[0]?.fromCode).toBe('ASR');
    expect(turn.cards?.[0]?.toCode).toBe('LDH');
  });
});

describe('berths follow the selected class', () => {
  it('CC skips berth after gender', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '12014 mein CC chahiye')).context;
    context = (await run(harness, context, '1')).context;
    context = (await run(harness, context, 'Mohit')).context;
    const age = await run(harness, context, '30');
    expect(age.context.lastAskedField).toBe('passengerGender');
    const gender = await run(harness, age.context, 'M');
    expect(gender.reply).not.toMatch(/berth/i);
    expect(gender.context.passengers[0]?.berthPreference).toBeNull();
  });

  it('3A offers lower/middle/upper/side, not chair options', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '14542 mein 3A chahiye')).context;
    context = (await run(harness, context, '1')).context;
    context = (await run(harness, context, 'Mohit')).context;
    context = (await run(harness, context, '30')).context;
    const turn = await run(harness, context, 'M');
    expect(turn.context.lastAskedField).toBe('passengerBerth');
    expect(turn.chips).toEqual(['lower', 'middle', 'upper', 'side lower', 'side upper', 'koi nahi']);
    expect(turn.reply).toMatch(/side lower/);
    expect(turn.reply).not.toMatch(/chair/i);
  });

  it('1A chips are only lower/upper — never middle or side', async () => {
    const harness = createHarness({
      trainSearch: providerSuccess('RAILCORE', [{
        train: {
          number: '12301',
          name: 'Rajdhani',
          originStation: ASR,
          destinationStation: NDLS,
          departureTime: '17:00',
          arrivalTime: '21:00',
          runsOn: ['MON'],
          travelClasses: ['1A', '2A'],
          pantryCar: true,
        },
        fromStation: ASR,
        toStation: LDH,
        departureTime: '17:00',
        arrivalTime: '21:00',
        durationMinutes: 240,
      }]),
    });
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '1A')).context;
    context = (await run(harness, context, '1')).context;
    context = (await run(harness, context, 'Mohit')).context;
    context = (await run(harness, context, '30')).context;
    const turn = await run(harness, context, 'M');
    expect(turn.context.lastAskedField).toBe('passengerBerth');
    expect(turn.chips).toEqual(['lower', 'upper', 'koi nahi']);
    expect(turn.reply).toMatch(/lower \/ upper/);
    expect(turn.reply).not.toMatch(/middle|side/);
    const reject = await run(harness, turn.context, 'middle');
    expect(reject.context.lastAskedField).toBe('passengerBerth');
    expect(reject.chips).toEqual(['lower', 'upper', 'koi nahi']);
  });

  it('class layouts stay IRCTC-accurate', () => {
    expect(berthsForClass('1A')).toEqual(['lower', 'upper']);
    expect(berthsForClass('2A')).toEqual(['lower', 'upper', 'side lower', 'side upper']);
    expect(berthsForClass('3A')).toEqual(['lower', 'middle', 'upper', 'side lower', 'side upper']);
    expect(berthsForClass('CC')).toBeNull();
  });
});

describe('single-train search + class/passenger chips', () => {
  it('one train never mentions pehli/doosri and chips match the card classes', async () => {
    const harness = createHarness({
      trainSearch: providerSuccess('RAILCORE', [{
        train: {
          number: '13035',
          name: 'UPASANA EXP',
          originStation: ASR,
          destinationStation: NDLS,
          departureTime: '21:15',
          arrivalTime: '15:50',
          runsOn: ['MON'],
          travelClasses: ['SL', '3E', '3A', '2A', '1A'],
          pantryCar: true,
        },
        fromStation: ASR,
        toStation: LDH,
        departureTime: '21:15',
        arrivalTime: '15:50',
        durationMinutes: 1115,
      }]),
    });
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    const turn = await run(harness, context, 'kal');
    expect(turn.context.selectedTrain?.number).toBe('13035');
    expect(turn.reply).not.toMatch(/pehli wali|doosri wali/i);
    expect(turn.reply).toMatch(/1 train/i);
    expect(turn.reply).toMatch(/Kaunsi class chahiye\? \(SL, 3E, 3A, 2A, 1A\)/);
    expect(turn.chips).toEqual(['SL', '3E', '3A', '2A', '1A']);
    expect(turn.cards?.[0]?.classes).toEqual(['SL', '3E', '3A', '2A', '1A']);
  });

  it('passenger count chips are 1–6', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const turn = await run(harness, context, '12014 mein CC chahiye');
    expect(turn.reply).toMatch(/Kitne passengers hain\? \(1 se 6\)/);
    expect(turn.chips).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('after passenger count 1, asks passenger details — never jumps to fare', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '12014 mein CC chahiye')).context;
    const turn = await run(harness, context, '1');
    expect(turn.context.passengerCount).toBe(1);
    expect(turn.context.lastAskedField).toBe('passengerName');
    expect(turn.reply).toMatch(/naam/i);
    expect(turn.reply).not.toMatch(/Railway fare|₹405|BOOKING REVIEW/i);
    expect(turn.panel?.kind).toBe('passengers');
  });

  it('NVIDIA fare-dump after "1" is rejected — still asks passenger details', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '12014 mein CC chahiye')).context;
    const steal: AIProvider = {
      providerId: 'nvidia-fare-steal',
      understand: async () => ({
        intent: 'GET_FARE',
        confidence: 0.9,
        slots: { ...emptySlots() },
        missingFields: [],
        toolRequest: { tool: 'getFare', input: { trainNumber: '12014', from: 'ASR', to: 'LDH' }, rationale: 'fare' },
      }),
      generateResponse: async () => ({
        message: 'Railway fare: ₹405.00 total payable hai bhai.',
        askForField: null,
      }),
    };
    const turn = await run(harness, context, '1', { ai: steal });
    expect(turn.context.passengerCount).toBe(1);
    expect(turn.context.lastAskedField).toBe('passengerName');
    expect(turn.reply).toMatch(/naam/i);
    expect(turn.reply).not.toMatch(/₹405|total payable/i);
  });

  it('one-shot "Rahul, 30, M" fills details instead of a rigid one-field wizard', async () => {
    const harness = createHarness();
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    context = (await run(harness, context, '12014 mein CC chahiye')).context;
    context = (await run(harness, context, '1')).context;
    const turn = await run(harness, context, 'Rahul, 30, M');
    expect(turn.context.passengers).toHaveLength(1);
    expect(turn.context.passengers[0]?.name).toBe('Rahul');
    expect(turn.context.passengers[0]?.age).toBe(30);
    expect(turn.context.passengers[0]?.gender).toBe('M');
    expect(turn.reply).toMatch(/REVIEW|confirm/i);
  });

  it('REGRET does not ask passengers — re-asks the train classes', async () => {
    const harness = createHarness({
      trainSearch: providerSuccess('RAILCORE', [{
        train: {
          number: '13035',
          name: 'UPASANA EXP',
          originStation: ASR,
          destinationStation: NDLS,
          departureTime: '21:15',
          arrivalTime: '15:50',
          runsOn: ['MON'],
          travelClasses: ['SL', '3E', '3A', '2A', '1A'],
          pantryCar: true,
        },
        fromStation: ASR,
        toStation: LDH,
        departureTime: '21:15',
        arrivalTime: '15:50',
        durationMinutes: 1115,
      }]),
      availability: providerSuccess('RAILCORE', {
        trainNumber: '13035',
        journeyDate: '2026-08-27',
        travelClass: '1A',
        quota: 'GN',
        status: 'REGRET',
        availableCount: null,
        racCount: null,
        waitlistNumber: null,
        asOf: null,
      }),
    });
    let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const turn = await run(harness, context, '13035 mein 1A chahiye');
    expect(turn.reply).toMatch(/REGRET/i);
    expect(turn.reply).not.toMatch(/Kitne passengers/i);
    expect(turn.context.selectedClass).toBeNull();
    expect(turn.context.lastAskedField).toBe('selectedClass');
    expect(turn.chips).toEqual(['SL', '3E', '3A', '2A', '1A']);
  });
});
