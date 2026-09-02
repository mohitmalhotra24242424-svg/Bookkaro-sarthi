import { describe, expect, it } from 'vitest';
import { RailwayProviderRouter, createDefaultRailwayRouter } from '../railway/router.js';
import type { RailwayProvider } from '../railway/index.js';
import { isZeroResult, providerEmpty, providerFailure, providerSuccess } from '../shared/index.js';
import type {
  Fare,
  ProviderEmpty,
  ProviderFailure,
  ProviderId,
  ProviderResult,
  ProviderSuccess,
  RailwayCapability,
  Station,
} from '../shared/index.js';

// ── narrowing helpers ────────────────────────────────────────────────────────

function expectFailure(result: ProviderResult<unknown>): ProviderFailure {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure result');
  return result;
}

function expectSuccess<T>(result: ProviderResult<T>): ProviderSuccess<T> | ProviderEmpty {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a successful result');
  return result;
}

// ── scriptable fake provider ─────────────────────────────────────────────────

function createFakeProvider(
  id: ProviderId,
  capabilities: RailwayCapability[],
  script: Partial<Record<RailwayCapability, ProviderResult<unknown>>> = {},
  throwIn: RailwayCapability[] = [],
) {
  const calls: RailwayCapability[] = [];

  const record = (capability: RailwayCapability): Promise<ProviderResult<unknown>> => {
    calls.push(capability);
    if (throwIn.includes(capability)) {
      return Promise.reject(new Error('provider exploded (unusable)'));
    }
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

const LDH: Station = { code: 'LDH', name: 'Ludhiana Jn', zone: 'NR', state: 'Punjab', latitude: null, longitude: null };

function makeRouter(primary: ReturnType<typeof createFakeProvider>, fallback: ReturnType<typeof createFakeProvider>) {
  return new RailwayProviderRouter({ providers: [primary.provider, fallback.provider] });
}

describe('provider router: primary-first routing', () => {
  it('uses the primary when it succeeds — fallback is never called', async () => {
    const primary = createFakeProvider('RAILCORE', ['stationLookup'], { stationLookup: providerSuccess('RAILCORE', [LDH]) });
    const fallback = createFakeProvider('RAILKIT', ['stationLookup']);
    const result = expectSuccess(await makeRouter(primary, fallback).stationLookup({ query: 'Ludhiana' }));

    expect(result.source).toBe('RAILCORE');
    expect(result.data).toEqual([LDH]);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
  });
});

describe('provider router: fallback policy', () => {
  const fallbackCases: readonly [string, ProviderResult<never>][] = [
    ['HTTP error', providerFailure('HTTP_ERROR', '502 bad gateway', { httpStatus: 502, source: 'RAILCORE' })],
    ['timeout', providerFailure('TIMEOUT', 'request timed out', { source: 'RAILCORE' })],
    ['success:false / unusable body', providerFailure('PROVIDER_FAILURE', 'provider returned success:false', { source: 'RAILCORE' })],
    ['network error', providerFailure('NETWORK_ERROR', 'connection reset', { source: 'RAILCORE' })],
    ['rate limit', providerFailure('RATE_LIMITED', '429', { httpStatus: 429, source: 'RAILCORE' })],
  ];

  for (const [label, failure] of fallbackCases) {
    it(`falls back to RailKit when RailCore fails with ${label}`, async () => {
      const primary = createFakeProvider('RAILCORE', ['liveStatus'], { liveStatus: failure });
      const fallback = createFakeProvider('RAILKIT', ['liveStatus'], { liveStatus: providerSuccess('RAILKIT', { status: 'RUNNING' }) });
      const result = expectSuccess(await makeRouter(primary, fallback).liveStatus({ trainNumber: '12014', journeyDate: null }));

      expect(result.source).toBe('RAILKIT');
      expect(primary.calls).toHaveLength(1);
      expect(fallback.calls).toHaveLength(1);
    });
  }

  it('falls back when the primary throws (unusable)', async () => {
    const primary = createFakeProvider('RAILCORE', ['pnr'], undefined, ['pnr']);
    const fallback = createFakeProvider('RAILKIT', ['pnr'], { pnr: providerSuccess('RAILKIT', { pnr: '1234567890' }) });
    const result = expectSuccess(await makeRouter(primary, fallback).pnr({ pnr: '1234567890' }));

    expect(result.source).toBe('RAILKIT');
  });

  it('does NOT fall back for a legitimate zero-result search', async () => {
    const primary = createFakeProvider('RAILCORE', ['trainSearch'], {
      trainSearch: providerEmpty('RAILCORE', 'NO_RESULTS'),
    });
    const fallback = createFakeProvider('RAILKIT', ['trainSearch']);
    const result = expectSuccess(
      await makeRouter(primary, fallback).trainSearch({ originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2099-01-01' }),
    );

    expect(isZeroResult(result)).toBe(true);
    expect('empty' in result && result.emptyReason).toBe('NO_RESULTS');
    expect(fallback.calls).toHaveLength(0); // zero results is a real answer
  });

  it('does NOT fall back for NOT_FOUND (e.g. unknown train) — it is a real answer', async () => {
    const primary = createFakeProvider('RAILCORE', ['trainInfo'], { trainInfo: providerEmpty('RAILCORE', 'NOT_FOUND') });
    const fallback = createFakeProvider('RAILKIT', ['trainInfo']);
    const result = expectSuccess(await makeRouter(primary, fallback).trainInfo({ trainNumber: '99999' }));

    expect('empty' in result && result.emptyReason).toBe('NOT_FOUND');
    expect(fallback.calls).toHaveLength(0);
  });

  it('does NOT fall back for an invalid query — validation fails before any provider call', async () => {
    const primary = createFakeProvider('RAILCORE', ['trainSearch']);
    const fallback = createFakeProvider('RAILKIT', ['trainSearch']);
    const router = makeRouter(primary, fallback);

    const badDate = expectFailure(await router.trainSearch({ originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2020-01-01' }));
    expect(badDate.error.kind).toBe('INVALID_INPUT');

    const missingDest = expectFailure(await router.trainSearch({ originCode: 'ASR', destinationCode: '', journeyDate: null }));
    expect(missingDest.error.kind).toBe('INVALID_INPUT');

    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
  });

  it('returns INVALID_INPUT for a malformed PNR without calling providers', async () => {
    const primary = createFakeProvider('RAILCORE', ['pnr']);
    const fallback = createFakeProvider('RAILKIT', ['pnr']);
    const result = expectFailure(await makeRouter(primary, fallback).pnr({ pnr: 'abc' }));

    expect(result.error.kind).toBe('INVALID_INPUT');
    expect(primary.calls).toHaveLength(0);
  });
});

describe('provider router: capability awareness', () => {
  it('skips a provider that lacks the capability and uses the one that has it', async () => {
    const noFare = createFakeProvider('RAILCORE', ['trainSearch']); // no 'fare'
    const hasFare = createFakeProvider('RAILKIT', ['fare'], { fare: providerSuccess('RAILKIT', {} as Fare) });
    const result = expectSuccess(
      await makeRouter(noFare, hasFare).fare({
        trainNumber: '12014',
        fromStationCode: 'ASR',
        toStationCode: 'LDH',
        journeyDate: null,
        travelClass: 'CC',
        quota: 'GN',
      }),
    );

    expect(result.source).toBe('RAILKIT');
    expect(noFare.calls).toHaveLength(0); // unsupported capability is never called
    expect(hasFare.calls).toHaveLength(1);
  });

  it('reports UNSUPPORTED_CAPABILITY when no provider can serve the request', async () => {
    const a = createFakeProvider('RAILCORE', ['trainSearch']);
    const b = createFakeProvider('RAILKIT', ['trainSearch']);
    const result = expectFailure(
      await makeRouter(a, b).availability({
        trainNumber: '12014',
        journeyDate: '2099-01-01',
        travelClass: 'SL',
        quota: 'GN',
        fromStationCode: 'ASR',
        toStationCode: 'LDH',
      }),
    );

    expect(result.error.kind).toBe('UNSUPPORTED_CAPABILITY');
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });
});

describe('provider router: default stack (real adapters, no credentials)', () => {
  it('honestly fails MISSING_CREDENTIALS (tries RailCore then RailKit) and fabricates nothing', async () => {
    const router = createDefaultRailwayRouter();
    const result = expectFailure(await router.liveStatus({ trainNumber: '12014', journeyDate: null }));

    expect(result.error.kind).toBe('MISSING_CREDENTIALS');
    expect(result.source).toBe('RAILKIT'); // both were tried; last failure surfaced
  });

  it('validates availability queries (past dates rejected)', async () => {
    const router = createDefaultRailwayRouter();
    const result = expectFailure(
      await router.availability({
        trainNumber: '12014',
        journeyDate: '2020-01-01',
        travelClass: null,
        quota: null,
        fromStationCode: 'ASR',
        toStationCode: 'LDH',
      }),
    );
    expect(result.error.kind).toBe('INVALID_INPUT');
  });
});
