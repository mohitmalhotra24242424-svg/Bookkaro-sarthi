/**
 * SAFE RAILWAY DIAGNOSTICS.
 *
 * Logs ONLY: operation, provider, success/failure, latency, error category.
 * NEVER logs: API keys, authorization headers, request bodies, railway
 * payloads, PNR numbers, passenger personal information, or wallet data.
 * (Enforced by construction: the event type has no field that could carry
 * any of that, and by tests/railway/railwayDiagnostics.test.ts.)
 */

import type { ProviderError } from '../shared/index.js';

export const RAILWAY_DIAG_CATEGORIES = [
  'AUTH_ERROR',
  'TIMEOUT',
  'RATE_LIMIT',
  'HTTP_ERROR',
  'INVALID_RESPONSE',
  'UNSUPPORTED',
  'UNKNOWN_ERROR',
] as const;

export type RailwayDiagCategory = (typeof RAILWAY_DIAG_CATEGORIES)[number];

export type RailwayDiagOutcome = 'SUCCESS' | 'ZERO_RESULTS' | 'FAILURE';

/** Only whitelisted fields — there is intentionally nowhere to put secrets or payload data. */
export interface RailwayDiagEvent {
  operation: string;
  provider: string;
  outcome: RailwayDiagOutcome;
  latencyMs: number;
  category?: RailwayDiagCategory;
}

export const RAILWAY_DIAGNOSTICS_RULES: readonly string[] = [
  'Log only: operation, provider, outcome, latency, error category.',
  'Never log API keys, authorization headers or credential values.',
  'Never log complete request bodies or complete railway payloads.',
  'Never log PNR numbers, passenger personal information or wallet information.',
  'Never surface stack traces or internal secrets to users.',
];

export function categorizeFailure(error: ProviderError): RailwayDiagCategory {
  switch (error.kind) {
    case 'MISSING_CREDENTIALS':
      return 'AUTH_ERROR';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'RATE_LIMITED':
      return 'RATE_LIMIT';
    case 'INVALID_RESPONSE':
    case 'PROVIDER_FAILURE':
      return 'INVALID_RESPONSE';
    case 'NETWORK_ERROR':
      return 'UNKNOWN_ERROR';
    case 'UNSUPPORTED_CAPABILITY':
    case 'NOT_IMPLEMENTED':
      return 'UNSUPPORTED';
    case 'INVALID_INPUT':
      return 'INVALID_RESPONSE';
    case 'HTTP_ERROR':
      return error.httpStatus === 401 || error.httpStatus === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR';
  }
}

export interface RailwayDiagnostics {
  log(event: RailwayDiagEvent): void;
}

function sanitizeCategory(value: unknown): RailwayDiagCategory | undefined {
  return typeof value === 'string' && (RAILWAY_DIAG_CATEGORIES as readonly string[]).includes(value)
    ? (value as RailwayDiagCategory)
    : undefined;
}

export function createRailwayDiagnostics(options: { sink?: (line: string) => void } = {}): RailwayDiagnostics {
  const sink = options.sink ?? ((line: string) => console.log(line));
  return {
    log(event) {
      const safeEvent: RailwayDiagEvent = {
        operation: String(event.operation).slice(0, 48),
        provider: String(event.provider).slice(0, 24),
        outcome: event.outcome === 'SUCCESS' || event.outcome === 'ZERO_RESULTS' ? event.outcome : 'FAILURE',
        latencyMs: Number.isFinite(event.latencyMs) ? Math.max(0, Math.min(Math.round(event.latencyMs), 600_000)) : 0,
        category: sanitizeCategory(event.category),
      };
      sink(JSON.stringify({ scope: 'railway', ...safeEvent }));
    },
  };
}
