/**
 * Deterministic mock AI provider — used by tests and local development.
 * It performs ZERO network calls and NEVER fabricates railway information:
 * it honestly reports intent UNKNOWN and an honest "not implemented" reply.
 */

import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
} from '../shared/index.js';
import type { AIProvider } from './AIProvider.js';

const REPLY =
  'AI orchestration is not implemented yet (Step 1 foundation). I therefore cannot answer railway questions — I never guess train, fare, availability or PNR information.';

export class MockAIProvider implements AIProvider {
  readonly providerId = 'mock';

  understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    return Promise.resolve({
      intent: 'UNKNOWN',
      confidence: 0,
      slots: {
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
      },
      missingFields: [],
      toolRequest: null,
    });
  }

  generateResponse(_input: AIReplyInput): Promise<AIReplyResult> {
    return Promise.resolve({ message: REPLY, askForField: null });
  }
}
