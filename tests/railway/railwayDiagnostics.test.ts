/**
 * Safe railway diagnostics tests — proves logs carry ONLY whitelisted fields
 * and NEVER keys, Authorization headers, PNR numbers or payload data.
 * MOCK TESTS.
 */

import { describe, expect, it } from 'vitest';
import {
  RAILWAY_DIAGNOSTICS_RULES,
  RAILWAY_DIAG_CATEGORIES,
  categorizeFailure,
  createRailwayDiagnostics,
} from '../../railway/diagnostics.js';
import { providerFailure } from '../../shared/index.js';
import { RailwayProviderRouter } from '../../railway/router.js';
import { RailCoreProvider } from '../../railway/providers/railcore/index.js';
import type { FetchLike } from '../../railway/providers/railcore/index.js';
import { RailKitProvider } from '../../railway/providers/railkit/index.js';
import type { RailKitSdkLike } from '../../railway/providers/railkit/index.js';
import { RAILCORE_STATION_SEARCH_FIXTURE } from '../../railway/providers/railcore/fixtures.js';
import { RAILKIT_PNR_FIXTURE } from '../../railway/providers/railkit/fixtures.js';

describe('error categorization', () => {
  it('maps provider failures into the seven safe categories', () => {
    expect(categorizeFailure(providerFailure('TIMEOUT', 't').error)).toBe('TIMEOUT');
    expect(categorizeFailure(providerFailure('RATE_LIMITED', 'r').error)).toBe('RATE_LIMIT');
    expect(categorizeFailure(providerFailure('HTTP_ERROR', 'h', { httpStatus: 502 }).error)).toBe('HTTP_ERROR');
    expect(categorizeFailure(providerFailure('HTTP_ERROR', 'h', { httpStatus: 401 }).error)).toBe('AUTH_ERROR');
    expect(categorizeFailure(providerFailure('HTTP_ERROR', 'h', { httpStatus: 403 }).error)).toBe('AUTH_ERROR');
    expect(categorizeFailure(providerFailure('INVALID_RESPONSE', 'i').error)).toBe('INVALID_RESPONSE');
    expect(categorizeFailure(providerFailure('PROVIDER_FAILURE', 'p').error)).toBe('INVALID_RESPONSE');
    expect(categorizeFailure(providerFailure('NETWORK_ERROR', 'n').error)).toBe('UNKNOWN_ERROR');
    expect(categorizeFailure(providerFailure('UNSUPPORTED_CAPABILITY', 'u').error)).toBe('UNSUPPORTED');
    expect(categorizeFailure(providerFailure('MISSING_CREDENTIALS', 'm').error)).toBe('AUTH_ERROR');
  });

  it('exposes exactly the seven documented categories', () => {
    expect([...RAILWAY_DIAG_CATEGORIES].sort()).toEqual(
      ['AUTH_ERROR', 'HTTP_ERROR', 'INVALID_RESPONSE', 'RATE_LIMIT', 'TIMEOUT', 'UNKNOWN_ERROR', 'UNSUPPORTED'].sort(),
    );
  });
});

describe('diagnostics event shaping', () => {
  it('serializes ONLY whitelisted fields', () => {
    const lines: string[] = [];
    const diagnostics = createRailwayDiagnostics({ sink: (line) => lines.push(line) });

    const smuggled: unknown = {
      operation: 'trainSearch',
      provider: 'RAILCORE',
      outcome: 'SUCCESS',
      latencyMs: 123,
      apiKey: 'SUPER_SECRET_KEY', // forbidden — must be dropped
      pnr: '4123456789', // forbidden — must be dropped
      payload: { big: 'railway payload' }, // forbidden — must be dropped
    };
    diagnostics.log(smuggled as never);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    const allowed = new Set(['category', 'latencyMs', 'operation', 'outcome', 'provider', 'scope']);
    for (const key of Object.keys(parsed)) {
      expect(allowed.has(key), `unexpected log field "${key}"`).toBe(true);
    }
    expect(parsed.category).toBeUndefined(); // success events carry no category
    expect(lines[0]).not.toContain('SUPER_SECRET_KEY');
    expect(lines[0]).not.toContain('4123456789');
    expect(lines[0]).not.toContain('payload');
  });

  it('sanitizes latency and drops unknown categories', () => {
    const lines: string[] = [];
    const diagnostics = createRailwayDiagnostics({ sink: (line) => lines.push(line) });
    diagnostics.log({ operation: 'x'.repeat(200), provider: 'RAILCORE', outcome: 'WEIRD' as never, latencyMs: -20 });
    diagnostics.log({ operation: 'fare', provider: 'RAILKIT', outcome: 'FAILURE', latencyMs: 9_999_999, category: 'NOT_A_CATEGORY' as never });

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.operation).toHaveLength(48);
    expect(first.outcome).toBe('FAILURE'); // invalid outcome coerced to FAILURE
    expect(first.latencyMs).toBe(0);
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.category).toBeUndefined();
    expect(second.latencyMs).toBe(600_000);
  });

  it('documents the never-log rules', () => {
    const rules = RAILWAY_DIAGNOSTICS_RULES.join(' ');
    expect(rules).toMatch(/Never log API keys/i);
    expect(rules).toMatch(/PNR numbers/i);
    expect(rules).toMatch(/wallet/i);
  });
});

describe('end-to-end: real adapters never leak secrets or PNRs into diagnostic logs (MOCK)', () => {
  it('full router run with test keys and a PNR query — logs stay clean', async () => {
    const lines: string[] = [];
    const diagnostics = createRailwayDiagnostics({ sink: (line) => lines.push(line) });

    const railCoreFetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => RAILCORE_STATION_SEARCH_FIXTURE,
        text: async () => '{}',
      });
    const sdk = {
      checkPNRStatus: async () => RAILKIT_PNR_FIXTURE,
      getTrainInfo: async () => ({}),
      trackTrain: async () => ({}),
      searchTrainBetweenStations: async () => ({ success: true, data: [] }),
      getAvailability: async () => ({}),
      fareLookup: async () => ({}),
      cancelList: async () => ({}),
    } as unknown as RailKitSdkLike;

    const router = new RailwayProviderRouter({
      providers: [
        new RailCoreProvider({ apiKey: 'RAILCORE_SECRET_FOR_LOG_TEST', fetchImpl: railCoreFetch, onDiagnostic: diagnostics.log }),
        new RailKitProvider({ apiKey: 'RAILKIT_SECRET_FOR_LOG_TEST', sdk, onDiagnostic: diagnostics.log }),
      ],
    });

    await router.stationLookup({ query: 'Ludhiana' });
    await router.pnr({ pnr: '4123456789' });

    expect(lines).toHaveLength(2); // one SUCCESS line per provider operation

    // An invalid query never reaches a provider → no diagnostic line at all.
    await router.trainSearch({ originCode: 'BSL', destinationCode: 'ADI', journeyDate: '1999-01-01' });
    expect(lines).toHaveLength(2);
    const allLogs = lines.join('\n');
    expect(allLogs).not.toContain('RAILCORE_SECRET_FOR_LOG_TEST');
    expect(allLogs).not.toContain('RAILKIT_SECRET_FOR_LOG_TEST');
    expect(allLogs).not.toContain('4123456789'); // PNR never logged
    expect(allLogs).not.toContain('Bhusaval'); // payload data never logged
    expect(allLogs).not.toContain('Authorization');
    expect(allLogs).not.toContain('x-api-key');
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowed = new Set(['category', 'latencyMs', 'operation', 'outcome', 'provider', 'scope']);
      for (const key of Object.keys(parsed)) {
        expect(allowed.has(key), `unexpected log field "${key}"`).toBe(true);
      }
    }
  });
});
