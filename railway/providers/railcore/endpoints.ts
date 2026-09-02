/**
 * VERIFIED RailCore endpoint map.
 *
 * Source of truth: official RailCore developer documentation
 * https://railcore.tech/docs (API reference pages), captured 2026-08-26.
 * Base URL and auth header as specified by the product brief:
 *   base  https://ir.railcore.tech/v1
 *   auth  X-RailCore-Key: $RAILCORE_API_KEY   (server-side only)
 *
 * Documented error envelope (verified live):
 *   { success:false, error:{ code, message, category, retryable }, meta:{...} }
 * Documented success envelope (verified in docs examples):
 *   { success:true, data:{...}, meta:{ api_version, request_id, trace_id, timestamp, freshness } }
 */

export const RAILCORE_BASE_URL = 'https://ir.railcore.tech/v1';
export const RAILCORE_AUTH_HEADER = 'X-RailCore-Key';
export const RAILCORE_DEFAULT_TIMEOUT_MS = 8_000;
export const RAILCORE_ENDPOINT_STATUS =
  'VERIFIED — matches official docs at railcore.tech/docs (captured 2026-08-26)';

export interface RailCoreEndpointSpec {
  readonly method: 'GET';
  readonly path: string;
  readonly capability: string;
  readonly verified: true;
}

export const RAILCORE_ENDPOINTS = {
  /** GET /v1/stations/search?q=&limit= — scope stations:read */
  stationLookup: { method: 'GET', path: '/stations/search', capability: 'stationLookup', verified: true },
  /** GET /v1/routes/trains?from=&to=&date=&quota= — scope journeys:read (date REQUIRED) */
  trainSearch: { method: 'GET', path: '/routes/trains', capability: 'trainSearch', verified: true },
  /** GET /v1/trains/{train_number} — scope trains:read */
  trainInfo: { method: 'GET', path: '/trains/{train_number}', capability: 'trainInfo', verified: true },
  /** GET /v1/trains/{train_number}/schedule?include_intermediate= — scope schedule:read */
  timetable: { method: 'GET', path: '/trains/{train_number}/schedule', capability: 'timetable', verified: true },
  /** GET /v1/trains/{train_number}/live?date=&from=&to= — scope live:read (date REQUIRED) */
  liveStatus: { method: 'GET', path: '/trains/{train_number}/live', capability: 'liveStatus', verified: true },
  /** GET /v1/availability/seats?train_number=&from=&to=&date=&class=&quota= — availability:read */
  availability: { method: 'GET', path: '/availability/seats', capability: 'availability', verified: true },
  /** GET /v1/fares/estimate?train_number=&from=&to=&class=&quota= — fares:read */
  fare: { method: 'GET', path: '/fares/estimate', capability: 'fare', verified: true },
} as const satisfies Record<string, RailCoreEndpointSpec>;

/**
 * Documented provider error codes that are LEGITIMATE EMPTY ANSWERS, not
 * failures (verified: "404 NO_TRAINS_FOUND — No train matches the route and
 * date. Not retryable."). These must NOT trigger RailKit fallback.
 */
export const RAILCORE_EMPTY_ERROR_CODES: Readonly<Record<string, 'NO_RESULTS' | 'NOT_FOUND'>> = {
  NO_TRAINS_FOUND: 'NO_RESULTS',
  TRAIN_NOT_FOUND: 'NOT_FOUND',
};

/** Documented validation code — mirrors our own INVALID_INPUT (not fallback-eligible). */
export const RAILCORE_VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';
