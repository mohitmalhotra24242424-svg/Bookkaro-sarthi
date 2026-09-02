/**
 * RAILWAY PROVIDER ROUTER — the single gateway every railway query passes
 * through.
 *
 * Routing policy (production design, exercised in tests with fakes):
 *   Providers are tried in priority order (RailCore primary, RailKit fallback)
 *   filtered by capability. A provider error triggers fallback ONLY for
 *   HTTP errors, timeouts, rate limits, network errors or unusable
 *   (success:false / malformed / thrown) responses.
 *
 *   NO fallback when:
 *   - the query itself is invalid (INVALID_INPUT) — a real answer, fixed at
 *     the validation boundary, not by retrying another provider;
 *   - the search legitimately returned ZERO results (ProviderEmpty) — that is
 *     a successful answer ("no trains found"), not a failure;
 *   - no configured provider supports the capability.
 */

import { ValidationError, providerFailure } from '../shared/index.js';
import type {
  Availability,
  AvailabilityQuery,
  CancelledTrain,
  CancelledTrainsQuery,
  Fare,
  FareQuery,
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
} from '../shared/index.js';
import type { RailwayProvider } from './RailwayProvider.js';
import { validateRailwayQuery } from './inputs.js';
import { RailCoreProvider } from './RailCoreProvider.js';
import { RailKitProvider } from './RailKitProvider.js';

export interface RailwayProviderRouterOptions {
  /** Priority order: [primary, ...fallbacks]. */
  providers: readonly RailwayProvider[];
  /** Injectable clock for date validation (tests use a fixed date; production uses real time). */
  now?: () => Date;
}

export class RailwayProviderRouter {
  readonly providers: readonly RailwayProvider[];
  private readonly now: () => Date;

  constructor(options: RailwayProviderRouterOptions) {
    this.now = options.now ?? (() => new Date());
    if (!options.providers || options.providers.length === 0) {
      throw new ValidationError('RailwayProviderRouter needs at least one provider.');
    }
    const ids = options.providers.map((provider) => provider.providerId);
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError('Duplicate provider ids in router stack.');
    }
    this.providers = [...options.providers];
  }

  describeRouting(): { primary: ProviderId; fallbackOrder: ProviderId[]; capabilities: RailwayCapability[] } {
    const first = this.providers[0];
    if (!first) throw new ValidationError('Router has no providers.');
    const capabilities = new Set<RailwayCapability>();
    for (const provider of this.providers) {
      for (const capability of provider.capabilities) capabilities.add(capability);
    }
    return {
      primary: first.providerId,
      fallbackOrder: this.providers.slice(1).map((provider) => provider.providerId),
      capabilities: [...capabilities],
    };
  }

  private async route<T>(
    capability: RailwayCapability,
    query: unknown,
    operation: (provider: RailwayProvider) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    // 1. Deterministic server-side validation BEFORE any provider call.
    const validation = validateRailwayQuery(capability, query, this.now);
    if (!validation.ok) {
      return providerFailure('INVALID_INPUT', `Invalid ${capability} query: ${validation.errors.join('; ')}`);
    }

    // 2. Capability-aware provider selection.
    const candidates = this.providers.filter((provider) => provider.supports(capability));
    if (candidates.length === 0) {
      return providerFailure(
        'UNSUPPORTED_CAPABILITY',
        `No configured railway provider supports "${capability}".`,
      );
    }

    // 3. Primary → fallback only when the failure is fallback-eligible.
    let lastFailure: ProviderResult<T> | null = null;
    let attemptIndex = 0;
    for (const provider of candidates) {
      const viaFallback = attemptIndex > 0;
      let result: ProviderResult<T>;
      try {
        result = await operation(provider);
      } catch (error) {
        result = providerFailure('PROVIDER_FAILURE', `${provider.providerId} threw: ${String(error)}`, {
          source: provider.providerId,
        });
      }
      if (result.ok) {
        return viaFallback ? { ...result, viaFallback: true } : result; // success OR legitimate zero-result
      }
      lastFailure = result;
      if (!result.error.fallbackEligible) return result;
      attemptIndex += 1;
    }
    return (
      lastFailure ?? providerFailure('PROVIDER_FAILURE', 'No provider produced a result.')
    );
  }

  stationLookup(query: StationLookupQuery): Promise<ProviderResult<Station[]>> {
    return this.route('stationLookup', query, (provider) => provider.stationLookup(query));
  }

  trainSearch(query: TrainSearchQuery): Promise<ProviderResult<TrainSearchResult[]>> {
    return this.route('trainSearch', query, (provider) => provider.trainSearch(query));
  }

  trainInfo(query: TrainRefQuery): Promise<ProviderResult<Train>> {
    return this.route('trainInfo', query, (provider) => provider.trainInfo(query));
  }

  timetable(query: TrainRefQuery): Promise<ProviderResult<Timetable>> {
    return this.route('timetable', query, (provider) => provider.timetable(query));
  }

  liveStatus(query: LiveStatusQuery): Promise<ProviderResult<LiveStatus>> {
    return this.route('liveStatus', query, (provider) => provider.liveStatus(query));
  }

  availability(query: AvailabilityQuery): Promise<ProviderResult<Availability>> {
    return this.route('availability', query, (provider) => provider.availability(query));
  }

  fare(query: FareQuery): Promise<ProviderResult<Fare>> {
    return this.route('fare', query, (provider) => provider.fare(query));
  }

  pnr(query: PNRQuery): Promise<ProviderResult<PNRStatus>> {
    return this.route('pnr', query, (provider) => provider.pnr(query));
  }

  cancelledTrains(query: CancelledTrainsQuery): Promise<ProviderResult<CancelledTrain[]>> {
    return this.route('cancelledTrains', query, (provider) => provider.cancelledTrains(query));
  }
}

export interface RailwayRouterFactoryOptions {
  /** RAILCORE_API_KEY — injected server-side only (api/config.ts). null/undefined → honest MISSING_CREDENTIALS. */
  railCore?: { apiKey?: string | null; baseUrl?: string; timeoutMs?: number; fetchImpl?: never };
  /** RAILKIT_API_KEY — injected server-side only. null/undefined → honest MISSING_CREDENTIALS. */
  railKit?: { apiKey?: string | null };
  onDiagnostic?: (event: import('./diagnostics.js').RailwayDiagEvent) => void;
}

/**
 * Default production-shaped stack: RailCore (primary, verified REST) →
 * RailKit (fallback, official SDK). Works with zero credentials — providers
 * then report clean configuration errors and the app still builds and runs.
 */
export function createDefaultRailwayRouter(options: RailwayRouterFactoryOptions = {}): RailwayProviderRouter {
  return new RailwayProviderRouter({
    providers: [
      new RailCoreProvider({
        apiKey: options.railCore?.apiKey ?? null,
        baseUrl: options.railCore?.baseUrl,
        timeoutMs: options.railCore?.timeoutMs,
        onDiagnostic: options.onDiagnostic,
      }),
      new RailKitProvider({
        apiKey: options.railKit?.apiKey ?? null,
        onDiagnostic: options.onDiagnostic,
      }),
    ],
  });
}
