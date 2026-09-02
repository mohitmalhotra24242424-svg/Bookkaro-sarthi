/**
 * RailCore — PRIMARY railway provider (REAL adapter, verified endpoints).
 *
 * Contract: official RailCore docs (railcore.tech/docs, captured 2026-08-26).
 * Auth: X-RailCore-Key with RAILCORE_API_KEY — SERVER-SIDE ONLY, injected via
 * constructor options, never logged, never exposed to the frontend.
 *
 * Without an API key every operation returns an honest MISSING_CREDENTIALS
 * failure (clean configuration error) and performs ZERO network calls.
 */

import { isoDateOf, isZeroResult, providerEmpty, providerFailure, providerSuccess } from '../../../shared/index.js';
import type {
  Availability,
  AvailabilityQuery,
  CancelledTrain,
  CancelledTrainsQuery,
  Fare,
  FareQuery,
  ProviderFailure,
  LiveStatus,
  LiveStatusQuery,
  PNRQuery,
  PNRStatus,
  ProviderId,
  ProviderResult,
  QuotaCode,
  RailwayCapability,
  Station,
  StationLookupQuery,
  Timetable,
  Train,
  TrainRefQuery,
  TrainSearchQuery,
  TrainSearchResult,
  TravelClassCode,
} from '../../../shared/index.js';
import type { RailwayProvider } from '../../RailwayProvider.js';
import type { RailwayDiagEvent } from '../../diagnostics.js';
import { categorizeFailure } from '../../diagnostics.js';
import { RailCoreClient } from './client.js';
import type { FetchLike, RailCoreCallOutcome } from './client.js';
import { RAILCORE_ENDPOINTS, RAILCORE_ENDPOINT_STATUS } from './endpoints.js';
import {
  normalizeRailCoreAvailability,
  normalizeRailCoreFare,
  normalizeRailCoreLiveStatus,
  normalizeRailCoreStations,
  normalizeRailCoreTimetable,
  normalizeRailCoreTrainInfo,
  normalizeRailCoreTrainSearch,
  retrievedAtFromMeta,
} from './normalize.js';

/** Verified RailCore capabilities (per Step 2 spec + official docs). PNR & cancelled are RailKit's. */
export const RAILCORE_CAPABILITIES: readonly RailwayCapability[] = [
  'stationLookup',
  'trainSearch',
  'trainInfo',
  'timetable',
  'liveStatus',
  'availability',
  'fare',
];

export interface RailCoreProviderOptions {
  /** RAILCORE_API_KEY from the server environment. null → honest MISSING_CREDENTIALS. */
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  onDiagnostic?: (event: RailwayDiagEvent) => void;
}

interface CallPlan {
  operation: RailwayCapability;
  path: string;
  query: Record<string, string | number | undefined>;
}

export class RailCoreProvider implements RailwayProvider {
  readonly providerId: ProviderId = 'RAILCORE';
  readonly displayName = 'RailCore';
  readonly capabilities: readonly RailwayCapability[] = RAILCORE_CAPABILITIES;
  readonly credentialConfigured: boolean;
  readonly endpointStatus = RAILCORE_ENDPOINT_STATUS;

  private readonly client: RailCoreClient | null;
  private readonly onDiagnostic?: (event: RailwayDiagEvent) => void;

  constructor(options: RailCoreProviderOptions = {}) {
    const apiKey = options.apiKey && options.apiKey.trim().length > 0 ? options.apiKey.trim() : null;
    this.credentialConfigured = apiKey !== null;
    this.client = apiKey
      ? new RailCoreClient({
          apiKey,
          baseUrl: options.baseUrl,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        })
      : null;
    this.onDiagnostic = options.onDiagnostic;
  }

  supports(capability: RailwayCapability): boolean {
    return this.capabilities.includes(capability);
  }

  // ── unsupported capabilities: honest refusal, never fabricated support ──

  pnr(_query: PNRQuery): Promise<ProviderResult<PNRStatus>> {
    return Promise.resolve(this.unsupported('pnr'));
  }

  cancelledTrains(_query: CancelledTrainsQuery): Promise<ProviderResult<CancelledTrain[]>> {
    return Promise.resolve(this.unsupported('cancelledTrains'));
  }

  // ── supported capabilities ──

  stationLookup(query: StationLookupQuery): Promise<ProviderResult<Station[]>> {
    return this.call('stationLookup', {
      operation: 'stationLookup',
      path: RAILCORE_ENDPOINTS.stationLookup.path,
      query: { q: query.query, limit: 20 },
    }, (outcome) => {
      const stations = normalizeRailCoreStations(outcome.body);
      return stations === null
        ? this.unusable('stationLookup', outcome.latencyMs)
        : this.listResult('stationLookup', stations, outcome);
    });
  }

  trainSearch(query: TrainSearchQuery): Promise<ProviderResult<TrainSearchResult[]>> {
    // Verified: RailCore /routes/trains REQUIRES a journey date. Without one the
    // query is honestly invalid at this provider (no fallback — fix the query).
    if (!query.journeyDate) {
      return Promise.resolve(this.invalid('trainSearch', 'RailCore train search requires a journey date.'));
    }
    return this.call('trainSearch', {
      operation: 'trainSearch',
      path: RAILCORE_ENDPOINTS.trainSearch.path,
      query: {
        from: query.originCode.toUpperCase(),
        to: query.destinationCode.toUpperCase(),
        date: query.journeyDate,
      },
    }, (outcome) => {
      const trains = normalizeRailCoreTrainSearch(outcome.body);
      return trains === null
        ? this.unusable('trainSearch', outcome.latencyMs)
        : this.listResult('trainSearch', trains, outcome);
    });
  }

  trainInfo(query: TrainRefQuery): Promise<ProviderResult<Train>> {
    return this.call('trainInfo', {
      operation: 'trainInfo',
      path: RAILCORE_ENDPOINTS.trainInfo.path.replace('{train_number}', query.trainNumber),
      query: {},
    }, (outcome) => {
      const train = normalizeRailCoreTrainInfo(outcome.body);
      return train === null ? this.unusable('trainInfo', outcome.latencyMs) : this.valueResult('trainInfo', train, outcome);
    });
  }

  timetable(query: TrainRefQuery): Promise<ProviderResult<Timetable>> {
    return this.call('timetable', {
      operation: 'timetable',
      path: RAILCORE_ENDPOINTS.timetable.path.replace('{train_number}', query.trainNumber),
      query: { include_intermediate: 'false' },
    }, (outcome) => {
      const timetable = normalizeRailCoreTimetable(outcome.body);
      return timetable === null ? this.unusable('timetable', outcome.latencyMs) : this.valueResult('timetable', timetable, outcome);
    });
  }

  liveStatus(query: LiveStatusQuery): Promise<ProviderResult<LiveStatus>> {
    // Verified: RailCore live requires `date`. "12014 ka live status" means the
    // current run — defaulting to today is query semantics, not data fabrication
    // (RailKit's trackTrain documents the same default).
    const journeyDate = query.journeyDate ?? isoDateOf();
    return this.call('liveStatus', {
      operation: 'liveStatus',
      path: RAILCORE_ENDPOINTS.liveStatus.path.replace('{train_number}', query.trainNumber),
      query: { date: journeyDate },
    }, (outcome) => {
      const status = normalizeRailCoreLiveStatus(outcome.body, query.trainNumber);
      return status === null ? this.unusable('liveStatus', outcome.latencyMs) : this.valueResult('liveStatus', status, outcome);
    });
  }

  availability(query: AvailabilityQuery): Promise<ProviderResult<Availability>> {
    // Verified: RailCore requires from/to/date/class.
    if (!query.fromStationCode || !query.toStationCode || !query.travelClass) {
      return Promise.resolve(
        this.invalid('availability', 'RailCore availability requires train, from, to, date and class.'),
      );
    }
    const normalizedClass = query.travelClass.toUpperCase() as TravelClassCode;
    const quota = (query.quota ?? 'GN').toUpperCase();
    return this.call('availability', {
      operation: 'availability',
      path: RAILCORE_ENDPOINTS.availability.path,
      query: {
        train_number: query.trainNumber,
        from: query.fromStationCode.toUpperCase(),
        to: query.toStationCode.toUpperCase(),
        date: query.journeyDate,
        class: normalizedClass,
        quota,
      },
    }, (outcome) => {
      const availability = normalizeRailCoreAvailability(outcome.body, {
        trainNumber: query.trainNumber,
        journeyDate: query.journeyDate,
        travelClass: normalizedClass,
        quota: quota as QuotaCode,
      });
      return availability === null
        ? this.unusable('availability', outcome.latencyMs)
        : this.valueResult('availability', availability, outcome);
    });
  }

  fare(query: FareQuery): Promise<ProviderResult<Fare>> {
    // Verified: RailCore fare estimate requires train/from/to (date-independent).
    if (!query.fromStationCode || !query.toStationCode) {
      return Promise.resolve(this.invalid('fare', 'RailCore fare estimate requires from and to stations.'));
    }
    const travelClass = query.travelClass ? query.travelClass.toUpperCase() : null;
    const quota = (query.quota ?? 'GN').toUpperCase();
    return this.call('fare', {
      operation: 'fare',
      path: RAILCORE_ENDPOINTS.fare.path,
      query: {
        train_number: query.trainNumber,
        from: query.fromStationCode.toUpperCase(),
        to: query.toStationCode.toUpperCase(),
        ...(travelClass ? { class: travelClass } : {}),
        quota,
      },
    }, (outcome) => {
      const fare = normalizeRailCoreFare(outcome.body, {
        trainNumber: query.trainNumber,
        fromStationCode: query.fromStationCode!.toUpperCase(),
        toStationCode: query.toStationCode!.toUpperCase(),
        travelClass: travelClass as TravelClassCode | null,
        quota: quota as QuotaCode,
      });
      return fare === null ? this.unusable('fare', outcome.latencyMs) : this.valueResult('fare', fare, outcome);
    });
  }

  // ── plumbing ──

  private async call<T>(
    operation: RailwayCapability,
    plan: CallPlan,
    onFinish: (outcome: Extract<RailCoreCallOutcome, { kind: 'success' }>) => ProviderResult<T>,
  ): Promise<ProviderResult<T>> {
    if (!this.client) {
      const failure = providerFailure(
        'MISSING_CREDENTIALS',
        'RailCore is not configured: RAILCORE_API_KEY is missing on the server.',
        { source: 'RAILCORE' },
      );
      this.emit(operation, 'FAILURE', 0, failure.error);
      return failure;
    }

    const outcome = await this.client.get(operation, plan.path, plan.query);

    if (outcome.kind === 'failure') {
      this.emit(operation, 'FAILURE', outcome.latencyMs, outcome.failure.error);
      return outcome.failure;
    }
    if (outcome.kind === 'empty') {
      this.emit(operation, 'ZERO_RESULTS', outcome.latencyMs);
      return providerEmpty('RAILCORE', outcome.emptyReason, new Date().toISOString(), { latencyMs: outcome.latencyMs });
    }
    const result = onFinish(outcome);
    if (result.ok) {
      this.emit(operation, isZeroResult(result) ? 'ZERO_RESULTS' : 'SUCCESS', outcome.latencyMs);
    } else {
      this.emit(operation, 'FAILURE', outcome.latencyMs, result.error);
    }
    return result;
  }

  private listResult<T>(operation: RailwayCapability, values: T[], outcome: Extract<RailCoreCallOutcome, { kind: 'success' }>): ProviderResult<T[]> {
    if (values.length === 0) {
      return providerEmpty('RAILCORE', 'NO_RESULTS', new Date().toISOString(), { latencyMs: outcome.latencyMs });
    }
    return providerSuccess('RAILCORE', values, new Date().toISOString(), { latencyMs: outcome.latencyMs });
  }

  private valueResult<T>(operation: RailwayCapability, value: T, outcome: Extract<RailCoreCallOutcome, { kind: 'success' }>): ProviderResult<T> {
    return providerSuccess('RAILCORE', value, new Date().toISOString(), { latencyMs: outcome.latencyMs });
  }

  private unusable(operation: string, latencyMs: number): ProviderFailure {
    return providerFailure('INVALID_RESPONSE', `RailCore ${operation} returned an unusable payload.`, {
      source: 'RAILCORE',
      latencyMs,
    });
  }

  private invalid(operation: string, message: string): ProviderFailure {
    return providerFailure('INVALID_INPUT', message, { source: 'RAILCORE' });
  }

  private unsupported(operation: string): ProviderFailure {
    return providerFailure('UNSUPPORTED_CAPABILITY', `RailCore does not support "${operation}" — use RailKit.`, {
      source: 'RAILCORE',
    });
  }

  private emit(operation: string, outcome: RailwayDiagEvent['outcome'], latencyMs: number, error?: { kind: string; httpStatus: number | null }): void {
    if (!this.onDiagnostic) return;
    const event: RailwayDiagEvent = {
      operation,
      provider: 'RAILCORE',
      outcome,
      latencyMs,
      ...(error
        ? { category: categorizeFailure({ kind: error.kind as never, message: '', httpStatus: error.httpStatus, fallbackEligible: false }) }
        : {}),
    };
    this.onDiagnostic(event);
  }
}
