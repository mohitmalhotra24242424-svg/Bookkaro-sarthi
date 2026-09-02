/**
 * In-memory booking-draft store. A DRAFT is pure data — no booking, no money.
 * (No database exists yet; this keeps drafts per running server process.)
 */

import { createEmptyBookingDraft } from '../../booking/drafts.js';
import type { BookingDraft } from '../../shared/index.js';

export interface BookingDraftStore {
  create(input: { conversationId: string; userId: string }): BookingDraft;
  get(draftId: string): BookingDraft | null;
  update(draftId: string, patch: Partial<BookingDraft>): BookingDraft | null;
}

export function createInMemoryDraftStore(): BookingDraftStore {
  const drafts = new Map<string, BookingDraft>();
  return {
    create(input) {
      const draft = createEmptyBookingDraft({ conversationId: input.conversationId, userId: input.userId });
      drafts.set(draft.id, draft);
      return draft;
    },
    get(draftId) {
      return drafts.get(draftId) ?? null;
    },
    update(draftId, patch) {
      const current = drafts.get(draftId);
      if (!current) return null;
      const next: BookingDraft = { ...current, ...patch, updatedAt: new Date().toISOString() };
      drafts.set(draftId, next);
      return next;
    },
  };
}
