/** Core conversation contracts — the backbone of multi-turn, interruptible AI conversations. */

import type { Intent } from './intent.js';
import type { Station, Train, TrainSearchResult, TravelClassCode } from './railway.js';
import type { ToolName } from './tools.js';
import type { PassengerDetail } from './booking.js';
import type { BookingStage } from '../bookingFlow.js';
import type { QuotaCode } from './railway.js';
import type { Availability, Fare } from './railway.js';

export interface User {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  preferredLanguage: string;
  createdAt: string;
}

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  intent: Intent | null;
  toolName: ToolName | null;
}

/** Slot fields filled progressively over multiple turns (journey details etc.). */
export type ContextSlotField =
  | 'origin'
  | 'destination'
  | 'journeyDate'
  | 'passengerCount'
  | 'selectedTrain'
  | 'selectedClass'
  | 'passengerName'
  | 'passengerAge'
  | 'passengerGender'
  | 'passengerBerth'
  | 'waitlistConsent';

/** Pending station-choice disambiguation ("Delhi" matched several stations). */
export interface StationChoicePending {
  field: ContextSlotField; // 'origin' | 'destination'
  options: readonly Station[];
  askedAt: string;
}

/** One provider-verified station candidate — never invented by the AI. */
export interface StationResolutionCandidate {
  name: string;
  code: string;
  verified: true;
}

/**
 * Pending automatic station disambiguation (Step: station-lookup automation).
 * Persisted on context so the interrupted railway request (SEARCH_TRAINS /
 * BOOK_TRAIN / GET_AVAILABILITY / GET_FARE) survives the clarification and can
 * resume WITHOUT re-asking already-known slots.
 */
export interface PendingStationResolution {
  field: 'origin' | 'destination';
  originalInput: string;
  candidates: readonly StationResolutionCandidate[];
  askedAt: string;
}

/**
 * A time-of-day filter the user applied to a train search (\"subah/morning ki
 * trains\", \"4am se 6am ke beech chahiye\"). Stored on context so it survives
 * station disambiguation / date collection and is applied when the search runs.
 * `kind` is either a named day-part (morning/afternoon/evening/night) or an
 * explicit clock-window (fromMin..toMin, inclusive..exclusive, 0-1439 minutes).
 */
export interface SearchFilterHint {
  /** The original user wording (for honest rephrasing). */
  source: string;
  kind: 'dayPart' | 'timeWindow';
  dayPart?: 'morning' | 'afternoon' | 'evening' | 'night';
  fromMin?: number;
  toMin?: number;
}

/** Audit entry recorded when the user CORRECTS an already-filled slot. */
export interface ContextCorrection {
  field: ContextSlotField;
  previousValue: unknown;
  newValue: unknown;
  correctedAt: string;
}

/**
 * Snapshot of an in-flight booking saved when the user interrupts the flow
 * (e.g. asks "12014 ka live status batao" mid-booking). The orchestrator can
 * restore it later so "Kal jaana hai" resumes the original booking context.
 */
export interface PausedBookingSnapshot {
  pausedAtStage: BookingStage;
  pausedAt: string;
  reason: 'USER_INTERRUPTION' | 'SERVER_REQUESTED';
  slots: PausedBookingSlots;
  lastSearchResults: readonly TrainSearchResult[] | null;
  pendingQuestion: string | null;
}

export interface PausedBookingSlots {
  origin: Station | null;
  destination: Station | null;
  journeyDate: string | null;
  passengerCount: number | null;
  selectedTrain: Train | null;
  selectedClass: TravelClassCode | null;
}

/** A READ data-intent paused to collect the route (GET_AVAILABILITY / GET_FARE). */
export interface PendingDataRoute {
  intent: 'GET_AVAILABILITY' | 'GET_FARE';
  /** Train the user asked about — snapshot so it survives the route-ask. */
  trainNumber: string;
  /** Class already stated (if any). */
  travelClass: TravelClassCode | null;
  /** Resolved journey date already known (if any). */
  journeyDate: string | null;
  /** Which endpoint is still missing (either may be set already in context). */
  missingOrigin: boolean;
  missingDestination: boolean;
  /** The other endpoint's lookup query, persisted so a station-disfigureation of one side keeps the other. */
  originQuery: string | null;
  destinationQuery: string | null;
}

export interface ConversationContext {
  id: string;
  userId: string;

  // ── journey slots (multi-turn memory) ──
  origin: Station | null;
  destination: Station | null;
  journeyDate: string | null;
  passengerCount: number | null;
  selectedTrain: Train | null;
  selectedClass: TravelClassCode | null;
  selectedQuota: QuotaCode | null;
  lastSearchResults: readonly TrainSearchResult[] | null;

  // ── conversation state ──
  lastAskedField: ContextSlotField | null;
  bookingStage: BookingStage;
  lastIntent: Intent | null;
  lastTool: ToolName | null;
  pendingQuestion: string | null;

  // ── interrupt/resume foundation ──
  userCorrections: readonly ContextCorrection[];
  pausedBooking: PausedBookingSnapshot | null;

  // ── Step 4: pending station disambiguation ──
  stationChoices: StationChoicePending | null;

  // ── Step 10: automatic station-lookup resolution pending ──
  /** Pending verified candidates awaiting the user's station choice (automatic lookup). */
  pendingStationResolution: PendingStationResolution | null;

  // ── Step 9: semantic planner pending resume (station disambiguation) ──
  /** JSON-safe snapshot of the interrupted semantic plan awaiting a station choice. */
  pendingSemanticPlan: Record<string, unknown> | null;

  // ── Step 5: conversational booking flow ──
  /** Collected passenger details (name/age/gender/berth), one at a time. */
  passengers: readonly PassengerDetail[];
  /** In-progress passenger being collected. */
  passengerDraft: PassengerDetail | null;
  /** Last VERIFIED availability for the current selection (invalidated on any change). */
  lastAvailability: Availability | null;
  /** Last VERIFIED fare quote for the current selection (invalidated on any change). */
  lastFareQuote: Fare | null;
  /** Compact envelope of the last executed tool ({success, tool, provider, error, timestamp} — no raw payloads, no secrets). */
  lastToolResult: { success: boolean; tool: string; provider: string | null; error: string | null; timestamp: string } | null;
  /** Most recently DISCUSSED train (result-detail answers, data follow-ups) — "uska fare?" resolves here. */
  lastReferencedTrain: Train | null;
  /** A "fastest/kaunsi" clause awaiting the search that was blocked on a missing date. */
  pendingFastestHint: boolean;
  /**
   * A READ data-intent (GET_AVAILABILITY / GET_FARE) that paused to ask for a
   * route. Snapshots the train (and class it already collected) so the follow-up
   * "Amritsar se Saharanpur" can complete the SAME request — not lose the train.
   */
  pendingDataRoute: PendingDataRoute | null;
  /** A time-of-day/window filter awaiting the search (persisted across station/date turns). */
  pendingSearchFilter: SearchFilterHint | null;
  /** User already said haan to booking on WAITLIST/RAC for this selection. */
  waitlistAccepted: boolean;

  // ── transcript ──
  messages: readonly ConversationMessage[];

  createdAt: string;
  updatedAt: string;
}
