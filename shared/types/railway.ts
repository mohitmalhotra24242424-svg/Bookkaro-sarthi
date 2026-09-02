/**
 * Shared railway domain contracts.
 *
 * FACT SAFETY RULE (project-wide): every field that a provider may not know
 * is explicitly `| null`. Status enums include an honest "UNKNOWN" or
 * "UNAVAILABLE" member. Missing railway information is represented as
 * null / UNKNOWN / UNAVAILABLE — it is NEVER fabricated.
 */

export type ProviderId = 'RAILCORE' | 'RAILKIT';

export type TravelClassCode = '1A' | '2A' | '3A' | '3E' | 'CC' | 'EC' | 'SL' | '2S';
export const TRAVEL_CLASSES: readonly TravelClassCode[] = [
  '1A',
  '2A',
  '3A',
  '3E',
  'CC',
  'EC',
  'SL',
  '2S',
];

export type QuotaCode = 'GN' | 'TQ' | 'PT' | 'LD' | 'SS' | 'DP' | 'HP';
export const QUOTAS: readonly QuotaCode[] = ['GN', 'TQ', 'PT', 'LD', 'SS', 'DP', 'HP'];

export type WeekdayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

/** Capabilities a railway data provider may support. Providers differ. */
export type RailwayCapability =
  | 'stationLookup'
  | 'trainSearch'
  | 'trainInfo'
  | 'timetable'
  | 'liveStatus'
  | 'availability'
  | 'fare'
  | 'pnr'
  | 'cancelledTrains';

export const RAILWAY_CAPABILITIES: readonly RailwayCapability[] = [
  'stationLookup',
  'trainSearch',
  'trainInfo',
  'timetable',
  'liveStatus',
  'availability',
  'fare',
  'pnr',
  'cancelledTrains',
];

export interface Station {
  code: string;
  /** null when the provider only knows the station code — never invented. */
  name: string | null;
  zone: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Provider city (RailCore `city`) — used to group real multi-station cities. */
  city?: string | null;
  /** Provider match-confidence 0–1 when available (RailCore verified field). */
  confidence?: number | null;
  /** Provider flag: major junction/hub when available. */
  isMajor?: boolean | null;
}

export interface TrainStop {
  stationCode: string;
  stationName: string | null;
  arrivalTime: string | null;
  departureTime: string | null;
  dayCount: number | null;
  distanceKm: number | null;
  haltMinutes: number | null;
}

export interface Train {
  number: string;
  /** null when the provider does not publish the train name. */
  name: string | null;
  originStation: Station | null;
  destinationStation: Station | null;
  departureTime: string | null;
  arrivalTime: string | null;
  runsOn: readonly WeekdayCode[] | null;
  travelClasses: readonly TravelClassCode[] | null;
  pantryCar: boolean | null;
}

export interface TrainSearchResult {
  train: Train;
  fromStation: Station | null;
  toStation: Station | null;
  departureTime: string | null;
  arrivalTime: string | null;
  durationMinutes: number | null;
}

export type AvailabilityStatus = 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'REGRET' | 'UNAVAILABLE';

export interface Availability {
  trainNumber: string;
  journeyDate: string;
  travelClass: TravelClassCode;
  quota: QuotaCode;
  status: AvailabilityStatus;
  availableCount: number | null;
  racCount: number | null;
  waitlistNumber: number | null;
  asOf: string | null;
}

/** All money values are integer paise ("Minor" units). Never floats. */
export interface FareBreakdown {
  baseFareMinor: number | null;
  reservationChargeMinor: number | null;
  superfastChargeMinor: number | null;
  dynamicFareMinor: number | null;
  cateringChargeMinor: number | null;
  gstMinor: number | null;
  totalMinor: number | null;
}

export interface Fare {
  trainNumber: string;
  fromStationCode: string;
  toStationCode: string;
  journeyDate: string | null;
  travelClass: TravelClassCode;
  quota: QuotaCode;
  currency: 'INR';
  breakdown: FareBreakdown;
  /** Provenance: a fare is only ever shown when it came from a verified provider quote. */
  source: ProviderId | null;
  retrievedAt: string | null;
}

export type LiveRunStatus =
  | 'RUNNING'
  | 'ON_TIME'
  | 'DELAYED'
  | 'ARRIVED'
  | 'NOT_STARTED'
  | 'AT_STATION'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'DIVERTED'
  | 'UNKNOWN';

export interface LiveStatus {
  trainNumber: string;
  journeyDate: string | null;
  status: LiveRunStatus;
  delayMinutes: number | null;
  currentStation: Station | null;
  /** Next scheduled stop code when the provider reports it (verified RailCore field). */
  nextStationCode: string | null;
  lastUpdatedAt: string | null;
  upcomingStops: readonly TrainStop[] | null;
}

export interface Timetable {
  trainNumber: string;
  trainName: string | null;
  stops: readonly TrainStop[];
}

export type PNRStatusLevel = 'CONFIRMED' | 'RAC' | 'WAITLIST' | 'CANCELLED' | 'UNKNOWN';

export interface PNRPassengerStatus {
  passengerNumber: number;
  bookingStatus: string | null;
  currentStatus: string | null;
  coach: string | null;
  seat: string | null;
}

export interface PNRStatus {
  pnr: string;
  trainNumber: string | null;
  journeyDate: string | null;
  fromStationCode: string | null;
  toStationCode: string | null;
  chartPrepared: boolean | null;
  overallStatus: PNRStatusLevel;
  passengers: readonly PNRPassengerStatus[] | null;
}

export interface CancelledTrain {
  trainNumber: string;
  trainName: string | null;
  /** null when the provider does not state a date per cancelled train. */
  journeyDate: string | null;
  reason: string | null;
}

// ── Provider query contracts ─────────────────────────────────────────────────

export interface StationLookupQuery {
  query: string;
}

export interface TrainSearchQuery {
  originCode: string;
  destinationCode: string;
  journeyDate: string | null;
}

export interface TrainRefQuery {
  trainNumber: string;
}

export interface LiveStatusQuery {
  trainNumber: string;
  journeyDate: string | null;
}

export interface AvailabilityQuery {
  trainNumber: string;
  journeyDate: string;
  travelClass: TravelClassCode | null;
  quota: QuotaCode | null;
  /** Verified: RailCore /availability/seats and the RailKit SDK both need the segment. */
  fromStationCode: string | null;
  toStationCode: string | null;
}

export interface FareQuery {
  trainNumber: string;
  fromStationCode: string | null;
  toStationCode: string | null;
  journeyDate: string | null;
  travelClass: TravelClassCode | null;
  quota: QuotaCode | null;
}

export interface PNRQuery {
  pnr: string;
}

export interface CancelledTrainsQuery {
  journeyDate: string;
}

// ── Provider result envelope ─────────────────────────────────────────────────

export type ProviderErrorKind =
  | 'MISSING_CREDENTIALS'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'PROVIDER_FAILURE' // success:false, malformed/unusable body, or thrown error
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NOT_IMPLEMENTED';

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  httpStatus: number | null;
  /** true → RailwayProviderRouter may try the fallback provider. */
  fallbackEligible: boolean;
}

export interface ProviderSuccess<T> {
  ok: true;
  source: ProviderId;
  data: T;
  retrievedAt: string;
  latencyMs?: number;
  /** true when the answer came from a fallback provider (e.g. railkit_fallback). */
  viaFallback?: boolean;
}

/** A legitimate empty answer (e.g. no trains found). NOT a failure — never triggers fallback. */
export interface ProviderEmpty {
  ok: true;
  source: ProviderId;
  data: null;
  empty: true;
  emptyReason: 'NO_RESULTS' | 'NOT_FOUND';
  retrievedAt: string;
  latencyMs?: number;
  viaFallback?: boolean;
}

export interface ProviderFailure {
  ok: false;
  source: ProviderId | null;
  error: ProviderError;
  latencyMs?: number;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderEmpty | ProviderFailure;
