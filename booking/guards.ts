/**
 * BOOKING SAFETY GUARDS.
 *
 * The single most important rule of this project:
 *   The AI may guide a booking conversation all the way to
 *   WAITING_CONFIRMATION — but ONLY deterministic server code, after a valid
 *   EXPLICIT user confirmation and a verified provider fare quote, may enter
 *   BOOKING_EXECUTION. There is no code path where the AI executes a booking.
 */

import type { BookingConfirmation, BookingDraft } from '../shared/index.js';

export type BookingActor = 'AI' | 'USER' | 'SERVER';

export type BookingExecutionDenyReason =
  | 'AI_CANNOT_EXECUTE_BOOKING'
  | 'USER_CANNOT_EXECUTE_BOOKING'
  | 'DRAFT_NOT_AWAITING_CONFIRMATION'
  | 'MISSING_EXPLICIT_CONFIRMATION'
  | 'FARE_NOT_VERIFIED'
  | 'DRAFT_EXPIRED';

export type BookingExecutionDecision =
  | { allowed: true }
  | { allowed: false; reason: BookingExecutionDenyReason; message: string };

export interface BookingExecutionRequest {
  actor: BookingActor;
  draft: BookingDraft;
  confirmation: BookingConfirmation | null;
  now?: string;
}

export const BOOKING_SAFETY_RULES: readonly string[] = [
  'BOOKING_EXECUTION is reachable only from WAITING_CONFIRMATION and only by SERVER code.',
  'Execution requires a valid explicit user confirmation (method EXPLICIT_USER_ACTION + confirmedByUserId).',
  'Execution requires a fare quote VERIFIED by a provider (source + total present) — fares are never invented.',
  'The AI may never call confirmBooking and may never transition into BOOKING_EXECUTION or BOOKING_RESULT.',
  'A draft is not a booking; no money moves before execution completes in deterministic code.',
];

export function evaluateBookingExecution(request: BookingExecutionRequest): BookingExecutionDecision {
  const { actor, draft, confirmation } = request;
  const now = request.now ?? new Date().toISOString();

  if (actor === 'AI') {
    return {
      allowed: false,
      reason: 'AI_CANNOT_EXECUTE_BOOKING',
      message: 'AI may assist a booking but can never execute one. Execution is server-only.',
    };
  }
  if (actor === 'USER') {
    return {
      allowed: false,
      reason: 'USER_CANNOT_EXECUTE_BOOKING',
      message: 'Users confirm; deterministic server code executes. No direct user-side execution.',
    };
  }
  if (draft.stage !== 'WAITING_CONFIRMATION' || draft.status !== 'AWAITING_CONFIRMATION') {
    return {
      allowed: false,
      reason: 'DRAFT_NOT_AWAITING_CONFIRMATION',
      message: `Draft must be at WAITING_CONFIRMATION/AWAITING_CONFIRMATION (got ${draft.stage}/${draft.status}).`,
    };
  }
  if (
    !confirmation ||
    confirmation.method !== 'EXPLICIT_USER_ACTION' ||
    !confirmation.confirmedByUserId ||
    confirmation.confirmedByUserId !== draft.userId
  ) {
    return {
      allowed: false,
      reason: 'MISSING_EXPLICIT_CONFIRMATION',
      message: 'Booking execution requires an explicit confirmation by the draft owner.',
    };
  }
  const fare = draft.fareQuote;
  if (!fare || !fare.source || fare.breakdown.totalMinor === null || fare.breakdown.totalMinor <= 0) {
    return {
      allowed: false,
      reason: 'FARE_NOT_VERIFIED',
      message: 'Fare must be a verified provider quote (source + positive total) before execution.',
    };
  }
  if (draft.expiresAt !== null && draft.expiresAt < now) {
    return {
      allowed: false,
      reason: 'DRAFT_EXPIRED',
      message: 'The booking draft expired — the user must restart the fare review.',
    };
  }
  return { allowed: true };
}

/**
 * Stage-transition permission by actor. The AI can drive every conversational
 * stage but can NEVER enter BOOKING_EXECUTION or BOOKING_RESULT.
 */
export function canActorTransitionBookingStage(
  actor: BookingActor,
  from: import('../shared/index.js').BookingStage,
  to: import('../shared/index.js').BookingStage,
  transitions: (from: import('../shared/index.js').BookingStage, to: import('../shared/index.js').BookingStage) => boolean,
): boolean {
  if (!transitions(from, to)) return false;
  if (to === 'BOOKING_EXECUTION' || to === 'BOOKING_RESULT') return actor === 'SERVER';
  return true;
}
