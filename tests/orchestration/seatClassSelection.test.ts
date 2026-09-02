/**
 * Train-card class chips + Hinglish class/seat utterances must select
 * that train+class instead of re-asking or running availability.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { INTENTS } from '../../shared/index.js';
import { createHarness, freshContext, run } from './harness.js';

async function searchResults() {
  const harness = createHarness();
  let context = (await run(harness, freshContext(), 'ASR se LDH jaana hai')).context;
  context = (await run(harness, context, 'kal')).context;
  expect(context.lastSearchResults?.length).toBeGreaterThan(0);
  expect(context.lastAskedField).toBe('selectedTrain');
  return { harness, context };
}

describe('seat / class selection after train list', () => {
  it('bare train number selects that train from the current list', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '12014');
    expect(turn.context.selectedTrain?.number).toBe('12014');
    expect(turn.context.lastAskedField).toBe('selectedClass');
    expect(turn.reply).not.toMatch(/samajh nahi/i);
  });

  it('chip-style "12014 mein CC chahiye" selects train + class in one turn', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '12014 mein CC chahiye');
    expect(turn.context.selectedTrain?.number).toBe('12014');
    expect(turn.context.selectedClass).toBe('CC');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.reply).not.toMatch(/Pehle train select/i);
    expect(turn.reply).not.toMatch(/samajh nahi/i);
  });

  it('"14542 mein 3A chahiye" selects the express + 3A', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '14542 mein 3A chahiye');
    expect(turn.context.selectedTrain?.number).toBe('14542');
    expect(turn.context.selectedClass).toBe('3A');
    expect(turn.executedTools).toContain('getAvailability');
  });

  it('"3A chahiye" auto-selects the only train that offers 3A', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '3A chahiye');
    expect(turn.context.selectedTrain?.number).toBe('14542');
    expect(turn.context.selectedClass).toBe('3A');
    expect(turn.reply).not.toMatch(/Pehle train select/i);
  });

  it('"sleeper seat chahiye" maps to SL on the train that offers it', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, 'sleeper seat chahiye');
    expect(turn.context.selectedClass).toBe('SL');
    expect(turn.context.selectedTrain?.number).toBe('14542');
  });

  it('"yeh particular seat chahiye" asks them to tap a class chip', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, 'yeh particular seat chahiye');
    expect(turn.reply).toMatch(/class/i);
    expect(turn.reply).toMatch(/tap/i);
    expect(turn.context.selectedTrain).toBeNull();
  });

  it('live status is not stolen by a train-number pick', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '12014 ka live status batao');
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
  });

  it('typed number not in the current list is refused — never train-info or rephrase', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '14662');
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
    expect(turn.intent).not.toBe('GET_TRAIN_INFO');
    expect(turn.reply).toMatch(/list mein nahi/i);
    expect(turn.reply).not.toMatch(/samajh nahi/i);
    expect(turn.context.selectedTrain).toBeNull();
  });

  it('"14662 ka sl class" not in the list is refused, not GET_TRAIN_INFO', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '14662 ka sl class');
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
    expect(turn.reply).toMatch(/list mein nahi/i);
    expect(turn.reply).not.toMatch(/Pehle train select/i);
    expect(turn.context.selectedTrain).toBeNull();
  });

  it('bare SL with several matching trains asks which train (with SL hint)', async () => {
    const { harness, context } = await searchResults();
    const extra = {
      train: {
        number: '14600',
        name: 'Dummy Sleeper',
        originStation: context.origin!,
        destinationStation: context.destination!,
        departureTime: '12:00',
        arrivalTime: '14:00',
        runsOn: ['MON'],
        travelClasses: ['SL', '2S'],
        pantryCar: null,
      },
      fromStation: context.origin!,
      toStation: context.destination!,
      departureTime: '12:00',
      arrivalTime: '14:00',
      durationMinutes: 120,
    };
    context.lastSearchResults = [...(context.lastSearchResults ?? []), extra];
    const turn = await run(harness, context, 'SL');
    expect(turn.reply).toMatch(/Pehle train select/i);
    expect(turn.reply).toMatch(/SL/);
    expect(turn.context.selectedTrain).toBeNull();
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
  });

  it('NVIDIA GET_TRAIN_INFO on a listed number is treated as a booking pick', async () => {
    const { harness, context } = await searchResults();
    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      understand: async () => ({
        intent: 'GET_TRAIN_INFO',
        confidence: 0.95,
        slots: {
          originQuery: null,
          destinationQuery: null,
          journeyDate: null,
          dateText: null,
          passengerCount: null,
          trainNumber: '12014',
          secondTrainNumber: null,
          travelClass: null,
          pnr: null,
          resultReference: null,
          isCorrection: false,
          mentionedStations: [],
          glossaryTerm: null,
        },
        missingFields: [],
        toolRequest: null,
      }),
      generateResponse: async () => ({ message: 'train info', askForField: null }),
    };
    const turn = await run(harness, context, '12014', { ai: steal });
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
    expect(turn.context.selectedTrain?.number).toBe('12014');
    expect(turn.context.lastAskedField).toBe('selectedClass');
  });

  it('NVIDIA GET_TRAIN_INFO on a number not in the list is refused, not dumped', async () => {
    const { harness, context } = await searchResults();
    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      understand: async () => ({
        intent: 'GET_TRAIN_INFO',
        confidence: 0.95,
        slots: {
          originQuery: null,
          destinationQuery: null,
          journeyDate: null,
          dateText: null,
          passengerCount: null,
          trainNumber: '20808',
          secondTrainNumber: null,
          travelClass: null,
          pnr: null,
          resultReference: null,
          isCorrection: false,
          mentionedStations: [],
          glossaryTerm: null,
        },
        missingFields: [],
        toolRequest: null,
      }),
      generateResponse: async () => ({ message: 'train info', askForField: null }),
    };
    const turn = await run(harness, context, '20808', { ai: steal });
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
    expect(turn.reply).toMatch(/list mein nahi/i);
    expect(turn.reply).not.toMatch(/samajh nahi/i);
  });

  it('hallucinated stations on a typed number do not start a new search', async () => {
    const { harness, context } = await searchResults();
    const steal: AIProvider = {
      providerId: 'nvidia-steal',
      understand: async () => ({
        intent: 'SEARCH_TRAIN',
        confidence: 0.9,
        slots: {
          originQuery: 'Jammu',
          destinationQuery: 'Barmer',
          journeyDate: null,
          dateText: null,
          passengerCount: null,
          trainNumber: '14662',
          secondTrainNumber: null,
          travelClass: null,
          pnr: null,
          resultReference: null,
          isCorrection: false,
          mentionedStations: ['Jammu', 'Barmer'],
          glossaryTerm: null,
        },
        missingFields: [],
        toolRequest: null,
      }),
      generateResponse: async () => ({ message: 'search', askForField: null }),
    };
    const turn = await run(harness, context, '14662', { ai: steal });
    expect(turn.executedTools ?? []).not.toContain('searchTrains');
    expect(turn.reply).toMatch(/list mein nahi/i);
    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
  });

  it('"12014 ka sl class" on a listed train selects that train + SL', async () => {
    const { harness, context } = await searchResults();
    const turn = await run(harness, context, '14542 ka sl class');
    expect(turn.context.selectedTrain?.number).toBe('14542');
    expect(turn.context.selectedClass).toBe('SL');
    expect(turn.executedTools ?? []).not.toContain('getTrainInfo');
    expect(turn.reply).not.toMatch(/Pehle train select/i);
  });
});

describe('deterministic NLU class phrases', () => {
  const nlu = new DeterministicNLUProvider();
  const idle = freshContext();

  async function slots(message: string) {
    return nlu.understand({
      userMessage: message,
      conversation: idle,
      availableIntents: INTENTS,
      availableTools: [],
    });
  }

  it('extracts spoken class names', async () => {
    expect((await slots('sleeper chahiye')).slots.travelClass).toBe('SL');
    expect((await slots('3 ac seat')).slots.travelClass).toBe('3A');
    expect((await slots('chair car')).slots.travelClass).toBe('CC');
    expect((await slots('2AC wali')).slots.travelClass).toBe('2A');
    expect((await slots('14662 ka sl class')).slots.travelClass).toBe('SL');
    expect((await slots('14662 ka sl class')).slots.trainNumber).toBe('14662');
  });
});
