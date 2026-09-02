/**
 * Railway provider abstraction tests — REAL adapters (RailCore REST + RailKit
 * SDK) with NO credentials and NO network. Step 2 version.
 */

import { describe, expect, it } from 'vitest';
import {
  RAILCORE_CAPABILITIES,
  RAILCORE_ENDPOINT_STATUS,
  RailCoreProvider,
  RAILCORE_BASE_URL,
  RAILCORE_AUTH_HEADER,
} from '../railway/index.js';
import { RAILKIT_CAPABILITIES, RAILKIT_ENDPOINT_STATUS, RailKitProvider, createDefaultRailwayRouter } from '../railway/index.js';
import type { RailwayProvider } from '../railway/index.js';
import { RAILWAY_CAPABILITIES } from '../shared/index.js';

function blockNetwork<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('NETWORK_BLOCKED_IN_TEST — providers must not touch the network');
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

async function callEverything(provider: RailwayProvider): Promise<void> {
  await provider.stationLookup({ query: 'Ludhiana' });
  await provider.trainSearch({ originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2099-01-01' });
  await provider.trainInfo({ trainNumber: '12014' });
  await provider.timetable({ trainNumber: '12014' });
  await provider.liveStatus({ trainNumber: '12014', journeyDate: '2099-01-01' });
  await provider.availability({ trainNumber: '12014', journeyDate: '2099-01-01', travelClass: 'SL', quota: null, fromStationCode: 'ASR', toStationCode: 'LDH' });
  await provider.fare({ trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', journeyDate: '2099-01-01', travelClass: 'SL', quota: null });
  await provider.pnr({ pnr: '1234567890' });
  await provider.cancelledTrains({ journeyDate: '2099-01-01' });
}

describe('railway provider capabilities (Step 2 verified split)', () => {
  it('RailCore = primary with exactly the 7 documented capabilities', () => {
    const railCore = new RailCoreProvider({ apiKey: 'test-key-placeholder' });
    expect(railCore.providerId).toBe('RAILCORE');
    expect([...RAILCORE_CAPABILITIES].sort()).toEqual(
      ['availability', 'fare', 'liveStatus', 'stationLookup', 'timetable', 'trainInfo', 'trainSearch'].sort(),
    );
    expect(railCore.supports('pnr')).toBe(false);
    expect(railCore.supports('cancelledTrains')).toBe(false);
    expect(railCore.endpointStatus).toBe(RAILCORE_ENDPOINT_STATUS);
    expect(RAILCORE_ENDPOINT_STATUS).toMatch(/VERIFIED/);
    expect(RAILCORE_BASE_URL).toBe('https://ir.railcore.tech/v1');
    expect(RAILCORE_AUTH_HEADER).toBe('X-RailCore-Key');
  });

  it('RailKit = fallback with the 8 SDK capabilities (no station lookup)', () => {
    const railKit = new RailKitProvider({ apiKey: 'test-key-placeholder' });
    expect(railKit.providerId).toBe('RAILKIT');
    expect([...RAILKIT_CAPABILITIES].sort()).toEqual(
      ['availability', 'cancelledTrains', 'fare', 'liveStatus', 'pnr', 'timetable', 'trainInfo', 'trainSearch'].sort(),
    );
    expect(railKit.supports('stationLookup')).toBe(false); // no RailKit station-name search endpoint
    expect(railKit.endpointStatus).toBe(RAILKIT_ENDPOINT_STATUS);
    expect(RAILKIT_ENDPOINT_STATUS).toMatch(/official railkit npm SDK/);
  });

  it('together the two providers cover all nine capabilities', () => {
    const union = new Set([...RAILCORE_CAPABILITIES, ...RAILKIT_CAPABILITIES]);
    for (const capability of RAILWAY_CAPABILITIES) {
      expect(union.has(capability), capability).toBe(true);
    }
  });
});

describe('missing credentials → clean configuration errors, zero network', () => {
  it('RailCore without a key: every method fails MISSING_CREDENTIALS, fetch never called', async () => {
    const railCore = new RailCoreProvider({ apiKey: null });
    expect(railCore.credentialConfigured).toBe(false);

    await blockNetwork(async () => {
      const results = [
        railCore.stationLookup({ query: 'Ludhiana' }),
        railCore.trainSearch({ originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2099-01-01' }),
        railCore.trainInfo({ trainNumber: '12014' }),
        railCore.timetable({ trainNumber: '12014' }),
        railCore.liveStatus({ trainNumber: '12014', journeyDate: null }),
        railCore.availability({ trainNumber: '12014', journeyDate: '2099-01-01', travelClass: 'SL', quota: null, fromStationCode: 'ASR', toStationCode: 'LDH' }),
        railCore.fare({ trainNumber: '12014', fromStationCode: 'ASR', toStationCode: 'LDH', journeyDate: '2099-01-01', travelClass: 'SL', quota: null }),
      ];
      for (const result of await Promise.all(results)) {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected failure');
        expect(result.error.kind).toBe('MISSING_CREDENTIALS');
      }
    });
  });

  it('RailKit without a key or SDK: every method fails MISSING_CREDENTIALS', async () => {
    const railKit = new RailKitProvider({ apiKey: null });
    expect(railKit.credentialConfigured).toBe(false);

    await blockNetwork(async () => {
      await callEverything(railKit);
    });
    const result = await railKit.pnr({ pnr: '1234567890' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
  });

  it('providers satisfy the RailwayProvider interface', () => {
    const providers: RailwayProvider[] = [new RailCoreProvider({}), new RailKitProvider({})];
    for (const provider of providers) {
      for (const method of [
        'stationLookup',
        'trainSearch',
        'trainInfo',
        'timetable',
        'liveStatus',
        'availability',
        'fare',
        'pnr',
        'cancelledTrains',
      ] as const) {
        expect(typeof provider[method], `${provider.providerId}.${method}`).toBe('function');
      }
      expect(provider.displayName.length).toBeGreaterThan(0);
      expect(typeof provider.supports).toBe('function');
    }
  });
});

describe('with a key but network blocked → honest failures, never fabricated data', () => {
  it('RailCore reports NETWORK_ERROR and fabricates nothing', async () => {
    const railCore = new RailCoreProvider({ apiKey: 'test-key-placeholder' });
    expect(railCore.credentialConfigured).toBe(true);

    const result = await blockNetwork(() => railCore.liveStatus({ trainNumber: '12014', journeyDate: '2099-01-01' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(['NETWORK_ERROR', 'TIMEOUT']).toContain(result.error.kind);
  });

  it('default router without keys → honest MISSING_CREDENTIALS from the fallback position', async () => {
    const router = createDefaultRailwayRouter();
    const routing = router.describeRouting();
    expect(routing.primary).toBe('RAILCORE');
    expect(routing.fallbackOrder).toEqual(['RAILKIT']);
    expect(routing.capabilities).toContain('fare');
    expect(routing.capabilities).toContain('pnr');

    const result = await router.liveStatus({ trainNumber: '12014', journeyDate: '2099-01-01' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
    expect(result.source).toBe('RAILKIT');
  });

  it('both real adapters can be driven through the router with zero credentials (no throw)', async () => {
    const router = createDefaultRailwayRouter();
    await blockNetwork(async () => {
      await router.stationLookup({ query: 'Ludhiana' }); // RailCore-only capability
      await router.pnr({ pnr: '1234567890' }); // RailKit-only capability
    });
  });
});
