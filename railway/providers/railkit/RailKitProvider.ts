/**
 * RailKit — FALLBACK railway provider, implemented with the OFFICIAL RailKit
 * SDK (npm `railkit`). PNR, cancelled-trains and the rest of the RailKit
 * capabilities run through the SDK; the SDK owns transport + signing.
 *
 * Auth: RAILKIT_API_KEY injected server-side via configure() — never logged,
 * never exposed to the frontend. Without a key, every operation returns an
 * honest MISSING_CREDENTIALS failure and performs ZERO network calls.
 *
 * Capability decisions (documented):
 *  - trainSearch, trainInfo, timetable (from getTrainInfo route), liveStatus
 *    (trackTrain), availability, fare, pnr, cancelledTrains: SUPPORTED.
 *  - stationLookup: NOT SUPPORTED — RailKit has no station-name search
 *    endpoint (liveAtStation is a departures board, not name resolution).
 *    We do not invent one.
 */

import { isZeroResult, providerEmpty, providerFailure, providerSuccess } from '../../../shared/index.js';
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
  RailwayCapability,
  Station,
  StationLookupQuery,
  Timetable,
  Train,
  TrainRefQuery,
  TrainSearchQuery,
  TrainSearchResult,
} from '../../../shared/index.js';
import type { RailwayProvider } from '../../RailwayProvider.js';
import type { RailwayDiagEvent } from '../../diagnostics.js';
import { categorizeFailure } from '../../diagnostics.js';
import { createOfficialRailKitSdkLoader, isoToDdMmYyyy } from './sdk.js';
import type { RailKitSdkLike, RailKitSdkLoader } from './sdk.js';
import {
  interpretSdkResult,
  normalizeRailKitAvailability,
  normalizeRailKitCancelled,
  normalizeRailKitFare,
  normalizeRailKitLiveStatus,
  normalizeRailKitPnr,
  normalizeRailKitTimetable,
  normalizeRailKitTrainInfo,
  normalizeRailKitTrainSearch,
} from './normalize.js';

export const RAILKIT_CAPABILITIES: readonly RailwayCapability[] = [
  'trainSearch',
  'trainInfo',
  'timetable',
  'liveStatus',
  'availability',
  'fare',
  'pnr',
  'cancelledTrains',
];

export const RAILKIT_ENDPOINT_STATUS =
  'VERIFIED — official railkit npm SDK v4.1.0 (transport owned by the SDK; docs: railkit.rajivdubey.dev)';

export interface RailKitProviderOptions {
  /** RAILKIT_API_KEY from the server environment. null → honest MISSING_CREDENTIALS. */
  apiKey?: string | null;
  /** Test seam: inject a fake SDK — no network, no real key. */
  sdk?: RailKitSdkLike | null;
  /** Advanced seam: custom loader (defaults to the official SDK loader). */
  sdkLoader?: RailKitSdkLoader | null;
  onDiagnostic?: (event: RailwayDiagEvent) => void;
}

export class RailKitProvider implements RailwayProvider {
  readonly providerId: ProviderId = 'RAILKIT';
  readonly displayName = 'RailKit (official SDK)';
  readonly capabilities: readonly RailwayCapability[] = RAILKIT_CAPABILITIES;
  readonly credentialConfigured: boolean;
  readonly endpointStatus = RAILKIT_ENDPOINT_STATUS;

  private readonly sdk: RailKitSdkLike | null;
  private readonly sdkLoader: RailKitSdkLoader | null;
  private loaderPromise: Promise<RailKitSdkLike> | null = null;
  private readonly onDiagnostic?: (event: RailwayDiagEvent) => void;

  constructor(options: RailKitProviderOptions = {}) {
    const apiKey = options.apiKey && options.apiKey.trim().length > 0 ? options.apiKey.trim() : null;
    this.sdk = options.sdk ?? null;
    this.sdkLoader = options.sdkLoader ?? (apiKey && !options.sdk ? createOfficialRailKitSdkLoader(apiKey) : null);
    this.credentialConfigured = this.sdk !== null || this.sdkLoader !== null;
    this.onDiagnostic = options.onDiagnostic;
  }

  supports(capability: RailwayCapability): boolean {
    return this.capabilities.includes(capability);
  }

  // ── unsupported capability: honest refusal ──

  stationLookup(_query: StationLookupQuery): Promise<ProviderResult<Station[]>> {
    return Promise.resolve(this.unsupported('stationLookup'));
  }

  // ── supported capabilities ──

  trainSearch(query: TrainSearchQuery): Promise<ProviderResult<TrainSearchResult[]>> {
    return this.run('trainSearch', async (sdk) => {
      const date = query.journeyDate ? isoToDdMmYyyy(query.journeyDate) ?? undefined : undefined;
      const result = await sdk.searchTrainBetweenStations(query.originCode.toUpperCase(), query.destinationCode.toUpperCase(), date);
      return this.toListResult('trainSearch', normalizeRailKitTrainSearch(result), result);
    });
  }

  trainInfo(query: TrainRefQuery): Promise<ProviderResult<Train>> {
    return this.run('trainInfo', async (sdk) => {
      const result = await sdk.getTrainInfo(query.trainNumber);
      const train = normalizeRailKitTrainInfo(result);
      return train === null ? this.unusable('trainInfo') : providerSuccess('RAILKIT', train, undefined, { latencyMs: 0 });
    });
  }

  timetable(query: TrainRefQuery): Promise<ProviderResult<Timetable>> {
    return this.run('timetable', async (sdk) => {
      const result = await sdk.getTrainInfo(query.trainNumber); // official route data (documented)
      const timetable = normalizeRailKitTimetable(result, query.trainNumber);
      return timetable === null ? this.unusable('timetable') : providerSuccess('RAILKIT', timetable, undefined, { latencyMs: 0 });
    });
  }

  liveStatus(query: LiveStatusQuery): Promise<ProviderResult<LiveStatus>> {
    return this.run('liveStatus', async (sdk) => {
      const date = query.journeyDate ? isoToDdMmYyyy(query.journeyDate) ?? undefined : undefined;
      const result = await sdk.trackTrain(query.trainNumber, date);
      const status = normalizeRailKitLiveStatus(result, query.trainNumber);
      return status === null ? this.unusable('liveStatus') : providerSuccess('RAILKIT', status, undefined, { latencyMs: 0 });
    });
  }

  availability(query: AvailabilityQuery): Promise<ProviderResult<Availability>> {
    return this.run('availability', async (sdk) => {
      if (!query.fromStationCode || !query.toStationCode || !query.travelClass) {
        return this.invalid('availability', 'RailKit availability requires train, from, to, date and class.');
      }
      const date = isoToDdMmYyyy(query.journeyDate);
      if (!date) return this.invalid('availability', 'RailKit availability requires a valid journey date.');
      const quota = (query.quota ?? 'GN').toUpperCase(); // IRCTC default quota
      const result = await sdk.getAvailability(
        query.trainNumber,
        query.fromStationCode.toUpperCase(),
        query.toStationCode.toUpperCase(),
        date,
        query.travelClass.toUpperCase(),
        quota,
      );
      const availability = normalizeRailKitAvailability(result, {
        trainNumber: query.trainNumber,
        journeyDate: query.journeyDate,
        travelClass: query.travelClass,
        quota,
      });
      return availability === null ? this.unusable('availability') : providerSuccess('RAILKIT', availability, undefined, { latencyMs: 0 });
    });
  }

  fare(query: FareQuery): Promise<ProviderResult<Fare>> {
    return this.run('fare', async (sdk) => {
      if (!query.fromStationCode || !query.toStationCode) {
        return this.invalid('fare', 'RailKit fare lookup requires from and to stations.');
      }
      if (!query.journeyDate) {
        // Dynamic fares are date-dependent — defaulting the date would risk quoting
        // the wrong fare. RailCore (primary) serves date-independent estimates.
        return this.invalid('fare', 'RailKit fare lookup requires a journey date.');
      }
      const date = isoToDdMmYyyy(query.journeyDate);
      if (!date) return this.invalid('fare', 'RailKit fare lookup requires a valid journey date.');
      const quota = (query.quota ?? 'GN').toUpperCase();
      const travelClass = query.travelClass ? query.travelClass.toUpperCase() : '3A';
      const result = await sdk.fareLookup(
        query.trainNumber,
        query.fromStationCode.toUpperCase(),
        query.toStationCode.toUpperCase(),
        date,
        travelClass,
        quota,
      );
      const fare = normalizeRailKitFare(result, {
        trainNumber: query.trainNumber,
        fromStationCode: query.fromStationCode,
        toStationCode: query.toStationCode,
        travelClass: query.travelClass,
        quota,
        journeyDate: query.journeyDate,
      });
      return fare === null ? this.unusable('fare') : providerSuccess('RAILKIT', fare, undefined, { latencyMs: 0 });
    });
  }

  pnr(query: PNRQuery): Promise<ProviderResult<PNRStatus>> {
    return this.run('pnr', async (sdk) => {
      const result = await sdk.checkPNRStatus(query.pnr);
      const status = normalizeRailKitPnr(result);
      return status === null ? this.unusable('pnr') : providerSuccess('RAILKIT', status, undefined, { latencyMs: 0 });
    });
  }

  cancelledTrains(query: CancelledTrainsQuery): Promise<ProviderResult<CancelledTrain[]>> {
    return this.run('cancelledTrains', async (sdk) => {
      // Verified: the SDK's cancelList() takes no date parameter.
      void query.journeyDate;
      const result = await sdk.cancelList();
      return this.toListResult('cancelledTrains', normalizeRailKitCancelled(result), result);
    });
  }

  // ── plumbing ──

  private async run<T>(
    operation: RailwayCapability,
    operation_fn: (sdk: RailKitSdkLike) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const startedAt = Date.now();
    const sdk = await this.ensureSdk();
    if (!sdk) {
      const failure = providerFailure(
        'MISSING_CREDENTIALS',
        'RailKit is not configured: RAILKIT_API_KEY is missing on the server.',
        { source: 'RAILKIT' },
      );
      this.emit(operation, 'FAILURE', Date.now() - startedAt, failure.error);
      return failure;
    }

    let result: ProviderResult<T>;
    try {
      result = await operation_fn(sdk);
    } catch (error) {
      const failure = providerFailure('PROVIDER_FAILURE', `RailKit ${operation} threw: ${error instanceof Error ? error.name : 'UnknownError'}`, {
        source: 'RAILKIT',
      });
      this.emit(operation, 'FAILURE', Date.now() - startedAt, failure.error);
      return failure;
    }

    const latencyMs = Date.now() - startedAt;
    if (result.ok) {
      result = { ...result, latencyMs };
      this.emit(operation, isZeroResult(result) ? 'ZERO_RESULTS' : 'SUCCESS', latencyMs);
    } else {
      result = { ...result, latencyMs };
      this.emit(operation, 'FAILURE', latencyMs, result.error);
    }
    return result;
  }

  private async ensureSdk(): Promise<RailKitSdkLike | null> {
    if (this.sdk) return this.sdk;
    if (!this.sdkLoader) return null;
    this.loaderPromise ??= this.sdkLoader().catch((error: unknown) => {
      this.loaderPromise = null; // allow retry on the next call
      throw error;
    });
    try {
      return await this.loaderPromise;
    } catch {
      // SDK load failure → run() reports an honest provider failure (no fabricated data).
      return null;
    }
  }

  private toListResult<T>(operation: RailwayCapability, values: T[] | null, rawResult: unknown): ProviderResult<T[]> {
    if (values === null) {
      const envelope = interpretSdkResult(rawResult);
      if (envelope && !envelope.success) {
        return providerFailure('INVALID_RESPONSE', `RailKit ${operation} returned success:false${envelope.message ? `: ${envelope.message}` : '.'}`, {
          source: 'RAILKIT',
        });
      }
      return this.unusable(operation);
    }
    if (values.length === 0) return providerEmpty('RAILKIT', 'NO_RESULTS');
    return providerSuccess('RAILKIT', values);
  }

  private unusable(operation: string): ProviderFailure {
    return providerFailure('INVALID_RESPONSE', `RailKit ${operation} returned an unusable payload.`, { source: 'RAILKIT' });
  }

  private invalid(operation: string, message: string): ProviderFailure {
    return providerFailure('INVALID_INPUT', message, { source: 'RAILKIT' });
  }

  private unsupported(operation: string): ProviderFailure {
    return providerFailure('UNSUPPORTED_CAPABILITY', `RailKit does not support "${operation}"${operation === 'stationLookup' ? ' — no station-name search endpoint exists' : ''}.`, {
      source: 'RAILKIT',
    });
  }

  private emit(operation: string, outcome: RailwayDiagEvent['outcome'], latencyMs: number, error?: { kind: string; httpStatus: number | null }): void {
    if (!this.onDiagnostic) return;
    this.onDiagnostic({
      operation,
      provider: 'RAILKIT',
      outcome,
      latencyMs,
      ...(error
        ? { category: categorizeFailure({ kind: error.kind as never, message: '', httpStatus: error.httpStatus, fallbackEligible: false }) }
        : {}),
    });
  }
}
