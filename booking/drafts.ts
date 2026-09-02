/** BookingDraft factory — drafts are data only; nothing here books anything. */

import { newId } from '../shared/index.js';
import type { BookingDraft } from '../shared/index.js';

export interface CreateBookingDraftInput {
  conversationId: string;
  userId: string;
  now?: string;
}

export function createEmptyBookingDraft(input: CreateBookingDraftInput): BookingDraft {
  const now = input.now ?? new Date().toISOString();
  return {
    id: newId('draft'),
    conversationId: input.conversationId,
    userId: input.userId,
    originCode: null,
    destinationCode: null,
    journeyDate: null,
    trainNumber: null,
    travelClass: null,
    quota: 'GN',
    passengerCount: null,
    fareQuote: null,
    stage: 'COLLECT_JOURNEY',
    status: 'OPEN',
    confirmation: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  };
}
