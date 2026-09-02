import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BOOKING_FLOW_STAGES,
  QUOTAS,
  TRAVEL_CLASSES,
  isZeroResult,
  providerEmpty,
  providerFailure,
  providerSuccess,
  assertFactNeverFabricated,
  isVerifiedFact,
  unavailableFact,
  unknownFact,
  verifiedFact,
} from '../shared/index.js';
import type {
  Availability,
  BookingDraft,
  ConversationContext,
  Fare,
  FareBreakdown,
  Intent,
  LiveStatus,
  PNRStatus,
  PNRStatusLevel,
  ProviderEmpty,
  ProviderFailure,
  ProviderResult,
  ProviderSuccess,
  Station,
  ToolName,
  ToolResult,
  Train,
  User,
  Wallet,
  WalletTransaction,
} from '../shared/index.js';

describe('shared types: nullability & honest UNKNOWN/UNAVAILABLE states', () => {
  it('exposes all core domain contracts at compile time', () => {
    expectTypeOf<User>().toMatchTypeOf<object>();
    expectTypeOf<ConversationContext>().toMatchTypeOf<object>();
    expectTypeOf<Station>().toMatchTypeOf<object>();
    expectTypeOf<Train>().toMatchTypeOf<object>();
    expectTypeOf<Availability>().toMatchTypeOf<object>();
    expectTypeOf<Fare>().toMatchTypeOf<object>();
    expectTypeOf<LiveStatus>().toMatchTypeOf<object>();
    expectTypeOf<BookingDraft>().toMatchTypeOf<object>();
    expectTypeOf<Wallet>().toMatchTypeOf<object>();
    expectTypeOf<WalletTransaction>().toMatchTypeOf<object>();
  });

  it('every provider-optional field is nullable — missing data is never faked as a value', () => {
    expectTypeOf<Station['zone']>().toEqualTypeOf<string | null>();
    expectTypeOf<Availability['availableCount']>().toEqualTypeOf<number | null>();
    expectTypeOf<Availability['status']>().toEqualTypeOf<'AVAILABLE' | 'RAC' | 'WAITLIST' | 'REGRET' | 'UNAVAILABLE'>();
    expectTypeOf<FareBreakdown['totalMinor']>().toEqualTypeOf<number | null>();
    expectTypeOf<Fare['source']>().toEqualTypeOf<'RAILCORE' | 'RAILKIT' | null>();
    expectTypeOf<LiveStatus['delayMinutes']>().toEqualTypeOf<number | null>();
    expectTypeOf<LiveStatus['status']>().toEqualTypeOf<
      'RUNNING' | 'ON_TIME' | 'DELAYED' | 'ARRIVED' | 'NOT_STARTED' | 'AT_STATION' | 'COMPLETED' | 'CANCELLED' | 'DIVERTED' | 'UNKNOWN'
    >();
    expectTypeOf<Station['name']>().toEqualTypeOf<string | null>();
    expectTypeOf<PNRStatus['overallStatus']>().toEqualTypeOf<PNRStatusLevel>();
    expectTypeOf<BookingDraft['fareQuote']>().toEqualTypeOf<Fare | null>();
    expectTypeOf<ConversationContext['origin']>().toEqualTypeOf<Station | null>();
    expectTypeOf<ConversationContext['journeyDate']>().toEqualTypeOf<string | null>();
    expectTypeOf<Wallet['balanceMinor']>().toEqualTypeOf<number>();
  });

  it('Intent and ToolName vocabularies are exactly the specified unions', () => {
    expectTypeOf<Intent>().toEqualTypeOf<
      | 'BOOK_TRAIN'
      | 'SEARCH_TRAIN'
      | 'LIVE_TRAIN_STATUS'
      | 'GET_AVAILABILITY'
      | 'GET_FARE'
      | 'GET_TRAIN_INFO'
      | 'GET_TIMETABLE'
      | 'LOOKUP_STATION'
      | 'CHECK_PNR'
      | 'VIEW_BOOKINGS'
      | 'VIEW_WALLET'
      | 'GET_CANCELLED_TRAINS'
      | 'COMPARE_TRAINS'
      | 'GENERAL_RAILWAY_QUERY'
      | 'NORMAL_CHAT'
      | 'HELP'
      | 'UNKNOWN'
    >();

    expectTypeOf<ToolName>().toEqualTypeOf<
      | 'searchTrains'
      | 'lookupStation'
      | 'getTrainInfo'
      | 'getTimetable'
      | 'getLiveStatus'
      | 'getAvailability'
      | 'getFare'
      | 'getCancelledTrains'
      | 'checkPNR'
      | 'getBookings'
      | 'getWallet'
      | 'getRailwayKnowledge'
      | 'compareTrains'
      | 'createBookingDraft'
      | 'reviewFare'
      | 'confirmBooking'
      | 'acknowledgeBookingConfirmation'
      | 'executeMockBooking'
    >();
  });

  it('ProviderResult is a discriminated union: success | empty | failure', () => {
    expectTypeOf<ProviderResult<number>>().toEqualTypeOf<ProviderSuccess<number> | ProviderEmpty | ProviderFailure>();
    expectTypeOf<ToolResult['executedBy']>().toEqualTypeOf<'SERVER'>();
  });

  it('booking flow stages match the Step-5 conversational flow', () => {
    expect([...BOOKING_FLOW_STAGES]).toEqual([
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
    ]);
  });

  it('travel class and quota vocabularies include common values (CC, GN)', () => {
    expect(TRAVEL_CLASSES).toContain('CC');
    expect(TRAVEL_CLASSES).toContain('SL');
    expect(TRAVEL_CLASSES).toContain('3A');
    expect(QUOTAS).toContain('GN');
    expect(QUOTAS).toContain('TQ');
  });
});

describe('ProviderResult factories', () => {
  it('success carries source, data and retrieval time', () => {
    const result = providerSuccess('RAILCORE', { code: 'LDH' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('RAILCORE');
    expect(result.data).toEqual({ code: 'LDH' });
    expect(typeof result.retrievedAt).toBe('string');
  });

  it('empty results are successful, data-null and flagged — never a failure', () => {
    const result = providerEmpty('RAILCORE', 'NO_RESULTS');
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
    expect(result.empty).toBe(true);
    expect(result.emptyReason).toBe('NO_RESULTS');
    expect(isZeroResult(result)).toBe(true);
  });

  it('fallback eligibility: transport/unusable failures yes, invalid input / unsupported no', () => {
    expect(providerFailure('TIMEOUT', 't').error.fallbackEligible).toBe(true);
    expect(providerFailure('HTTP_ERROR', '502', { httpStatus: 502 }).error.fallbackEligible).toBe(true);
    expect(providerFailure('PROVIDER_FAILURE', 'success:false').error.fallbackEligible).toBe(true);
    expect(providerFailure('NETWORK_ERROR', 'down').error.fallbackEligible).toBe(true);
    expect(providerFailure('RATE_LIMITED', '429').error.fallbackEligible).toBe(true);
    expect(providerFailure('INVALID_INPUT', 'bad query').error.fallbackEligible).toBe(false);
    expect(providerFailure('UNSUPPORTED_CAPABILITY', 'nope').error.fallbackEligible).toBe(false);
  });
});

describe('fact safety tri-state (RailwayFact)', () => {
  it('VERIFIED facts carry provenance and data', () => {
    const fact = verifiedFact({ code: 'LDH', name: 'Ludhiana' }, 'RAILCORE');
    expect(fact.status).toBe('VERIFIED');
    expect(isVerifiedFact(fact)).toBe(true);
    expect(fact.status === 'VERIFIED' && fact.data.name).toBe('Ludhiana');
    expect(() => assertFactNeverFabricated(fact)).not.toThrow();
  });

  it('UNAVAILABLE / UNKNOWN facts honestly carry no data', () => {
    const unavailable = unavailableFact<Station>('Provider returned no data.');
    const unknown = unknownFact<Station>();
    expect(unavailable.status).toBe('UNAVAILABLE');
    expect(unknown.status).toBe('UNKNOWN');
    expect(isVerifiedFact(unavailable)).toBe(false);
    expect(isVerifiedFact(unknown)).toBe(false);
  });

  it('a VERIFIED fact without data is a fabrication bug and fails loudly', () => {
    const fabricated = { status: 'VERIFIED', source: 'RAILCORE', retrievedAt: 'now', data: null } as unknown as ReturnType<typeof verifiedFact<Station>>;
    expect(() => assertFactNeverFabricated(fabricated)).toThrowError(/FABRICATED_FACT/);
  });
});
