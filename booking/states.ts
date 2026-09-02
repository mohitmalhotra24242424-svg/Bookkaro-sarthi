/**
 * Booking state machine — authoritative table lives in shared/bookingFlow.ts
 * (single source of truth, usable by both the booking guards and the ai/
 * orchestrator without breaking layer boundaries). This module re-exports it.
 */

export {
  BOOKING_STAGES,
  BOOKING_FLOW_STAGES,
  BOOKING_STAGE_TRANSITIONS,
  allBookingStages,
  canTransitionTo,
  isBookingStage,
  isTerminalBookingStage,
} from '../shared/bookingFlow.js';
export type { BookingStage } from '../shared/bookingFlow.js';
