/** Booking domain contracts. Booking execution itself is NOT IMPLEMENTED in Step 1. */

import type { Fare, QuotaCode, TravelClassCode } from './railway.js';

// The authoritative state machine now lives in shared/bookingFlow.ts.
export {
  BOOKING_STAGES,
  BOOKING_FLOW_STAGES,
  isBookingStage,
  canTransitionTo,
  isTerminalBookingStage,
  allBookingStages,
  BOOKING_STAGE_TRANSITIONS,
} from '../bookingFlow.js';
import type { BookingStage } from '../bookingFlow.js';

export type BookingDraftStatus =
  | 'OPEN'
  | 'AWAITING_CONFIRMATION'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'CANCELLED';

/** Proof of the mandatory explicit user confirmation before execution. */
export interface BookingConfirmation {
  method: 'EXPLICIT_USER_ACTION';
  confirmedByUserId: string;
  confirmedAt: string;
  utterance: string | null;
}

export interface BookingDraft {
  id: string;
  conversationId: string;
  userId: string;
  originCode: string | null;
  destinationCode: string | null;
  journeyDate: string | null;
  trainNumber: string | null;
  travelClass: TravelClassCode | null;
  quota: QuotaCode;
  passengerCount: number | null;
  /** Must be a verified provider quote — fares are never invented. */
  fareQuote: Fare | null;
  stage: BookingStage;
  status: BookingDraftStatus;
  confirmation: BookingConfirmation | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/** Conversational passenger detail (Step 5 §9). */
export interface PassengerDetail {
  name: string;
  age: number | null;
  /** M | F | T (transgender) — null when not provided. */
  gender: 'M' | 'F' | 'T' | null;
  berthPreference: string | null;
}

export type BookingStatus = 'CONFIRMED' | 'PARTIALLY_CANCELLED' | 'CANCELLED' | 'FAILED' | 'UNKNOWN';

export interface Booking {
  id: string;
  draftId: string;
  userId: string;
  /** ALWAYS null in Step 5 — no real PNR is ever generated (mock bookings stay PNR-less). */
  pnr: string | null;
  trainNumber: string | null;
  journeyDate: string | null;
  status: BookingStatus;
  totalChargedMinor: number | null;
  currency: 'INR';
  providerSource: 'RAILCORE' | 'RAILKIT' | null;
  /** true for Step-5 mock bookings — clearly a DEMO record, never a real railway ticket. */
  isDemo?: boolean;
  createdAt: string;
}
