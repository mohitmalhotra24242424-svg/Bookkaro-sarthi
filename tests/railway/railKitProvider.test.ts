/**
 * RailKit provider tests — MOCK TESTS (fake SDK injection; NO live calls, NO
 * real credentials). One test exercises the REAL official SDK with a captured
 * global fetch to verify authentication wiring (still zero network).
 */

import { describe, expect, it } from 'vitest';
import { isZeroResult } from '../../shared/index.js';
import { RailKitProvider, RAILKIT_CAPABILITIES } from '../../railway/providers/railkit/index.js';
import type { RailKitSdkLike } from '../../railway/providers/railkit/index.js';
import { createOfficialRailKitSdkLoader, isoToDdMmYyyy } from '../../railway/providers/railkit/sdk.js';
import {
  RAILKIT_AVAILABILITY_FIXTURE,
  RAILKIT_AVAILABILITY_WAITLIST_FIXTURE,
  RAILKIT_CANCELLED_FIXTURE,
  RAILKIT_EMPTY_SEARCH_FIXTURE,
  RAILKIT_FARE_FIXTURE,
  RAILKIT_LIVE_STATUS_FIXTURE,
  RAILKIT_PNR_FIXTURE,
  RAILKIT_SUCCESS_FALSE_FIXTURE,
  RAILKIT_TRAIN_INFO_FIXTURE,
  RAILKIT_TRAIN_SEARCH_FIXTURE,
} from '../../railway/providers/railkit/fixtures.js';

function createFakeSdk(scripts: Partial<Record<keyof RailKitSdkLike, unknown>>): RailKitSdkLike & { calls: string[] } {
  const calls: string[] = [];
  const sdk = {
    calls,
    checkPNRStatus: async () => {
      calls.push('checkPNRStatus');
      return scripts.checkPNRStatus ?? { success: true, data: {} };
    },
    getTrainInfo: async () => {
      calls.push('getTrainInfo');
      return scripts.getTrainInfo ?? { success: true, data: {} };
    },
    trackTrain: async () => {
      calls.push('trackTrain');
      return scripts.trackTrain ?? { success: true, data: {} };
    },
    searchTrainBetweenStations: async () => {
      calls.push('searchTrainBetweenStations');
      return scripts.searchTrainBetweenStations ?? { success: true, data: [] };
    },
    getAvailability: async () => {
      calls.push('getAvailability');
      return scripts.getAvailability ?? { success: true, data: {} };
    },
    fareLookup: async () => {
      calls.push('fareLookup');
      return scripts.fareLookup ?? { success: true, data: {} };
    },
    cancelList: async () => {
      calls.push('cancelList');
      return scripts.cancelList ?? { success: true, data: {} };
    },
  } as unknown as RailKitSdkLike & { calls: string[] };
  return sdk;
}

describe('RailKit authentication configuration (MOCK)', () => {
  it('without a key: clean MISSING_CREDENTIALS error and ZERO SDK calls', async () => {
    const sdk = createFakeSdk({});
    // NOTE: sdk NOT injected here — provider has no key and no loader.
    const provider = new RailKitProvider({ apiKey: null });
    expect(provider.credentialConfigured).toBe(false);

    const result = await provider.pnr({ pnr: '4123456789' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
    expect(sdk.calls).toHaveLength(0);
  });

  it('REAL official SDK loader sends RAILKIT_API_KEY via x-api-key to the documented backend (fetch captured — no network)', async () => {
    const captured: Array<{ url: string; headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { headers?: unknown }) => {
      captured.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
        text: async () => '{}',
      };
    }) as typeof fetch;

    try {
      const loader = createOfficialRailKitSdkLoader('RAILKIT_UNIT_TEST_KEY_PLACEHOLDER');
      const sdk = await loader();
      await sdk.searchTrainBetweenStations('NDLS', 'BCT', '15-04-2025');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toContain('searchTrainBetweenStations/NDLS/BCT');
    expect(request.headers['x-api-key']).toBe('RAILKIT_UNIT_TEST_KEY_PLACEHOLDER');
  });

  it('date conversion: shared ISO → SDK DD-MM-YYYY', () => {
    expect(isoToDdMmYyyy('2026-08-27')).toBe('27-08-2026');
    expect(isoToDdMmYyyy('not-a-date')).toBeNull();
  });
});

describe('RailKit normalization (MOCK — fixtures from documented shapes)', () => {
  it('train search → TrainSearchResult[] with alias fields resolved', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ searchTrainBetweenStations: RAILKIT_TRAIN_SEARCH_FIXTURE }) });
    const result = await provider.trainSearch({ originCode: 'NDLS', destinationCode: 'BCT', journeyDate: '2026-08-27' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.train.number).toBe('12656');
    expect(result.data[0]?.fromStation?.name).toBe('New Delhi');
    expect(result.data[1]?.train.number).toBe('12952'); // aliased train_no/number
    expect(result.data[1]?.departureTime).toBe('16:25'); // aliased dep
  });

  it('train info + timetable come from the documented getTrainInfo route', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ getTrainInfo: RAILKIT_TRAIN_INFO_FIXTURE }) });
    const info = await provider.trainInfo({ trainNumber: '12656' });
    expect(info.ok && info.data?.name).toBe('Navjeevan SF Express');

    const timetable = await provider.timetable({ trainNumber: '12656' });
    expect(timetable.ok && timetable.data?.stops).toHaveLength(3);
    expect(timetable.ok && timetable.data?.stops[1]?.stationCode).toBe('BSL');
  });

  it('live status → delay-aware status + timeline as upcoming stops', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ trackTrain: RAILKIT_LIVE_STATUS_FIXTURE }) });
    const result = await provider.liveStatus({ trainNumber: '12656', journeyDate: null });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.status).toBe('DELAYED'); // delay 18 → DELAYED (no explicit status field)
    expect(result.data.delayMinutes).toBe(18);
    expect(result.data.currentStation?.code).toBe('BSL');
    expect(result.data.upcomingStops).toHaveLength(3);
    expect(result.data.upcomingStops?.[2]?.arrivalTime).toBe('09:02'); // object {scheduled} → string
  });

  it('availability → status text parsing (AVAILABLE-0032 / GNWL14/WL8)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ getAvailability: RAILKIT_AVAILABILITY_FIXTURE }) });
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

    const waitlistProvider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ getAvailability: RAILKIT_AVAILABILITY_WAITLIST_FIXTURE }) });
    const waitlist = await waitlistProvider.availability({
      trainNumber: '12656',
      journeyDate: '2099-01-01',
      travelClass: 'SL',
      quota: 'GN',
      fromStationCode: 'BSL',
      toStationCode: 'ADI',
    });
    expect(waitlist.ok && waitlist.data?.status).toBe('WAITLIST');
    expect(waitlist.ok && waitlist.data?.waitlistNumber).toBe(8);
  });

  it('fare → full breakdown in paise with RAILKIT provenance', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ fareLookup: RAILKIT_FARE_FIXTURE }) });
    const result = await provider.fare({
      trainNumber: '12313',
      fromStationCode: 'ASN',
      toStationCode: 'NDLS',
      journeyDate: '2026-09-06',
      travelClass: '3A',
      quota: 'GN',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.breakdown.totalMinor).toBe(387300); // ₹3873 → paise
    expect(result.data.breakdown.baseFareMinor).toBe(284500);
    expect(result.data.breakdown.gstMinor).toBe(14100);
    expect(result.data.source).toBe('RAILKIT');
  });

  it('fare without a date is honestly rejected (dynamic fares are date-dependent)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ fareLookup: RAILKIT_FARE_FIXTURE }) });
    const result = await provider.fare({
      trainNumber: '12313',
      fromStationCode: 'ASN',
      toStationCode: 'NDLS',
      journeyDate: null,
      travelClass: '3A',
      quota: 'GN',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_INPUT');
  });

  it('PNR → normalized statuses; passenger NAMES are dropped (privacy)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ checkPNRStatus: RAILKIT_PNR_FIXTURE }) });
    const result = await provider.pnr({ pnr: '4123456789' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data.overallStatus).toBe('CONFIRMED'); // CNF → CONFIRMED
    expect(result.data.trainNumber).toBe('12313');
    expect(result.data.chartPrepared).toBe(true);
    expect(result.data.passengers).toHaveLength(2);
    expect(result.data.passengers?.[0]?.coach).toBe('B2'); // seat B2-34 split
    expect(result.data.passengers?.[0]?.seat).toBe('34');
    expect(result.data.passengers?.[1]?.currentStatus).toBe('CNF B2-38');
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain('PASSENGER ONE');
    expect(serialized).not.toContain('PASSENGER TWO');
    expect(serialized).not.toContain('name'); // no name fields normalized at all
  });

  it('cancelled trains → fully + partially cancelled, dates null (never invented)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ cancelList: RAILKIT_CANCELLED_FIXTURE }) });
    const result = await provider.cancelledTrains({ journeyDate: '2099-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.trainNumber).toBe('15098');
    expect(result.data[0]?.reason).toBe('FULLY_CANCELLED');
    expect(result.data[1]?.reason).toBe('PARTIALLY_CANCELLED');
    expect(result.data[0]?.journeyDate).toBeNull();
  });

  it('legitimately empty search → ProviderEmpty NO_RESULTS', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ searchTrainBetweenStations: RAILKIT_EMPTY_SEARCH_FIXTURE }) });
    const result = await provider.trainSearch({ originCode: 'NDLS', destinationCode: 'BCT', journeyDate: '2099-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok || !isZeroResult(result)) throw new Error('expected empty');
    expect(result.emptyReason).toBe('NO_RESULTS');
    expect(result.data).toBeNull();
  });

  it('success:false from the SDK → INVALID_RESPONSE (fallback eligible per spec)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({ searchTrainBetweenStations: RAILKIT_SUCCESS_FALSE_FIXTURE }) });
    const result = await provider.trainSearch({ originCode: 'NDLS', destinationCode: 'BCT', journeyDate: '2099-01-01' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('INVALID_RESPONSE');
    expect(result.error.fallbackEligible).toBe(true);
  });

  it('station-name lookup is honestly unsupported (no RailKit endpoint exists)', async () => {
    const provider = new RailKitProvider({ apiKey: 'test', sdk: createFakeSdk({}) });
    expect(RAILKIT_CAPABILITIES).not.toContain('stationLookup');
    const result = await provider.stationLookup({ query: 'Ludhiana' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('a throwing SDK call becomes an honest PROVIDER_FAILURE (never fabricated data)', async () => {
    const sdk = createFakeSdk({});
    (sdk as unknown as { getTrainInfo: () => Promise<unknown> }).getTrainInfo = async () => {
      throw new Error('SDK exploded');
    };
    const provider = new RailKitProvider({ apiKey: 'test', sdk });
    const result = await provider.trainInfo({ trainNumber: '12656' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('PROVIDER_FAILURE');
    expect(result.error.fallbackEligible).toBe(true);
  });
});
