/**
 * RailCore provider tests — MOCK TESTS (fixture/HTTP-stub driven; NO live
 * calls, NO real credentials). Fixtures mirror the official docs examples.
 */

import { describe, expect, it } from 'vitest';
import {
  RAILCORE_AUTH_HEADER,
  RAILCORE_BASE_URL,
  RailCoreProvider,
} from '../../railway/providers/railcore/index.js';
import type { FetchLike } from '../../railway/providers/railcore/index.js';
import {
  RAILCORE_AVAILABILITY_FIXTURE,
  RAILCORE_FARE_FIXTURE,
  RAILCORE_HTML_GARBAGE_FIXTURE,
  RAILCORE_LIVE_STATUS_FIXTURE,
  RAILCORE_NO_TRAINS_FIXTURE,
  RAILCORE_STATION_SEARCH_FIXTURE,
  RAILCORE_SUCCESS_FALSE_FIXTURE,
  RAILCORE_TIMETABLE_FIXTURE,
  RAILCORE_TRAIN_INFO_FIXTURE,
  RAILCORE_TRAIN_SEARCH_FIXTURE,
  RAILCORE_VALIDATION_FIXTURE,
} from '../../railway/providers/railcore/fixtures.js';
import { categorizeFailure } from '../../railway/diagnostics.js';
import { isZeroResult } from '../../shared/index.js';

// ── MOCK HTTP transport ───────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function respondsWith(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') throw new Error('SyntaxError: not JSON');
      return body;
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function createCapturingFetch(
  handler: (url: string) => { status: number; body: unknown } | 'hang',
): { fetch: FetchLike; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    requests.push({ url: String(url), headers: init.headers as Record<string, string> });
    const decision = handler(String(url));
    if (decision === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }
    return Promise.resolve(respondsWith(decision.status, decision.body));
  };
  return { fetch: fetchImpl, requests };
}

const TEST_KEY = 'RAILCORE_UNIT_TEST_KEY_PLACEHOLDER';

// ── tests ─────────────────────────────────────────────────────────────────────

describe('RailCore authentication configuration (MOCK)', () => {
  it('sends the key in the documented X-RailCore-Key header to the documented base URL', async () => {
    const transport = createCapturingFetch(() => ({ status: 200, body: RAILCORE_STATION_SEARCH_FIXTURE }));
    const provider = new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch });

    await provider.stationLookup({ query: 'Ludhiana' });

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.url.startsWith(RAILCORE_BASE_URL)).toBe(true);
    expect(request.url).toContain('/stations/search?q=Ludhiana');
    expect(request.headers[RAILCORE_AUTH_HEADER]).toBe(TEST_KEY);
  });

  it('without a key: clean MISSING_CREDENTIALS error, ZERO network calls', async () => {
    const transport = createCapturingFetch(() => ({ status: 200, body: RAILCORE_STATION_SEARCH_FIXTURE }));
    const provider = new RailCoreProvider({ apiKey: null, fetchImpl: transport.fetch });

    expect(provider.credentialConfigured).toBe(false);
    const result = await provider.stationLookup({ query: 'Ludhiana' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('RailCore normalization (MOCK — fixtures from official docs examples)', () => {
  function fixtureProvider(status: number, body: unknown) {
    const transport = createCapturingFetch(() => ({ status, body }));
    return new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch });
  }

  it('station lookup → Station[] with missing fields as null', async () => {
    const result = await fixtureProvider(200, RAILCORE_STATION_SEARCH_FIXTURE).stationLookup({ query: 'bhusaval' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILCORE');
    expect(result.data).toHaveLength(2);
    const [bsl, ldh] = result.data;
    expect(bsl?.code).toBe('BSL');
    expect(bsl?.name).toBe('Bhusaval Jn');
    expect(bsl?.state).toBe('Maharashtra');
    expect(bsl?.latitude).toBe(21.048194);
    expect(ldh?.latitude).toBeNull(); // fixture has null — never invented
    expect(bsl?.zone).toBeNull(); // RailCore does not publish zones
  });

  it('train search → TrainSearchResult[]; partial records keep honest nulls', async () => {
    const result = await fixtureProvider(200, RAILCORE_TRAIN_SEARCH_FIXTURE).trainSearch({
      originCode: 'BSL',
      destinationCode: 'ADI',
      journeyDate: '2099-01-01',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data).toHaveLength(2);
    const [first, second] = result.data;
    expect(first?.train.number).toBe('12656');
    expect(first?.train.name).toBe('Navjeevan SF Express');
    expect(first?.train.runsOn).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
    expect(first?.train.travelClasses).toEqual(['SL', '3A', '2A', '1A']);
    expect(first?.durationMinutes).toBe(455);
    expect(second?.train.runsOn).toBeNull();
    expect(second?.train.pantryCar).toBeNull();
    expect(second?.fromStation?.code).toBe('BSL');
  });

  it('train info → Train', async () => {
    const result = await fixtureProvider(200, RAILCORE_TRAIN_INFO_FIXTURE).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.number).toBe('12656');
    expect(result.data.originStation?.code).toBe('MAS');
    expect(result.data.originStation?.name).toBeNull(); // code-only station — name not invented
  });

  it('timetable → Timetable with nullable stop times', async () => {
    const result = await fixtureProvider(200, RAILCORE_TIMETABLE_FIXTURE).timetable({ trainNumber: '12656' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.stops).toHaveLength(2);
    expect(result.data.stops[0]?.arrivalTime).toBeNull(); // origin has no arrival
    expect(result.data.stops[1]?.haltMinutes).toBe(10);
    expect(result.data.stops[1]?.dayCount).toBe(2);
  });

  it('live status → LiveStatus with verified state mapping', async () => {
    const result = await fixtureProvider(200, RAILCORE_LIVE_STATUS_FIXTURE).liveStatus({ trainNumber: '12656', journeyDate: '2026-08-27' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.status).toBe('RUNNING');
    expect(result.data.delayMinutes).toBe(12);
    expect(result.data.currentStation?.code).toBe('BSL');
    expect(result.data.lastUpdatedAt).toBe('2026-08-27T08:41:00.000Z');
    expect(result.data.upcomingStops).toBeNull(); // not provided as a list — honest null
  });

  it('availability → matched class entry; honest UNAVAILABLE when class missing', async () => {
    const provider = fixtureProvider(200, RAILCORE_AVAILABILITY_FIXTURE);
    const available = await provider.availability({
      trainNumber: '12656',
      journeyDate: '2099-01-01',
      travelClass: '3A',
      quota: 'GN',
      fromStationCode: 'BSL',
      toStationCode: 'ADI',
    });
    expect(available.ok && available.data?.status).toBe('AVAILABLE');
    expect(available.ok && available.data?.availableCount).toBe(32);

    const waitlist = await provider.availability({
      trainNumber: '12656',
      journeyDate: '2099-01-01',
      travelClass: 'SL',
      quota: 'GN',
      fromStationCode: 'BSL',
      toStationCode: 'ADI',
    });
    expect(waitlist.ok && waitlist.data?.status).toBe('WAITLIST');
    expect(waitlist.ok && waitlist.data?.waitlistNumber).toBe(8);

    const missing = await provider.availability({
      trainNumber: '12656',
      journeyDate: '2099-01-01',
      travelClass: 'CC',
      quota: 'GN',
      fromStationCode: 'BSL',
      toStationCode: 'ADI',
    });
    expect(missing.ok && missing.data?.status).toBe('UNAVAILABLE');
    expect(missing.ok && missing.data?.availableCount).toBeNull();
  });

  it('fare → integer-paise breakdown from documented INR values', async () => {
    const provider = fixtureProvider(200, RAILCORE_FARE_FIXTURE);
    const fare = await provider.fare({
      trainNumber: '12656',
      fromStationCode: 'BSL',
      toStationCode: 'ADI',
      journeyDate: null,
      travelClass: '2A',
      quota: 'GN',
    });
    expect(fare.ok && fare.data?.breakdown.totalMinor).toBe(161500); // ₹1615 → 161500 paise
    expect(fare.ok && fare.data?.source).toBe('RAILCORE');
    expect(fare.ok && fare.data?.journeyDate).toBeNull(); // date-independent estimate (verified)
    expect(fare.ok && fare.data?.breakdown.baseFareMinor).toBeNull(); // components not provided — null
  });
});

describe('RailCore failure classification (MOCK)', () => {
  function fixtureProvider(status: number, body: unknown, timeoutMs?: number) {
    const transport = createCapturingFetch((url) => (url.includes('/live') && status === 0 ? 'hang' : { status, body }));
    return new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  it('404 NO_TRAINS_FOUND is a legitimate empty result, not a failure', async () => {
    const result = await fixtureProvider(404, RAILCORE_NO_TRAINS_FIXTURE).trainSearch({
      originCode: 'BSL',
      destinationCode: 'ADI',
      journeyDate: '2099-01-01',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !isZeroResult(result)) throw new Error('expected empty');
    expect(result.emptyReason).toBe('NO_RESULTS');
    expect(result.data).toBeNull();
  });

  it('401 → HTTP_ERROR classified AUTH_ERROR', async () => {
    const result = await fixtureProvider(401, { success: false, error: { code: 'INVALID_API_KEY', message: 'unknown key' } }).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('HTTP_ERROR');
    expect(result.error.httpStatus).toBe(401);
    expect(categorizeFailure(result.error)).toBe('AUTH_ERROR');
  });

  it('429 → RATE_LIMITED', async () => {
    const result = await fixtureProvider(429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('RATE_LIMITED');
    expect(result.error.fallbackEligible).toBe(true);
  });

  it('200 with success:false → INVALID_RESPONSE (unusable → fallback eligible)', async () => {
    const result = await fixtureProvider(200, RAILCORE_SUCCESS_FALSE_FIXTURE).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_RESPONSE');
    expect(result.error.fallbackEligible).toBe(true);
  });

  it('non-JSON 200 → INVALID_RESPONSE', async () => {
    const result = await fixtureProvider(200, RAILCORE_HTML_GARBAGE_FIXTURE).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_RESPONSE');
  });

  it('timeout → TIMEOUT failure', async () => {
    const transport = createCapturingFetch(() => 'hang');
    const provider = new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch, timeoutMs: 25 });
    const result = await provider.liveStatus({ trainNumber: '12656', journeyDate: '2026-08-27' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('TIMEOUT');
    expect(categorizeFailure(result.error)).toBe('TIMEOUT');
  });

  it('400 VALIDATION_ERROR → INVALID_INPUT (not fallback eligible)', async () => {
    const result = await fixtureProvider(400, RAILCORE_VALIDATION_FIXTURE).trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_INPUT');
    expect(result.error.fallbackEligible).toBe(false);
  });

  it('PNR / cancelled are honestly unsupported at RailCore', async () => {
    const provider = new RailCoreProvider({ apiKey: TEST_KEY });
    const pnr = await provider.pnr({ pnr: '1234567890' });
    expect(pnr.ok).toBe(false);
    if (pnr.ok) throw new Error('expected failure');
    expect(pnr.error.kind).toBe('UNSUPPORTED_CAPABILITY');

    const cancelled = await provider.cancelledTrains({ journeyDate: '2099-01-01' });
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error('expected failure');
    expect(cancelled.error.kind).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('live status without a date defaults to today (query semantics, documented by RailKit)', async () => {
    const transport = createCapturingFetch(() => ({ status: 200, body: RAILCORE_LIVE_STATUS_FIXTURE }));
    const provider = new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch });
    await provider.liveStatus({ trainNumber: '12656', journeyDate: null });
    const url = transport.requests[0]?.url ?? '';
    const dateParam = new URL(url).searchParams.get('date');
    expect(dateParam).toBe(new Date().toISOString().slice(0, 10));
  });

  it('train search without a date is honestly rejected (RailCore requires date)', async () => {
    const transport = createCapturingFetch(() => ({ status: 200, body: RAILCORE_TRAIN_SEARCH_FIXTURE }));
    const provider = new RailCoreProvider({ apiKey: TEST_KEY, fetchImpl: transport.fetch });
    const result = await provider.trainSearch({ originCode: 'BSL', destinationCode: 'ADI', journeyDate: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_INPUT');
    expect(transport.requests).toHaveLength(0);
  });
});
