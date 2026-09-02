/** Constructors and guards for ProviderResult envelopes. */

import type {
  ProviderEmpty,
  ProviderErrorKind,
  ProviderFailure,
  ProviderId,
  ProviderResult,
  ProviderSuccess,
} from './types/railway.js';

/** Kinds that must NOT trigger fallback (bad input / unsupported capability are real answers). */
const FALLBACK_INELIGIBLE_KINDS: readonly ProviderErrorKind[] = ['INVALID_INPUT', 'UNSUPPORTED_CAPABILITY'];

export function providerSuccess<T>(
  source: ProviderId,
  data: T,
  retrievedAt: string = new Date().toISOString(),
  extra: { latencyMs?: number; viaFallback?: boolean } = {},
): ProviderSuccess<T> {
  return { ok: true, source, data, retrievedAt, ...extra };
}

export function providerEmpty(
  source: ProviderId,
  emptyReason: 'NO_RESULTS' | 'NOT_FOUND' = 'NO_RESULTS',
  retrievedAt: string = new Date().toISOString(),
  extra: { latencyMs?: number; viaFallback?: boolean } = {},
): ProviderEmpty {
  return { ok: true, source, data: null, empty: true, emptyReason, retrievedAt, ...extra };
}

export function providerFailure(
  kind: ProviderErrorKind,
  message: string,
  options: {
    source?: ProviderId | null;
    httpStatus?: number | null;
    fallbackEligible?: boolean;
    latencyMs?: number;
  } = {},
): ProviderFailure {
  return {
    ok: false,
    source: options.source ?? null,
    latencyMs: options.latencyMs,
    error: {
      kind,
      message,
      httpStatus: options.httpStatus ?? null,
      fallbackEligible: options.fallbackEligible ?? !FALLBACK_INELIGIBLE_KINDS.includes(kind),
    },
  };
}

export function isProviderFailure(result: ProviderResult<unknown>): result is ProviderFailure {
  return !result.ok;
}

/** Type guard: true when a result is a legitimate empty answer (never a fallback trigger). */
export function isZeroResult<T>(result: ProviderResult<T>): result is ProviderEmpty {
  return result.ok && 'empty' in result && result.empty === true;
}
