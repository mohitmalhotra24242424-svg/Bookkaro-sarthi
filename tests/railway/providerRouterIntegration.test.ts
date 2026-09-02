/**
 * Provider router INTEGRATION tests — real RailCore + RailKit adapters with
 * MOCK transports (HTTP stub for RailCore, fake SDK for RailKit). Covers the
 * Step 2 fallback matrix. MOCK TESTS — no live calls, no real credentials.
 */

import { describe, expect, it } from 'vitest';
import { isZeroResult } from '../../shared/index.js';
import { RailwayProviderRouter } from '../../railway/router.js';
import { RailCoreProvider } from '../../railway/providers/railcore/index.js';
import type { FetchLike } from '../../railway/providers/railcore/index.js';
import { RailCoreClient } from '../../railway/providers/railcore/client.js';
import { RailKitProvider } from '../../railway/providers/railkit/index.js';
import type { RailKitSdkLike } from '../../railway/providers/railkit/index.js';
import {
  RAILCORE_LIVE_STATUS_FIXTURE,
  RAILCORE_NO_TRAINS_FIXTURE,
  RAILCORE_STATION_SEARCH_FIXTURE,
  RAILCORE_SUCCESS_FALSE_FIXTURE,
  RAILCORE_TRAIN_SEARCH_FIXTURE,
} from '../../railway/providers/railcore/fixtures.js';
import {
  RAILKIT_LIVE_STATUS_FIXTURE,
  RAILKIT_PNR_FIXTURE,
  RAILKIT_SUCCESS_FALSE_FIXTURE,
  RAILKIT_TRAIN_SEARCH_FIXTURE,
} from '../../railway/providers/railkit/fixtures.js';

const RAILCORE_TEST_KEY = 'RAILCORE_INTEGRATION_KEY_PLACEHOLDER';
const RAILKIT_TEST_KEY = 'RAILKIT_INTEGRATION_KEY_PLACEHOLDER';

type RailCoreResponse = { status: number; body: unknown } | 'hang' | 'never';

function makeStack(
  railCoreBehavior: (url: string) => RailCoreResponse,
  railKitScripts: Partial<Record<keyof RailKitSdkLike, unknown>>,
  options: { railCoreTimeoutMs?: number } = {},
) {
  const railCoreRequests: string[] = [];
  const railKitCalls: string[] = [];

  const railCoreFetch: FetchLike = (url, init) => {
    railCoreRequests.push(String(url));
    const decision = railCoreBehavior(String(url));
    if (decision === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (decision === 'never') {
      return new Promise(() => undefined); // never settles (guarded by timeout)
    }
    const bodyText = typeof decision.body === 'string' ? decision.body : JSON.stringify(decision.body);
    return Promise.resolve({
      ok: decision.status >= 200 && decision.status < 300,
      status: decision.status,
      json: async () => {
        if (typeof decision.body === 'string') throw new Error('not JSON');
        return decision.body;
      },
      text: async () => bodyText,
    });
  };

  const sdk = {
    checkPNRStatus: async () => {
      railKitCalls.push('checkPNRStatus');
      return railKitScripts.checkPNRStatus ?? { success: true, data: {} };
    },
    getTrainInfo: async () => {
      railKitCalls.push('getTrainInfo');
      return railKitScripts.getTrainInfo ?? { success: true, data: {} };
    },
    trackTrain: async () => {
      railKitCalls.push('trackTrain');
      return railKitScripts.trackTrain ?? RAILKIT_LIVE_STATUS_FIXTURE;
    },
    searchTrainBetweenStations: async () => {
      railKitCalls.push('searchTrainBetweenStations');
      return railKitScripts.searchTrainBetweenStations ?? { success: true, data: [] };
    },
    getAvailability: async () => {
      railKitCalls.push('getAvailability');
      return railKitScripts.getAvailability ?? { success: true, data: {} };
    },
    fareLookup: async () => {
      railKitCalls.push('fareLookup');
      return railKitScripts.fareLookup ?? { success: true, data: {} };
    },
    cancelList: async () => {
      railKitCalls.push('cancelList');
      return railKitScripts.cancelList ?? { success: true, data: {} };
    },
  } as unknown as RailKitSdkLike;

  const router = new RailwayProviderRouter({
    providers: [
      new RailCoreProvider({
        apiKey: RAILCORE_TEST_KEY,
        fetchImpl: railCoreFetch,
        timeoutMs: options.railCoreTimeoutMs ?? 8_000,
      }),
      new RailKitProvider({ apiKey: RAILKIT_TEST_KEY, sdk }),
    ],
  });

  return { router, railCoreRequests, railKitCalls };
}

function expectFailureResult<T>(result: { ok: boolean }) {
  expect(result.ok).toBe(false);
  return result as { ok: false; source: string | null; error: { kind: string; fallbackEligible: boolean; httpStatus: number | null } };
}

describe('router integration: fallback matrix (MOCK transports)', () => {
  const SEARCH_QUERY = { originCode: 'BSL', destinationCode: 'ADI', journeyDate: '2099-01-01' };

  it('RailCore failure (HTTP 500) → RailKit fallback answers', async () => {
    const { router, railKitCalls } = makeStack(
      () => ({ status: 500, body: { success: false, error: { code: 'UPSTREAM_ERROR', message: 'boom' } } }),
      { searchTrainBetweenStations: RAILKIT_TRAIN_SEARCH_FIXTURE },
    );
    const result = await router.trainSearch(SEARCH_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
    expect(result.viaFallback).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(railKitCalls).toEqual(['searchTrainBetweenStations']);
  });

  it('RailCore timeout → RailKit fallback answers', async () => {
    const { router } = makeStack(
      () => 'hang',
      { searchTrainBetweenStations: RAILKIT_TRAIN_SEARCH_FIXTURE },
      { railCoreTimeoutMs: 30 },
    );
    const result = await router.trainSearch(SEARCH_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
    expect(result.viaFallback).toBe(true);
  });

  it('RailCore success:false (unusable) → RailKit fallback answers', async () => {
    const { router } = makeStack(() => ({ status: 200, body: RAILCORE_SUCCESS_FALSE_FIXTURE }), {
      searchTrainBetweenStations: RAILKIT_TRAIN_SEARCH_FIXTURE,
    });
    const result = await router.trainSearch(SEARCH_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
  });

  it('RailCore success → RailKit never called; provider metadata says railcore', async () => {
    const { router, railKitCalls, railCoreRequests } = makeStack(() => ({ status: 200, body: RAILCORE_TRAIN_SEARCH_FIXTURE }), {});
    const result = await router.trainSearch(SEARCH_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILCORE');
    expect(result.viaFallback).toBeUndefined();
    expect(railKitCalls).toHaveLength(0);
    expect(railCoreRequests).toHaveLength(1);
  });

  it('legitimate zero-train result does NOT trigger fallback (documented 404 NO_TRAINS_FOUND)', async () => {
    const { router, railKitCalls, railCoreRequests } = makeStack(
      () => ({ status: 404, body: RAILCORE_NO_TRAINS_FIXTURE }),
      { searchTrainBetweenStations: RAILKIT_TRAIN_SEARCH_FIXTURE },
    );
    const result = await router.trainSearch(SEARCH_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok || !isZeroResult(result)) throw new Error('expected empty');
    expect(result.emptyReason).toBe('NO_RESULTS');
    expect(railKitCalls).toHaveLength(0);
    expect(railCoreRequests).toHaveLength(1);
  });

  it('invalid query does NOT trigger fallback — no provider is called at all', async () => {
    const { router, railKitCalls, railCoreRequests } = makeStack(() => ({ status: 200, body: RAILCORE_TRAIN_SEARCH_FIXTURE }), {});
    const result = expectFailureResult(await router.trainSearch({ originCode: 'BSL', destinationCode: 'ADI', journeyDate: '2020-01-01' }));

    expect(result.error.kind).toBe('INVALID_INPUT');
    expect(railCoreRequests).toHaveLength(0);
    expect(railKitCalls).toHaveLength(0);
  });

  it('both providers fail → honest normalized failure (RAILKIT last attempt surfaced)', async () => {
    const { router } = makeStack(
      () => ({ status: 503, body: { success: false, error: { code: 'UPSTREAM_ERROR', message: 'down' } } }),
      { searchTrainBetweenStations: RAILKIT_SUCCESS_FALSE_FIXTURE },
    );
    const result = expectFailureResult(await router.trainSearch(SEARCH_QUERY));

    expect(result.source).toBe('RAILKIT');
    expect(result.error.kind).toBe('INVALID_RESPONSE');
    expect(result.error.fallbackEligible).toBe(true); // API layer maps this to RAILWAY_DATA_UNAVAILABLE
  });

  it('capability routing: PNR goes ONLY to RailKit (RailCore has no pnr capability)', async () => {
    const { router, railCoreRequests, railKitCalls } = makeStack(() => ({ status: 200, body: {} }), {
      checkPNRStatus: RAILKIT_PNR_FIXTURE,
    });
    const result = await router.pnr({ pnr: '4123456789' });

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
    expect(railCoreRequests).toHaveLength(0);
    expect(railKitCalls).toEqual(['checkPNRStatus']);
  });

  it('capability routing: station lookup goes ONLY to RailCore (RailKit has none)', async () => {
    const { router, railKitCalls } = makeStack(() => ({ status: 200, body: RAILCORE_STATION_SEARCH_FIXTURE }), {});
    const result = await router.stationLookup({ query: 'Ludhiana' });

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILCORE');
    expect(railKitCalls).toHaveLength(0);
  });

  it('live status: RailCore unavailable → RailKit trackTrain fallback', async () => {
    const { router } = makeStack(() => ({ status: 500, body: { success: false, error: { code: 'X', message: 'down' } } }), {
      trackTrain: RAILKIT_LIVE_STATUS_FIXTURE,
    });
    const result = await router.liveStatus({ trainNumber: '12656', journeyDate: null });

    expect(result.ok).toBe(true);
    if (!result.ok || isZeroResult(result)) throw new Error('expected success');
    expect(result.source).toBe('RAILKIT');
    expect(result.data.status).toBe('DELAYED');
    expect(result.data.delayMinutes).toBe(18);
  });

  it('missing credentials on both providers → honest MISSING_CREDENTIALS failure (clean config error)', async () => {
    const router = new RailwayProviderRouter({
      providers: [new RailCoreProvider({ apiKey: null }), new RailKitProvider({ apiKey: null })],
    });
    const result = expectFailureResult(await router.liveStatus({ trainNumber: '12656', journeyDate: '2026-08-27' }));
    expect(result.source).toBe('RAILKIT');
    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
  });

  it('RailCore client classifies a network error honestly (fetch blocked)', async () => {
    const blockedFetch: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const provider = new RailCoreProvider({ apiKey: RAILCORE_TEST_KEY, fetchImpl: blockedFetch });
    const result = expectFailureResult(await provider.liveStatus({ trainNumber: '12656', journeyDate: '2026-08-27' }));
    expect(result.error.kind).toBe('NETWORK_ERROR');
  });

  it('latency metadata is attached to results', async () => {
    const { router } = makeStack(() => ({ status: 200, body: RAILCORE_LIVE_STATUS_FIXTURE }), {});
    const result = await router.liveStatus({ trainNumber: '12656', journeyDate: '2026-08-27' });
    expect(result.ok && typeof result.latencyMs === 'number').toBe(true);
  });
});

// Type-only import usage guard (keeps RailCoreClient in the type graph for future steps).
export type { RailCoreClient };
