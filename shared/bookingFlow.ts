/**
 * DETERMINISTIC BOOKING STATE MACHINE (authoritative).
 *
 * The Step-5 flow states map onto the conversation stages:
 *   SEARCH_REQUIRED ≙ COLLECT_JOURNEY · SEARCH_RESULTS · TRAIN_SELECTED
 *   (class question asked in TRAIN_SELECTED ≙ CLASS_REQUIRED) · CLASS_SELECTED
 *   AVAILABILITY_CHECK ≙ AVAILABILITY_CHECKED · PASSENGER_DETAILS_REQUIRED
 *   FARE_REVIEW · FINAL_CONFIRMATION ≙ WAITING_CONFIRMATION ·
 *   CONFIRMED / FAILED / CANCELLED (terminal, → IDLE).
 *
 * AI cannot jump states arbitrarily: every transition must be allowed HERE
 * (shared so the ai/ orchestrator can enforce it without importing booking/).
 */

export const BOOKING_STAGES = [
  'IDLE',
  'COLLECT_JOURNEY',
  'SEARCH_RESULTS',
  'TRAIN_SELECTED',
  'CLASS_SELECTED',
  'AVAILABILITY_CHECKED',
  'PASSENGER_DETAILS_REQUIRED',
  'FARE_REVIEW',
  'WAITING_CONFIRMATION',
  'BOOKING_EXECUTION',
  'BOOKING_RESULT',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
] as const;

export type BookingStage = (typeof BOOKING_STAGES)[number];

export function isBookingStage(value: unknown): value is BookingStage {
  return typeof value === 'string' && (BOOKING_STAGES as readonly string[]).includes(value);
}

export const BOOKING_FLOW_STAGES: readonly BookingStage[] = [
  'COLLECT_JOURNEY',
  'SEARCH_RESULTS',
  'TRAIN_SELECTED',
  'CLASS_SELECTED',
  'AVAILABILITY_CHECKED',
  'PASSENGER_DETAILS_REQUIRED',
  'FARE_REVIEW',
  'WAITING_CONFIRMATION',
  'BOOKING_EXECUTION',
  'BOOKING_RESULT',
];

export const BOOKING_STAGE_TRANSITIONS: Readonly<Record<BookingStage, readonly BookingStage[]>> = {
  IDLE: ['COLLECT_JOURNEY'],
  COLLECT_JOURNEY: ['SEARCH_RESULTS', 'IDLE'],
  SEARCH_RESULTS: ['TRAIN_SELECTED', 'COLLECT_JOURNEY', 'IDLE'],
  TRAIN_SELECTED: ['CLASS_SELECTED', 'SEARCH_RESULTS', 'IDLE'],
  CLASS_SELECTED: ['AVAILABILITY_CHECKED', 'FARE_REVIEW', 'TRAIN_SELECTED', 'SEARCH_RESULTS', 'PASSENGER_DETAILS_REQUIRED', 'IDLE'],
  AVAILABILITY_CHECKED: ['FARE_REVIEW', 'PASSENGER_DETAILS_REQUIRED', 'CLASS_SELECTED', 'SEARCH_RESULTS', 'IDLE'],
  PASSENGER_DETAILS_REQUIRED: ['FARE_REVIEW', 'AVAILABILITY_CHECKED', 'CLASS_SELECTED', 'SEARCH_RESULTS', 'IDLE'],
  FARE_REVIEW: ['WAITING_CONFIRMATION', 'PASSENGER_DETAILS_REQUIRED', 'AVAILABILITY_CHECKED', 'SEARCH_RESULTS', 'IDLE'],
  WAITING_CONFIRMATION: ['BOOKING_EXECUTION', 'FARE_REVIEW', 'SEARCH_RESULTS', 'CONFIRMED', 'FAILED', 'CANCELLED', 'IDLE'],
  BOOKING_EXECUTION: ['BOOKING_RESULT', 'FAILED'],
  BOOKING_RESULT: ['IDLE', 'CONFIRMED', 'FAILED'],
  CONFIRMED: ['IDLE'],
  FAILED: ['IDLE'],
  CANCELLED: ['IDLE'],
};

export function canTransitionTo(from: BookingStage, to: BookingStage): boolean {
  return BOOKING_STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalBookingStage(stage: BookingStage): boolean {
  return stage === 'CONFIRMED' || stage === 'FAILED' || stage === 'CANCELLED' || stage === 'BOOKING_RESULT';
}

export function allBookingStages(): readonly BookingStage[] {
  return BOOKING_STAGES;
}
