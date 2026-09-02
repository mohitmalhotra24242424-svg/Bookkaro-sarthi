/**
 * RailCore HTTP client — fetch wrapper with timeout, error classification and
 * latency measurement. The API key lives ONLY here (injected via options) and
 * is never logged.
 */

import { providerFailure } from '../../../shared/index.js';
import type { ProviderFailure } from '../../../shared/index.js';
import { asRecord, asString } from '../parse.js';
import {
  RAILCORE_AUTH_HEADER,
  RAILCORE_EMPTY_ERROR_CODES,
  RAILCORE_VALIDATION_ERROR_CODE,
} from './endpoints.js';

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type RailCoreCallOutcome =
  | { kind: 'success'; status: number; body: unknown; latencyMs: number }
  | { kind: 'empty'; emptyReason: 'NO_RESULTS' | 'NOT_FOUND'; latencyMs: number }
  | { kind: 'failure'; failure: ProviderFailure; latencyMs: number };

export interface RailCoreClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

export class RailCoreClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | null;
  private readonly userAgent: string;

  constructor(options: RailCoreClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://ir.railcore.tech/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.userAgent = options.userAgent ?? 'bookkaro-railcore-client/1.0';
    this.fetchImpl = options.fetchImpl ?? null;
  }

  /** Resolved per call so tests can block the network AFTER construction. */
  private fetcher(): FetchLike {
    return this.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
  }

  async get(operation: string, path: string, query: Record<string, string | number | undefined>): Promise<RailCoreCallOutcome> {
    const url = this.buildUrl(path, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetcher()(url, {
        method: 'GET',
        headers: {
          // Credential — server-side only, never logged, never sent anywhere else.
          [RAILCORE_AUTH_HEADER]: this.apiKey,
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      return this.interpret(response, latencyMs, operation);
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (controller.signal.aborted) {
        return {
          kind: 'failure',
          latencyMs,
          failure: providerFailure('TIMEOUT', `RailCore ${operation} timed out after ${this.timeoutMs}ms.`, { latencyMs }),
        };
      }
      return {
        kind: 'failure',
        latencyMs,
        failure: providerFailure('NETWORK_ERROR', `RailCore ${operation} network error: ${errorName(error)}`, { latencyMs }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(path: string, query: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && String(value).length > 0) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async interpret(
    response: { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> },
    latencyMs: number,
    operation: string,
  ): Promise<RailCoreCallOutcome> {
    const status = response.status;

    if (status >= 200 && status < 300) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return unusable(`RailCore ${operation} returned non-JSON body (HTTP ${status}).`, latencyMs);
      }
      const envelope = asRecord(body);
      if (envelope && envelope.success === false) {
        return unusable(`RailCore ${operation} returned success:false.`, latencyMs);
      }
      return { kind: 'success', status, body, latencyMs };
    }

    // Error status: read the documented error envelope when possible.
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      const body = asRecord(await response.json());
      const error = body ? asRecord(body.error) : null;
      errorCode = error ? asString(error.code) : null;
      errorMessage = error ? asString(error.message) : null;
    } catch {
      /* non-JSON error body — fall through to HTTP classification */
    }

    const emptyReason = errorCode ? RAILCORE_EMPTY_ERROR_CODES[errorCode] : undefined;
    if (emptyReason) {
      // Legitimate zero-result / not-found answer (documented, not retryable).
      return { kind: 'empty', emptyReason, latencyMs };
    }
    if (errorCode === RAILCORE_VALIDATION_ERROR_CODE) {
      return {
        kind: 'failure',
        latencyMs,
        failure: providerFailure('INVALID_INPUT', `RailCore rejected the ${operation} query: ${errorMessage ?? 'validation error'}`, {
          httpStatus: status,
        }),
      };
    }
    if (status === 429) {
      return {
        kind: 'failure',
        latencyMs,
        failure: providerFailure('RATE_LIMITED', `RailCore ${operation} rate limited (429).`, {
          httpStatus: 429,
        }),
      };
    }
    return {
      kind: 'failure',
      latencyMs,
      failure: providerFailure('HTTP_ERROR', `RailCore ${operation} failed (HTTP ${status}${errorCode ? ` ${errorCode}` : ''}).`, {
        httpStatus: status,
      }),
    };
  }
}

function unusable(message: string, latencyMs: number): RailCoreCallOutcome {
  return { kind: 'failure', latencyMs, failure: providerFailure('INVALID_RESPONSE', message, { latencyMs }) };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
