import { describe, expect, it } from 'vitest';
import {
  BOOKING_STAGE_TRANSITIONS,
  BOOKING_SAFETY_RULES,
  allBookingStages,
  canTransitionTo,
  canActorTransitionBookingStage,
  evaluateBookingExecution,
} from '../booking/index.js';
import type { BookingConfirmation, BookingDraft, Fare } from '../shared/index.js';

const VERIFIED_FARE: Fare = {
  trainNumber: '12014',
  fromStationCode: 'ASR',
  toStationCode: 'LDH',
  journeyDate: '2026-08-27',
  travelClass: 'CC',
  quota: 'GN',
  currency: 'INR',
  breakdown: {
    baseFareMinor: 20000,
    reservationChargeMinor: 2000,
    superfastChargeMinor: 1500,
    dynamicFareMinor: null,
    cateringChargeMinor: 1500,
    gstMinor: 1000,
    totalMinor: 26000,
  },
  source: 'RAILCORE',
  retrievedAt: '2026-08-26T00:00:00.000Z',
};

const CONFIRMATION: BookingConfirmation = {
  method: 'EXPLICIT_USER_ACTION',
  confirmedByUserId: 'user-1',
  confirmedAt: '2026-08-26T09:00:00.000Z',
  utterance: 'haan, confirm karo',
};

function makeDraft(overrides: Partial<BookingDraft> = {}): BookingDraft {
  return {
    id: 'draft-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    originCode: 'ASR',
    destinationCode: 'LDH',
    journeyDate: '2026-08-27',
    trainNumber: '12014',
    travelClass: 'CC',
    quota: 'GN',
    passengerCount: 2,
    fareQuote: VERIFIED_FARE,
    stage: 'WAITING_CONFIRMATION',
    status: 'AWAITING_CONFIRMATION',
    confirmation: CONFIRMATION,
    createdAt: '2026-08-26T08:00:00.000Z',
    updatedAt: '2026-08-26T09:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('booking state machine', () => {
  it('defines all required stages (Step 5 machine: journey → passengers → review → confirm/outcome)', () => {
    expect(allBookingStages()).toEqual([
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
    ]);
  });

  it('Step-5 additions: passenger + outcome stages with legal transitions only', () => {
    expect(canTransitionTo('AVAILABILITY_CHECKED', 'PASSENGER_DETAILS_REQUIRED')).toBe(true);
    expect(canTransitionTo('FARE_REVIEW', 'PASSENGER_DETAILS_REQUIRED')).toBe(true);
    expect(canTransitionTo('PASSENGER_DETAILS_REQUIRED', 'FARE_REVIEW')).toBe(true);
    expect(canTransitionTo('WAITING_CONFIRMATION', 'CONFIRMED')).toBe(true);
    expect(canTransitionTo('WAITING_CONFIRMATION', 'FAILED')).toBe(true);
    expect(canTransitionTo('WAITING_CONFIRMATION', 'CANCELLED')).toBe(true);
    expect(canTransitionTo('CONFIRMED', 'IDLE')).toBe(true);
    // illegal jumps stay illegal
    expect(canTransitionTo('SEARCH_RESULTS', 'WAITING_CONFIRMATION')).toBe(false);
    expect(canTransitionTo('COLLECT_JOURNEY', 'CONFIRMED')).toBe(false);
    expect(canTransitionTo('CONFIRMED', 'FARE_REVIEW')).toBe(false);
  });

  it('allows the full happy path: journey → … → confirmation → execution → result', () => {
    const happyPath: [string, string][] = [
      ['IDLE', 'COLLECT_JOURNEY'],
      ['COLLECT_JOURNEY', 'SEARCH_RESULTS'],
      ['SEARCH_RESULTS', 'TRAIN_SELECTED'],
      ['TRAIN_SELECTED', 'CLASS_SELECTED'],
      ['CLASS_SELECTED', 'AVAILABILITY_CHECKED'],
      ['AVAILABILITY_CHECKED', 'FARE_REVIEW'],
      ['FARE_REVIEW', 'WAITING_CONFIRMATION'],
      ['WAITING_CONFIRMATION', 'BOOKING_EXECUTION'],
      ['BOOKING_EXECUTION', 'BOOKING_RESULT'],
    ];
    for (const [from, to] of happyPath) {
      expect(canTransitionTo(from as never, to as never), `${from} → ${to}`).toBe(true);
    }
  });

  it('rejects skipping stages (e.g. straight to execution)', () => {
    expect(canTransitionTo('COLLECT_JOURNEY', 'TRAIN_SELECTED')).toBe(false);
    expect(canTransitionTo('SEARCH_RESULTS', 'FARE_REVIEW')).toBe(false);
    expect(canTransitionTo('FARE_REVIEW', 'BOOKING_EXECUTION')).toBe(false); // must pass WAITING_CONFIRMATION
    expect(canTransitionTo('BOOKING_RESULT', 'COLLECT_JOURNEY')).toBe(false);
    expect(canTransitionTo('IDLE', 'BOOKING_EXECUTION')).toBe(false);
  });

  it('allows going back / cancelling before execution, but never out of execution', () => {
    expect(canTransitionTo('TRAIN_SELECTED', 'SEARCH_RESULTS')).toBe(true);
    expect(canTransitionTo('FARE_REVIEW', 'SEARCH_RESULTS')).toBe(true);
    expect(canTransitionTo('WAITING_CONFIRMATION', 'IDLE')).toBe(true);
    expect(canTransitionTo('BOOKING_EXECUTION', 'IDLE')).toBe(false);
  });

  it('every stage has a defined transition table entry', () => {
    for (const stage of allBookingStages()) {
      expect(BOOKING_STAGE_TRANSITIONS[stage], stage).toBeDefined();
    }
  });
});

describe('booking execution guards', () => {
  const now = '2026-08-26T10:00:00.000Z';

  it('the AI can NEVER execute a booking — even with a perfect draft and confirmation', () => {
    const decision = evaluateBookingExecution({ actor: 'AI', draft: makeDraft(), confirmation: CONFIRMATION, now });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('AI_CANNOT_EXECUTE_BOOKING');
  });

  it('users confirm but never execute directly', () => {
    const decision = evaluateBookingExecution({ actor: 'USER', draft: makeDraft(), confirmation: CONFIRMATION, now });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('USER_CANNOT_EXECUTE_BOOKING');
  });

  it('server needs an explicit user confirmation owned by the draft owner', () => {
    const noConfirmation = evaluateBookingExecution({ actor: 'SERVER', draft: makeDraft({ confirmation: null }), confirmation: null, now });
    expect(noConfirmation.allowed).toBe(false);
    expect(noConfirmation.allowed === false && noConfirmation.reason).toBe('MISSING_EXPLICIT_CONFIRMATION');

    const wrongUser: BookingConfirmation = { ...CONFIRMATION, confirmedByUserId: 'someone-else' };
    const foreign = evaluateBookingExecution({ actor: 'SERVER', draft: makeDraft(), confirmation: wrongUser, now });
    expect(foreign.allowed).toBe(false);
    expect(foreign.allowed === false && foreign.reason).toBe('MISSING_EXPLICIT_CONFIRMATION');
  });

  it('server can only execute a draft waiting for confirmation', () => {
    const early = evaluateBookingExecution({
      actor: 'SERVER',
      draft: makeDraft({ stage: 'CLASS_SELECTED', status: 'OPEN' }),
      confirmation: CONFIRMATION,
      now,
    });
    expect(early.allowed).toBe(false);
    expect(early.allowed === false && early.reason).toBe('DRAFT_NOT_AWAITING_CONFIRMATION');
  });

  it('server needs a VERIFIED fare quote — invented or incomplete fares block execution', () => {
    const noFare = evaluateBookingExecution({ actor: 'SERVER', draft: makeDraft({ fareQuote: null }), confirmation: CONFIRMATION, now });
    expect(noFare.allowed).toBe(false);
    expect(noFare.allowed === false && noFare.reason).toBe('FARE_NOT_VERIFIED');

    const unsourcedFare = evaluateBookingExecution({
      actor: 'SERVER',
      draft: makeDraft({ fareQuote: { ...VERIFIED_FARE, source: null } }),
      confirmation: CONFIRMATION,
      now,
    });
    expect(unsourcedFare.allowed).toBe(false);
    expect(unsourcedFare.allowed === false && unsourcedFare.reason).toBe('FARE_NOT_VERIFIED');

    const noTotal = evaluateBookingExecution({
      actor: 'SERVER',
      draft: makeDraft({ fareQuote: { ...VERIFIED_FARE, breakdown: { ...VERIFIED_FARE.breakdown, totalMinor: null } } }),
      confirmation: CONFIRMATION,
      now,
    });
    expect(noTotal.allowed).toBe(false);
    expect(noTotal.allowed === false && noTotal.reason).toBe('FARE_NOT_VERIFIED');
  });

  it('expired drafts cannot be executed', () => {
    const decision = evaluateBookingExecution({
      actor: 'SERVER',
      draft: makeDraft({ expiresAt: '2026-01-01T00:00:00.000Z' }),
      confirmation: CONFIRMATION,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('DRAFT_EXPIRED');
  });

  it('the one allowed path: SERVER + waiting draft + explicit confirmation + verified fare', () => {
    const decision = evaluateBookingExecution({ actor: 'SERVER', draft: makeDraft(), confirmation: CONFIRMATION, now });
    expect(decision.allowed).toBe(true);
  });

  it('stage transitions into execution/result are SERVER-only for every actor check', () => {
    expect(canActorTransitionBookingStage('AI', 'WAITING_CONFIRMATION', 'BOOKING_EXECUTION', canTransitionTo)).toBe(false);
    expect(canActorTransitionBookingStage('USER', 'WAITING_CONFIRMATION', 'BOOKING_EXECUTION', canTransitionTo)).toBe(false);
    expect(canActorTransitionBookingStage('SERVER', 'WAITING_CONFIRMATION', 'BOOKING_EXECUTION', canTransitionTo)).toBe(true);
    expect(canActorTransitionBookingStage('SERVER', 'BOOKING_EXECUTION', 'BOOKING_RESULT', canTransitionTo)).toBe(true);
    expect(canActorTransitionBookingStage('AI', 'COLLECT_JOURNEY', 'SEARCH_RESULTS', canTransitionTo)).toBe(true);
  });

  it('documents its safety rules', () => {
    expect(BOOKING_SAFETY_RULES.length).toBeGreaterThanOrEqual(5);
    expect(BOOKING_SAFETY_RULES.join(' ')).toMatch(/AI/i);
  });
});
