/**
 * Railway API route tests (HTTP level, server DI with scriptable providers).
 * MOCK TESTS — no live calls, no real credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createBookKaroServer } from '../../api/server.js';
import { RailwayProviderRouter } from '../../railway/router.js';
import type { RailwayProvider } from '../../railway/index.js';
import { providerEmpty, providerFailure, providerSuccess } from '../../shared/index.js';
import type {
  Availability,
  Fare,
  ProviderId,
  ProviderResult,
  RailwayCapability,
  Station,
} from '../../shared/index.js';

function createFakeProvider(
  id: ProviderId,
  capabilities: RailwayCapability[],
  script: Partial<Record<RailwayCapability, ProviderResult<unknown>>> = {},
) {
  const calls: RailwayCapability[] = [];
  const record = (capability: RailwayCapability): Promise<ProviderResult<unknown>> => {
    calls.push(capability);
    return Promise.resolve(script[capability] ?? providerEmpty(id));
  };
  const provider = {
    providerId: id,
    displayName: `${id}-fake`,
    capabilities,
    supports: (capability: RailwayCapability) => capabilities.includes(capability),
    stationLookup: () => record('stationLookup'),
    trainSearch: () => record('trainSearch'),
    trainInfo: () => record('trainInfo'),
    timetable: () => record('timetable'),
    liveStatus: () => record('liveStatus'),
    availability: () => record('availability'),
    fare: () => record('fare'),
    pnr: () => record('pnr'),
    cancelledTrains: () => record('cancelledTrains'),
  } as unknown as RailwayProvider;
  return { provider, calls };
}

const LDH: Station = { code: 'LDH', name: 'Ludhiana Jn', zone: null, state: 'Punjab', latitude: null, longitude: null };
const ASR: Station = { code: 'ASR', name: 'Amritsar Jn', zone: null, state: 'Punjab', latitude: null, longitude: null };

function makeServer(
  railCoreScript: Partial<Record<RailwayCapability, ProviderResult<unknown>>>,
  railKitScript: Partial<Record<RailwayCapability, ProviderResult<unknown>>> = {},
  railCoreCaps: RailwayCapability[] = ['stationLookup', 'trainSearch', 'trainInfo', 'timetable', 'liveStatus', 'availability', 'fare'],
) {
  const railCore = createFakeProvider('RAILCORE', railCoreCaps, railCoreScript);
  const railKit = createFakeProvider('RAILKIT', [...railCoreCaps.filter((c) => c !== 'stationLookup'), 'pnr', 'cancelledTrains'], railKitScript);
  const router = new RailwayProviderRouter({ providers: [railCore.provider, railKit.provider] });
  return { server: createBookKaroServer({ railwayRouter: router }), railCore, railKit };
}

let server: Server;
let baseUrl: string;

function start(testServer: Server): Promise<void> {
  server = testServer;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

beforeAll(async () => {
  await start(makeServer(
    { stationLookup: providerSuccess('RAILCORE', [ASR, LDH]) },
    { stationLookup: providerSuccess('RAILKIT', [LDH]) },
  ).server);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('railway routes: success envelopes', () => {
  it('GET /api/railway/stations → { success, provider: "railcore", data }', async () => {
    const response = await fetch(`${baseUrl}/api/railway/stations?q=Ludhiana`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.provider).toBe('railcore');
    expect(typeof body.latencyMs).toBe('number');
    expect(body.data).toEqual([ASR, LDH]);
  });

  it('fallback answer is labeled "railkit_fallback"', async () => {
    const stack = makeServer(
      { trainSearch: providerFailure('HTTP_ERROR', '502', { httpStatus: 502, source: 'RAILCORE' }) },
      { trainSearch: providerSuccess('RAILKIT', []) },
    );
    const localServer = stack.server;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/railway/trains?from=ASR&to=LDH&date=2099-01-01`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.provider).toBe('railkit_fallback');
      expect(body.data).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it('legitimate zero-result search → success with empty flag', async () => {
    const stack = makeServer({ trainSearch: providerEmpty('RAILCORE', 'NO_RESULTS') });
    const localServer = stack.server;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/railway/trains?from=ASR&to=LDH&date=2099-01-01`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.empty).toBe(true);
      expect(body.reason).toBe('NO_RESULTS');
      expect(body.data).toBeNull();
      expect(body.provider).toBe('railcore');
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});

describe('railway routes: failure envelopes', () => {
  it('both providers fail → 503 RAILWAY_DATA_UNAVAILABLE with category', async () => {
    const stack = makeServer(
      { liveStatus: providerFailure('HTTP_ERROR', '502', { httpStatus: 502, source: 'RAILCORE' }) },
      { liveStatus: providerFailure('INVALID_RESPONSE', 'success:false', { source: 'RAILKIT' }) },
    );
    const localServer = stack.server;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/railway/live-status?train=12014&date=2099-01-01`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toBe('RAILWAY_DATA_UNAVAILABLE');
      expect(body.category).toBe('INVALID_RESPONSE');
      expect(body.provider).toBe('railkit'); // last attempted provider, honestly reported
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it('invalid query → 400 INVALID_RAILWAY_QUERY (no provider called)', async () => {
    const stack = makeServer({});
    const localServer = stack.server;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const badPnr = await fetch(`http://127.0.0.1:${address.port}/api/railway/pnr?pnr=123`);
      expect(badPnr.status).toBe(400);
      const body = (await badPnr.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_RAILWAY_QUERY');

      const missingTrain = await fetch(`http://127.0.0.1:${address.port}/api/railway/train-info`);
      expect(missingTrain.status).toBe(400);

      expect(stack.railCore.calls).toHaveLength(0);
      expect(stack.railKit.calls).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it('unsupported capability → 501 RAILWAY_CAPABILITY_UNSUPPORTED', async () => {
    // Single RailCore-only stack: nobody supports pnr.
    const railCoreOnly = createFakeProvider('RAILCORE', ['trainSearch', 'fare', 'availability']);
    const router = new RailwayProviderRouter({ providers: [railCoreOnly.provider] });
    const localServer = createBookKaroServer({ railwayRouter: router });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/railway/pnr?pnr=1234567890`);
      expect(response.status).toBe(501);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('RAILWAY_CAPABILITY_UNSUPPORTED');
      expect(railCoreOnly.calls).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it('unknown railway route → 404', async () => {
    const response = await fetch(`${baseUrl}/api/railway/teleport`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('NOT_FOUND');
  });
});

describe('provider-config: safe diagnostics only', () => {
  it('exposes capabilities and configured-state booleans — never keys', async () => {
    const response = await fetch(`${baseUrl}/api/railway/provider-config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.success).toBe(true);
    expect(body.primary).toBe('railcore');
    expect(body.fallbackOrder).toEqual(['railkit']);

    const providers = body.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    expect(providers[0]?.provider).toBe('railcore');
    expect(providers[0]?.role).toBe('primary');
    expect(providers[1]?.role).toBe('fallback');
    expect((providers[1]?.capabilities as string[]).sort()).toEqual(
      ['availability', 'cancelledTrains', 'fare', 'pnr', 'timetable', 'trainInfo', 'trainSearch', 'liveStatus'].sort(),
    );

    const operations = body.operations as Array<Record<string, unknown>>;
    const stationOp = operations.find((op) => op.operation === 'stationLookup');
    expect(stationOp?.supportedBy).toEqual(['railcore']);
    const pnrOp = operations.find((op) => op.operation === 'pnr');
    expect(pnrOp?.supportedBy).toEqual(['railkit']);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/AIza|sk-|Bearer/); // no key-like material
    expect(serialized).not.toMatch(/API_KEY=/); // no values
  });
});

describe('normalized data flows through the routes', () => {
  it('fare and availability routes return normalized shapes', async () => {
    const fare: Fare = {
      trainNumber: '12014',
      fromStationCode: 'ASR',
      toStationCode: 'LDH',
      journeyDate: null,
      travelClass: 'CC',
      quota: 'GN',
      currency: 'INR',
      breakdown: { baseFareMinor: null, reservationChargeMinor: null, superfastChargeMinor: null, dynamicFareMinor: null, cateringChargeMinor: null, gstMinor: null, totalMinor: 40500 },
      source: 'RAILCORE',
      retrievedAt: '2026-08-26T00:00:00.000Z',
    };
    const availability: Availability = {
      trainNumber: '12014',
      journeyDate: '2099-01-01',
      travelClass: 'CC',
      quota: 'GN',
      status: 'AVAILABLE',
      availableCount: 12,
      racCount: null,
      waitlistNumber: null,
      asOf: null,
    };
    const stack = makeServer({ fare: providerSuccess('RAILCORE', fare), availability: providerSuccess('RAILCORE', availability) });
    const localServer = stack.server;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    try {
      const fareResponse = await fetch(`http://127.0.0.1:${address.port}/api/railway/fare?train=12014&from=ASR&to=LDH&class=CC&quota=GN`);
      const fareBody = (await fareResponse.json()) as Record<string, unknown>;
      expect(fareBody.success).toBe(true);
      expect((fareBody.data as Fare).breakdown.totalMinor).toBe(40500);

      const availabilityResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/railway/availability?train=12014&from=ASR&to=LDH&date=2099-01-01&class=CC&quota=GN`,
      );
      const availabilityBody = (await availabilityResponse.json()) as Record<string, unknown>;
      expect(availabilityBody.success).toBe(true);
      expect((availabilityBody.data as Availability).status).toBe('AVAILABLE');
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});
