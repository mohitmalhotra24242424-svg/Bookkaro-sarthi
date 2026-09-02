/** Shared helper for the Step-6 suites (journey context builder). */

import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';
import { ASR, LDH, makeSearchResults } from './harness.js';

let cached: ConversationContext | null = null;

export function contextWithJourney(): ConversationContext {
  if (cached) return cached;
  const harness0 = makeSearchResults();
  let context: ConversationContext = {
    id: 'conv-journey',
    userId: 'user-1',
    origin: ASR,
    destination: LDH,
    journeyDate: '2026-08-27',
    passengerCount: 2,
    selectedTrain: harness0[0]!.train,
    selectedClass: 'CC',
    selectedQuota: 'GN',
    lastSearchResults: harness0,
    lastAskedField: null,
    bookingStage: 'CLASS_SELECTED',
    lastIntent: 'BOOK_TRAIN',
    lastTool: null,
    pendingQuestion: null,
    userCorrections: [],
    pausedBooking: null,
    stationChoices: null,
    passengers: [],
    passengerDraft: null,
    lastAvailability: null,
    lastFareQuote: null,
    lastToolResult: null,
    lastReferencedTrain: null,
    pendingFastestHint: false,
    messages: [],
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
  };
  context = setContextSlots(context, {}, 'FILL_MISSING');
  context = setSearchResults(context, harness0);
  cached = context;
  return context;
}
