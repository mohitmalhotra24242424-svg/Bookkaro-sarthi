/**
 * STATION LOOKUP (RailCore-only) + server-side cache tests.
 * Station lookup capability sirf RailCore ke paas hai; cache repeat lookups
 * ko provider quota bachane ke liye serve karta hai — sirf REAL provider
 * responses cache hoti hain (kabhi pre-seeded/hardcoded nahi).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { RailwayProviderRouter } from '../../railway/router.js';
import type { RailwayProvider } from '../../railway/index.js';
import { providerFailure, providerSuccess } from '../../shared/index.js';
import type { ProviderId, RailwayCapability, Station } from '../../shared/index.js';
import { createProductionToolRegistry, clearStationCacheForTests } from '../../tools/executors/index.js';

const ASR: Station = { code: 'ASR', name: 'Amritsar Jn', zone: null, state: 'Punjab', latitude: null, longitude: null };

function fakeRouter(script: { stationLookup?: ReturnType<typeof providerSuccess> | ReturnType<typeof providerFailure> }) {
  const calls: string[] = [];
  const provider: RailwayProvider = {
    providerId: 'RAILCORE' as ProviderId,
    displayName: 'RailCore-fake',
    capabilities: ['stationLookup'] as RailwayCapability[],
    supports: (capability: RailwayCapability) => capability === 'stationLookup',
    stationLookup: () => {
      calls.push('RAILCORE:stationLookup');
      return Promise.resolve(script.stationLookup ?? providerSuccess('RAILCORE', [ASR]));
    },
    trainSearch: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    trainInfo: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    timetable: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    liveStatus: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    availability: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    fare: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    pnr: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
    cancelledTrains: () => Promise.resolve(providerFailure('UNSUPPORTED_CAPABILITY', 'x')),
  } as unknown as RailwayProvider;
  return { router: new RailwayProviderRouter({ providers: [provider] }), calls };
}

function toolCall(query: string) {
  return {
    id: 't-' + query,
    tool: 'lookupStation' as const,
    input: { query },
    requestedBy: 'AI' as const,
    conversationId: 'conv',
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => clearStationCacheForTests());

describe('station lookup: RailCore-only + cache', () => {
  it('lookup goes to RailCore (the only stationLookup capability holder)', async () => {
    const { router, calls } = fakeRouter({});
    const registry = createProductionToolRegistry({ router });
    const result = await registry.execute(toolCall('Amritsar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['RAILCORE:stationLookup']);
    expect(result.provider).toBe('railcore');
  });

  it('repeat lookups are served from cache — provider called exactly ONCE', async () => {
    const { router, calls } = fakeRouter({});
    const registry = createProductionToolRegistry({ router });
    for (let i = 0; i < 3; i += 1) {
      const result = await registry.execute(toolCall('Amritsar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([ASR]);
    }
    expect(calls).toHaveLength(1); // quota saved: 2 of 3 calls were cache hits
  });

  it('cache survives a later provider failure (quota-exhaustion resilience)', async () => {
    let failing = false;
    const { router, calls } = fakeRouter({
      stationLookup: providerSuccess('RAILCORE', [ASR]),
    });
    // make subsequent provider calls fail (429-style)
    const original = router.stationLookup.bind(router);
    void original;
    const registry = createProductionToolRegistry({ router });
    const first = await registry.execute(toolCall('Amritsar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(first.ok).toBe(true);

    // switch script to failure and look up the SAME station again
    const mutableProviders = (router as unknown as { providers: { stationLookup: () => Promise<unknown> }[] }).providers;
    const railCoreFake = mutableProviders[0];
    if (railCoreFake) {
      railCoreFake.stationLookup = () => {
        calls.push('RAILCORE:stationLookup(429)');
        return Promise.resolve(providerFailure('RATE_LIMITED', 'quota over', { source: 'RAILCORE' }));
      };
    }
    const second = await registry.execute(toolCall('Amritsar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(second.ok).toBe(true); // cache hit — real data, served without the provider
    expect(second.data).toEqual([ASR]);
    expect(calls).toHaveLength(1); // the failing provider was never called again
  });

  it('failures and empty results are NEVER cached (honest, retryable)', async () => {
    const { router, calls } = fakeRouter({
      stationLookup: providerFailure('RATE_LIMITED', 'quota', { source: 'RAILCORE' }),
    });
    const registry = createProductionToolRegistry({ router });
    const first = await registry.execute(toolCall('Jalandhar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(first.ok).toBe(false); // honest failure
    const second = await registry.execute(toolCall('Jalandhar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(second.ok).toBe(false); // not cached — the provider was retried
    expect(calls).toHaveLength(2);
  });

  it('cache keys are case/trim insensitive ("amritsar " == "Amritsar")', async () => {
    const { router, calls } = fakeRouter({});
    const registry = createProductionToolRegistry({ router });
    await registry.execute(toolCall('Amritsar'), { actor: 'AI', userId: 'u', conversationId: 'c' });
    await registry.execute(toolCall('  amritsar '), { actor: 'AI', userId: 'u', conversationId: 'c' });
    expect(calls).toHaveLength(1);
  });
});
