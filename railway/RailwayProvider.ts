/**
 * RAILWAY PROVIDER ABSTRACTION.
 *
 * Production plan: RailCore = PRIMARY, RailKit = FALLBACK (via
 * RailwayProviderRouter). Providers advertise DIFFERENT capability sets —
 * unsupported capabilities are never called with invented endpoints.
 *
 * Step 1 ships contract + stubs only: no HTTP, no credentials, no data.
 * Every stub method returns an honest NOT_IMPLEMENTED ProviderFailure.
 */

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

export interface RailwayProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly capabilities: readonly RailwayCapability[];
  supports(capability: RailwayCapability): boolean;
  /** true when the provider's credential is configured server-side (diagnostics only — never the value). */
  readonly credentialConfigured?: boolean;
  /** Honest verification status of the provider's endpoint contract (shown in provider-config). */
  readonly endpointStatus?: string;

  stationLookup(query: StationLookupQuery): Promise<ProviderResult<Station[]>>;
  trainSearch(query: TrainSearchQuery): Promise<ProviderResult<TrainSearchResult[]>>;
  trainInfo(query: TrainRefQuery): Promise<ProviderResult<Train>>;
  timetable(query: TrainRefQuery): Promise<ProviderResult<Timetable>>;
  liveStatus(query: LiveStatusQuery): Promise<ProviderResult<LiveStatus>>;
  availability(query: AvailabilityQuery): Promise<ProviderResult<Availability>>;
  fare(query: FareQuery): Promise<ProviderResult<Fare>>;
  pnr(query: PNRQuery): Promise<ProviderResult<PNRStatus>>;
  cancelledTrains(query: CancelledTrainsQuery): Promise<ProviderResult<CancelledTrain[]>>;
}
