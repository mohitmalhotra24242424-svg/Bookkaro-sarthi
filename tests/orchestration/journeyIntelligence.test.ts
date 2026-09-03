/**
 * "Mujhe amritsar jn se patna jaana hai kal" is a complete journey.
 * The AI must search (or ask WHICH Patna station) — never a Namaste intro
 * asking for date/class/passenger the user already gave.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult, Station } from '../../shared/index.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { createHarness, freshContext, run, STATION_INDEX, ASR } from './harness.js';

const PNBE: Station = { code: 'PNBE', name: 'Patna Jn', zone: null, state: 'Bihar', latitude: null, longitude: null, isMajor: true };
const PPTA: Station = { code: 'PPTA', name: 'Patliputra', zone: null, state: 'Bihar', latitude: null, longitude: null };
const RJPB: Station = { code: 'RJPB', name: 'Rajendra Nagar Terminal', zone: null, state: 'Bihar', latitude: null, longitude: null, city: 'Patna' };

const GREETING =
  'Namaste! Main BookKaro, aapka railway assistant. Aapko Amritsar Jn se Patna Jn tak ki train ki jankari chahiye? Main aapki madad live status, fare, PNR aur booking mein kar sakta hoon. Kripya apni travel details (date, class, passenger count, etc.) batayein, ya koi specific train number poochhein.';

const JOURNEY = 'Mujhe amritsar jn se patna jaana hai kal';

function emptySlots(): AIUnderstandingResult['slots'] {
  return {
    originQuery: null, destinationQuery: null, journeyDate: null, dateText: null,
    passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: null,
    pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null,
  };
}

class GreetingAI implements AIProvider {
  readonly providerId = 'scripted-test-ai';
  constructor(private readonly raw: unknown) {}
  async understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    return this.raw as AIUnderstandingResult;
  }
  async generateResponse() {
    return { message: GREETING, askForField: null };
  }
}

describe('journey intelligence: A se B jaana hai kal', () => {
  it('NLU reads origin, destination and kal from the screenshot sentence', async () => {
    const det = new DeterministicNLUProvider();
    const r = await det.understand({
      userMessage: JOURNEY,
      conversation: freshContext(),
      availableIntents: [],
      availableTools: [],
    });
    expect(r.intent).toBe('BOOK_TRAIN');
    expect(r.slots.originQuery?.toLowerCase()).toMatch(/amritsar/);
    expect(r.slots.destinationQuery?.toLowerCase()).toMatch(/patna/);
    expect(r.slots.dateText).toBe('kal');
  });

  it('deterministic path does not greet — searches or asks which Patna station', async () => {
    const harness = createHarness({}, { stations: [...STATION_INDEX, PNBE, PPTA, RJPB] });
    const turn = await run(harness, freshContext(), JOURNEY);
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.reply).not.toMatch(/Namaste|railway assistant|travel details/i);
    expect(turn.context.origin?.code).toBe(ASR.code);
    expect(turn.context.journeyDate).toBeTruthy();
    const askedStation = /multiple stations|PNBE|Patna Jn|chip/i.test(turn.reply);
    const searched = turn.executedTools.includes('searchTrains');
    expect(askedStation || searched).toBe(true);
  });

  it('NVIDIA greeting cannot replace a real journey — template/search wins', async () => {
    const harness = createHarness({}, { stations: [...STATION_INDEX, PNBE, PPTA, RJPB] });
    const turn = await run(
      harness,
      freshContext(),
      JOURNEY,
      {
        ai: new GreetingAI({
          intent: 'BOOK_TRAIN',
          confidence: 0.95,
          slots: {
            ...emptySlots(),
            originQuery: 'amritsar jn',
            destinationQuery: 'patna',
            dateText: 'kal',
          },
          missingFields: [],
          toolRequest: null,
        }),
      },
    );
    expect(turn.intent).toBe('BOOK_TRAIN');
    expect(turn.reply).not.toMatch(/Namaste|travel details \(date, class, passenger/i);
    expect(turn.reply).not.toBe(GREETING);
    expect(turn.context.journeyDate).toBeTruthy();
  });

  it('even when the model forgets dateText, kal on the message is kept', async () => {
    const harness = createHarness({}, { stations: [...STATION_INDEX, PNBE, PPTA, RJPB] });
    const turn = await run(
      harness,
      freshContext(),
      JOURNEY,
      {
        ai: new GreetingAI({
          intent: 'BOOK_TRAIN',
          confidence: 0.9,
          slots: {
            ...emptySlots(),
            originQuery: 'amritsar jn',
            destinationQuery: 'patna',
          },
          missingFields: [],
          toolRequest: null,
        }),
      },
    );
    expect(turn.context.journeyDate).toBeTruthy();
    expect(turn.reply).not.toMatch(/Kis date ko jaana hai/i);
  });
});
