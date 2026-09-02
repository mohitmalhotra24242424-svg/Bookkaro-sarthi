/**
 * READ DATA-INTENT ROUTE FOLLOW-UP.
 *
 * "12053 ki seat availability check krna" → assistant asks the route →
 * user answers "Amritsar se Ludhiana" (a full route, no train mentioned).
 *
 * This must NOT become "samajh nahi paaya": the orchestrator completes the
 * SAME availability/fare request — keeping the train/class it already had,
 * resolving both stations, and asking only for whatever is still missing.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, run, ASR, BEAS, LDH, NDLS, DLI, NZM } from './orchestration/harness.js';
import type { AIProvider, AIUnderstandingInput, AIUnderstandingResult } from '../ai/AIProvider.js';
import type { AIReplyInput, AIReplyResult } from '../ai/AIProvider.js';
import { providerSuccess } from '../shared/index.js';

/** Stub AI that proposes a getAvailability tool request (AI-primary tool path). */
function stubAiAvailabilityRequest(): AIProvider {
  return {
    providerId: 'nvidia-stub',
    async understand(_i: AIUnderstandingInput): Promise<AIUnderstandingResult> {
      return {
        intent: 'GET_AVAILABILITY',
        confidence: 0.85,
        slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: '12053', secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
        missingFields: [],
        toolRequest: { tool: 'getAvailability', input: { trainNumber: '12053' }, rationale: 'availability' },
      };
    },
    async generateResponse(_i: AIReplyInput): Promise<AIReplyResult> {
      return { askForField: null, message: 'n/a' };
    },
  };
}

describe('data-intent route follow-up ("A se B" answers the route question)', () => {
  it('completes availability by filling both stations, keeping the train', async () => {
    const harness = createHarness();
    const t1 = await run(harness, freshContext(), '12053 ki seat availability check krna');
    expect(t1.intent).toBe('GET_AVAILABILITY');
    expect(t1.reply).toMatch(/route ke liye/i);

    const t2 = await run(harness, t1.context, 'Amritsar se Ludhiana');
    // Same request, not UNKNOWN / "samajh nahi paaya".
    expect(t2.intent).toBe('GET_AVAILABILITY');
    expect(t2.reply).not.toMatch(/samajh nahi paaya/i);
    // Both stations resolved.
    expect(t2.context.origin?.code).toBe('ASR');
    expect(t2.context.destination?.code).toBe('LDH');
    // Only the still-missing slot is asked.
    expect(t2.reply).toMatch(/date/i);
  });

  it('completes fare the same way (train kept)', async () => {
    const harness = createHarness();
    const t1 = await run(harness, freshContext(), '12014 ka fare kitna hai?');
    expect(t1.intent).toBe('GET_FARE');
    const t2 = await run(harness, t1.context, 'Amritsar se Ludhiana');
    expect(t2.intent).toBe('GET_FARE');
    expect(t2.context.origin?.code).toBe('ASR');
    expect(t2.context.destination?.code).toBe('LDH');
  });

  it('does NOT trigger when no route was pending (normal new query)', async () => {
    const harness = createHarness();
    const t = await run(harness, freshContext(), 'Amritsar se Ludhiana');
    // A fresh route with no pending data intent is a journey, not availability.
    expect(t.intent).not.toBe('GET_AVAILABILITY');
  });

  it('uses station disambiguation when an endpoint is ambiguous', async () => {
    const harness = createHarness();
    // NDLS/DLI/NZM all match "delhi" — must ask, never auto-pick.
    const t1 = await run(harness, freshContext(), '12014 CC availability batao');
    const t2 = await run(harness, t1.context, 'Amritsar se Delhi');
    expect(t2.intent).toBeTruthy();
    // Delhi is ambiguous → ask which one; do not silently resolve to a single code.
    expect(t2.context.destination?.code ?? null).not.toBe('NDLS');
  });

  it('resumes the availability intent after a station disambiguation choice', async () => {
    const harness = createHarness();
    const t1 = await run(harness, freshContext(), '12014 CC availability batao');
    // Amritsar→ASR resolves directly; Delhi is ambiguous → ask.
    const t2 = await run(harness, t1.context, 'Amritsar se Delhi');
    expect(t2.context.stationChoices).not.toBeNull();
    // The user taps NDLS (code) via the chips.
    const t3 = await run(harness, t2.context, 'NDLS');
    // Still availability, destination now NDLS, only the (missing) date asked.
    expect(t3.intent).toBe('GET_AVAILABILITY');
    expect(t3.context.destination?.code).toBe('NDLS');
    expect(t3.reply).toMatch(/date/i);
  });

  it('route follow-up completes on the AI-requested-tool path (getAvailability)', async () => {
    const harness = createHarness();
    // AI-primary: the model proposes getAvailability (no route) → asks route.
    const t1 = await run(harness, freshContext(), '12053 ki seat availability check krna', { ai: stubAiAvailabilityRequest() });
    expect(t1.intent).toBe('GET_AVAILABILITY');
    expect(t1.reply).toMatch(/route ke liye/i);
    expect(t1.context.pendingDataRoute?.trainNumber).toBe('12053');
    // User answers the route → completes the SAME availability request.
    const t2 = await run(harness, t1.context, 'Amritsar se Ludhiana', { ai: stubAiAvailabilityRequest() });
    expect(t2.intent).toBe('GET_AVAILABILITY');
    expect(t2.context.origin?.code).toBe('ASR');
    expect(t2.context.destination?.code).toBe('LDH');
    expect(t2.reply).toMatch(/date/i);
  });

  it('resolves a route supplied INLINE in the same availability message ("asr jn se ndls")', async () => {
    const harness = createHarness();
    const t = await run(harness, freshContext(), '12014 ki seat availability check karna asr jn se ndls');
    expect(t.intent).toBe('GET_AVAILABILITY');
    // The jn suffix must resolve to ASR, not become a partial token.
    expect(t.context.origin?.code).toBe('ASR');
    expect(t.context.destination?.code).toBe('NDLS');
    // It should NOT ask for the route again — only the still-missing date.
    expect(t.reply).not.toMatch(/route ke liye/i);
    expect(t.reply).toMatch(/date/i);
  });

  it('resolves an inline route written as full station names', async () => {
    const harness = createHarness();
    const t = await run(harness, freshContext(), '12014 ki seat availability check karna Amritsar se Ludhiana');
    expect(t.context.origin?.code).toBe('ASR');
    expect(t.context.destination?.code).toBe('LDH');
    expect(t.reply).not.toMatch(/route ke liye/i);
  });

  it('stays in availability across a date follow-up (does not start a train search)', async () => {
    const harness = createHarness();
    const t1 = await run(harness, freshContext(), '12014 ki seat availability check karna asr jn se ndls');
    expect(t1.context.origin?.code).toBe('ASR');
    expect(t1.context.destination?.code).toBe('NDLS');
    expect(t1.reply).toMatch(/date/i);
    // Giving the date must resume availability, NOT become BOOK_TRAIN/search.
    const t2 = await run(harness, t1.context, 'kal ke liye');
    expect(t2.intent).toBe('GET_AVAILABILITY');
    expect(t2.context.origin?.code).toBe('ASR');
    expect(t2.context.destination?.code).toBe('NDLS');
    expect(t2.reply).not.toMatch(/sabse|mili|kaunsi leni|search/i);
  });

  it('does not treat the verb "krna" as a station when no route is given', async () => {
    const harness = createHarness();
    const t1 = await run(harness, freshContext(), '12014 ki seat availability check krna');
    expect(t1.intent).toBe('GET_AVAILABILITY');
    // No spoofed station from the verb; still asks for the route.
    expect(t1.reply).toMatch(/route ke liye/i);
  });
});

describe('one-line 12054 Amritsar JN → Ludhiana JN availability', () => {
  const ASRA = { code: 'ASRA', name: 'AMRITSAR CBA', zone: null, state: 'Punjab', latitude: null, longitude: null };
  const VKA = { code: 'VKA', name: 'VERKA JN', zone: null, state: 'Punjab', latitude: null, longitude: null, city: 'Amritsar' };
  const JAN = {
    number: '12054',
    name: 'ASR JAN SHATABDI',
    originStation: { code: 'ASR', name: 'AMRITSAR JN', zone: null, state: 'Punjab', latitude: null, longitude: null },
    destinationStation: { code: 'NDLS', name: 'New Delhi', zone: null, state: 'Delhi', latitude: null, longitude: null },
    departureTime: '07:00',
    arrivalTime: '13:10',
    runsOn: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const,
    travelClasses: ['CC', '2S', 'EC'] as const,
    pantryCar: true,
  };

  it('resolves ASR+LDH (not Verka/CBA) and only asks the date', async () => {
    const harness = createHarness(
      { trainInfo: providerSuccess('RAILCORE', JAN) },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
    );
    expect(t1.intent).toBe('GET_AVAILABILITY');
    expect(t1.context.origin?.code).toBe('ASR');
    expect(t1.context.destination?.code).toBe('LDH');
    expect(t1.reply).toMatch(/date/i);
    expect(t1.reply).not.toMatch(/EK station choose|AMRITSAR CBA|VERKA|ASRA|VKA/i);
    expect(t1.context.stationChoices).toBeNull();
  });

  it('class chips come from schedule when trainInfo has no classes (12054 is 2S/CC, not SL/3A)', async () => {
    const noClassInfo = { ...JAN, travelClasses: null };
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', noClassInfo),
        timetable: providerSuccess('RAILCORE', {
          trainNumber: '12054',
          trainName: 'HW JANSHATABDI',
          stops: [
            { stationCode: 'ASR', stationName: 'AMRITSAR JN', arrivalTime: null, departureTime: '06:50', dayCount: 1, distanceKm: 0, haltMinutes: 0 },
            { stationCode: 'LDH', stationName: 'LUDHIANA JN', arrivalTime: '08:00', departureTime: '08:02', dayCount: 1, distanceKm: 135, haltMinutes: 2 },
          ],
          travelClasses: ['2S', 'CC'],
        }),
      },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
    );
    const t2 = await run(harness, t1.context, 'kal');
    expect(t2.intent).toBe('GET_AVAILABILITY');
    expect(t2.executedTools).toContain('getTimetable');
    expect(t2.chips).toEqual(['2S', 'CC']);
    expect(t2.reply).toMatch(/Kaunsi class chahiye\? \(2S, CC\)/);
    expect(t2.reply).not.toMatch(/\bSL\b|\b3A\b|\b2A\b|\b1A\b/);
    expect(t2.context.selectedTrain?.travelClasses).toEqual(['2S', 'CC']);
  });

  it('never invents generic SL/3A chips when the provider published no classes', async () => {
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', { ...JAN, travelClasses: null }),
        timetable: providerSuccess('RAILCORE', {
          trainNumber: '12054',
          trainName: 'HW JANSHATABDI',
          // Halt-check needs commercial stops; classes stay unpublished so chips stay empty.
          stops: [
            { stationCode: 'ASR', stationName: 'AMRITSAR JN', arrivalTime: null, departureTime: '06:50', dayCount: 1, distanceKm: 0, haltMinutes: 0 },
            { stationCode: 'LDH', stationName: 'LUDHIANA JN', arrivalTime: '08:00', departureTime: '08:02', dayCount: 1, distanceKm: 135, haltMinutes: 2 },
          ],
          travelClasses: null,
        }),
      },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
    );
    const t2 = await run(harness, t1.context, 'kal');
    expect(t2.chips).toBeNull();
    expect(t2.reply).not.toMatch(/\(SL/);
    expect(t2.reply).not.toMatch(/SL, 3A/);
  });

  it('after date, class chips come from getTrainInfo — never empty "card pe class tap"', async () => {
    const harness = createHarness(
      { trainInfo: providerSuccess('RAILCORE', JAN) },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
    );
    const t2 = await run(harness, t1.context, 'kal');
    expect(t2.intent).toBe('GET_AVAILABILITY');
    expect(t2.executedTools).toContain('getTrainInfo');
    expect(t2.chips).toEqual(['CC', '2S', 'EC']);
    expect(t2.reply).toMatch(/Kaunsi class chahiye\? \(CC, 2S, EC\)/);
    expect(t2.reply).toMatch(/chip tap/i);
    expect(t2.reply).not.toMatch(/Card pe class tap karein\.?$/);
    expect(t2.context.lastAskedField).toBe('selectedClass');
  });

  it('after class tap, fetches provider availability — never invents seats', async () => {
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', JAN),
        availability: providerSuccess('RAILCORE', {
          trainNumber: '12054',
          journeyDate: '2026-08-27',
          travelClass: 'CC',
          quota: 'GN',
          status: 'AVAILABLE',
          availableCount: 18,
          racCount: null,
          waitlistNumber: null,
          asOf: null,
        }),
      },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    let context = (await run(harness, freshContext(), 'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana')).context;
    context = (await run(harness, context, 'kal')).context;
    const t3 = await run(harness, context, 'CC');
    expect(t3.intent).toBe('GET_AVAILABILITY');
    expect(t3.executedTools).toContain('getAvailability');
    expect(t3.reply).toMatch(/AVAILABLE|18/i);
    expect(t3.reply).not.toMatch(/andaza|guess/i);
  });

  it('NVIDIA city-expanded "Amritsar" still keeps user "amritsar jn" → ASR', async () => {
    const { providerSuccess } = await import('../shared/index.js');
    const { ASR, LDH, NDLS, DLI, NZM, createHarness, freshContext, run } = await import('./orchestration/harness.js');
    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      async understand() {
        return {
          intent: 'GET_AVAILABILITY',
          confidence: 0.9,
          slots: {
            originQuery: 'Amritsar',
            destinationQuery: 'Ludhiana',
            journeyDate: null,
            dateText: null,
            passengerCount: null,
            trainNumber: '12054',
            secondTrainNumber: null,
            travelClass: null,
            pnr: null,
            resultReference: null,
            isCorrection: false,
            mentionedStations: ['Amritsar', 'Ludhiana'],
            glossaryTerm: null,
          },
          missingFields: [],
          toolRequest: null,
        };
      },
      async generateResponse() {
        return { askForField: null, message: 'n/a' };
      },
    };
    const harness = createHarness(
      { trainInfo: providerSuccess('RAILCORE', JAN) },
      { stations: [ASR, ASRA, VKA, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
      { ai: steal },
    );
    expect(t1.context.origin?.code).toBe('ASR');
    expect(t1.context.destination?.code).toBe('LDH');
    expect(t1.reply).not.toMatch(/EK station choose|ASRA|VERKA/i);
  });
});


/** Real RailCore commercial schedule for 12054 (include_intermediate=false) — no LDH. */
const JAN_12054 = {
  number: '12054',
  name: 'ASR JAN SHATABDI',
  originStation: { code: 'ASR', name: 'AMRITSAR JN', zone: null, state: 'Punjab', latitude: null, longitude: null },
  destinationStation: { code: 'HW', name: 'Haridwar Jn', zone: null, state: 'Uttarakhand', latitude: null, longitude: null },
  departureTime: '06:50',
  arrivalTime: '13:05',
  runsOn: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const,
  travelClasses: ['CC', '2S'] as const,
  pantryCar: true,
};

const JAN_12054_COMMERCIAL = {
  trainNumber: '12054',
  trainName: 'HW JANSHATABDI',
  travelClasses: ['2S', 'CC'] as const,
  stops: [
    { stationCode: 'ASR', stationName: 'AMRITSAR JN', arrivalTime: null, departureTime: '06:50', dayCount: 1, distanceKm: 0, haltMinutes: 0 },
    { stationCode: 'BEAS', stationName: 'BEAS', arrivalTime: '07:18', departureTime: '07:20', dayCount: 1, distanceKm: 42, haltMinutes: 2 },
    { stationCode: 'JUC', stationName: 'JALANDHAR CITY', arrivalTime: '07:48', departureTime: '07:50', dayCount: 1, distanceKm: 79, haltMinutes: 2 },
    { stationCode: 'PGW', stationName: 'PHAGWARA JN', arrivalTime: '08:04', departureTime: '08:06', dayCount: 1, distanceKm: 100, haltMinutes: 2 },
    { stationCode: 'DDL', stationName: 'DHANDARI KALAN', arrivalTime: '08:26', departureTime: '08:28', dayCount: 1, distanceKm: 135, haltMinutes: 2 },
    { stationCode: 'SIR', stationName: 'SIRHIND JN', arrivalTime: '09:00', departureTime: '09:02', dayCount: 1, distanceKm: 187, haltMinutes: 2 },
    { stationCode: 'UMB', stationName: 'AMBALA CANT JN', arrivalTime: '09:50', departureTime: '10:00', dayCount: 1, distanceKm: 241, haltMinutes: 10 },
    { stationCode: 'YJUD', stationName: 'YAMUNANAGAR JAGADHRI', arrivalTime: '10:38', departureTime: '10:40', dayCount: 1, distanceKm: 292, haltMinutes: 2 },
    { stationCode: 'SSW', stationName: 'SARSAWA', arrivalTime: '10:58', departureTime: '11:00', dayCount: 1, distanceKm: 315, haltMinutes: 2 },
    { stationCode: 'SRE', stationName: 'SAHARANPUR', arrivalTime: '11:20', departureTime: '11:25', dayCount: 1, distanceKm: 322, haltMinutes: 5 },
    { stationCode: 'RK', stationName: 'ROORKEE', arrivalTime: '11:56', departureTime: '11:58', dayCount: 1, distanceKm: 357, haltMinutes: 2 },
    { stationCode: 'HW', stationName: 'HARIDWAR JN', arrivalTime: '13:05', departureTime: null, dayCount: 1, distanceKm: 399, haltMinutes: 0 },
  ],
};

describe('12054 does not commercially halt at LDH — schedule before seats', () => {
  it('availability ASR→LDH fetches getTimetable first and refuses — never class chips or getAvailability', async () => {
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', JAN_12054),
        timetable: providerSuccess('RAILCORE', JAN_12054_COMMERCIAL),
        availability: providerSuccess('RAILCORE', {
          trainNumber: '12054',
          journeyDate: '2026-08-27',
          travelClass: 'CC',
          quota: 'GN',
          status: 'UNAVAILABLE',
          availableCount: 0,
          racCount: null,
          waitlistNumber: null,
          asOf: null,
        }),
      },
      { stations: [ASR, BEAS, LDH, NDLS, DLI, NZM] },
    );
    const availBefore = harness.countCapability('availability');
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
    );
    expect(t1.intent).toBe('GET_AVAILABILITY');
    expect(t1.context.origin?.code).toBe('ASR');
    expect(t1.context.destination?.code).toBe('LDH');
    expect(t1.executedTools).toContain('getTimetable');
    expect(t1.executedTools).not.toContain('getAvailability');
    expect(harness.countCapability('availability')).toBe(availBefore);
    expect(t1.chips).toBeNull();
    expect(t1.reply).toMatch(/NAHI rukti/i);
    expect(t1.reply).toMatch(/LDH/);
    expect(t1.reply).toMatch(/Commercial stops:/);
    expect(t1.reply).not.toMatch(/Kaunsi class chahiye/i);
    expect(t1.reply).not.toMatch(/AVAILABLE|WAITLIST|seat available nahi/i);
    expect(t1.reply).not.toMatch(/kis date/i);
  });

  it('fare ASR→LDH also refuses from schedule — never getFare', async () => {
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', JAN_12054),
        timetable: providerSuccess('RAILCORE', JAN_12054_COMMERCIAL),
      },
      { stations: [ASR, BEAS, LDH, NDLS, DLI, NZM] },
    );
    const fareBefore = harness.countCapability('fare');
    const t1 = await run(harness, freshContext(), '12054 ka fare amritsar jn se ludhiana jn');
    expect(t1.intent).toBe('GET_FARE');
    expect(t1.executedTools).toContain('getTimetable');
    expect(t1.executedTools).not.toContain('getFare');
    expect(harness.countCapability('fare')).toBe(fareBefore);
    expect(t1.reply).toMatch(/NAHI rukti/i);
    expect(t1.reply).not.toMatch(/Railway fare/i);
  });

  it('when the train does halt (ASR→BEAS), availability proceeds to date/class as before', async () => {
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', { ...JAN_12054, travelClasses: null }),
        timetable: providerSuccess('RAILCORE', JAN_12054_COMMERCIAL),
      },
      { stations: [ASR, BEAS, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(harness, freshContext(), '12054 ki asr se beas seat availability');
    expect(t1.context.origin?.code).toBe('ASR');
    expect(t1.context.destination?.code).toBe('BEAS');
    expect(t1.executedTools).toContain('getTimetable');
    expect(t1.executedTools).not.toContain('getAvailability');
    expect(t1.reply).toMatch(/date/i);
    expect(t1.reply).not.toMatch(/NAHI rukti/i);
    const t2 = await run(harness, t1.context, 'kal');
    expect(t2.chips).toEqual(['2S', 'CC']);
    expect(t2.reply).toMatch(/Kaunsi class chahiye\? \(2S, CC\)/);
  });

  it('AI getAvailability tool request also refuses before seats when LDH is not a stop', async () => {
    const steal: AIProvider = {
      providerId: 'nvidia-halt',
      async understand() {
        return {
          intent: 'GET_AVAILABILITY',
          confidence: 0.9,
          slots: {
            originQuery: 'ASR',
            destinationQuery: 'LDH',
            journeyDate: null,
            dateText: 'kal',
            passengerCount: null,
            trainNumber: '12054',
            secondTrainNumber: null,
            travelClass: 'CC',
            pnr: null,
            resultReference: null,
            isCorrection: false,
            mentionedStations: ['ASR', 'LDH'],
            glossaryTerm: null,
          },
          missingFields: [],
          toolRequest: { tool: 'getAvailability', input: { trainNumber: '12054', travelClass: 'CC' }, rationale: 'seats' },
        };
      },
      async generateResponse() {
        return { askForField: null, message: 'n/a' };
      },
    };
    const harness = createHarness(
      {
        trainInfo: providerSuccess('RAILCORE', JAN_12054),
        timetable: providerSuccess('RAILCORE', JAN_12054_COMMERCIAL),
      },
      { stations: [ASR, BEAS, LDH, NDLS, DLI, NZM] },
    );
    const t1 = await run(
      harness,
      freshContext(),
      'Mujhe 12054 ki amritsar jn se ludhiana jn ki seat availability btana',
      { ai: steal },
    );
    expect(t1.executedTools).toContain('getTimetable');
    expect(t1.executedTools).not.toContain('getAvailability');
    expect(t1.reply).toMatch(/NAHI rukti/i);
    expect(t1.chips).toBeNull();
  });
});
