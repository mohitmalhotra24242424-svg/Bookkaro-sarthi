/**
 * Orchestration test harness — MOCK router + production tool registry +
 * deterministic orchestrator deps. No network, no real credentials.
 */

import { RailwayProviderRouter } from '../../railway/index.js';
import type { RailwayProvider } from '../../railway/index.js';
import { providerEmpty, providerFailure, providerSuccess } from '../../shared/index.js';
import type { RailwayCapability } from '../../shared/index.js';
import type {
  Availability,
  CancelledTrain,
  ConversationContext,
  Fare,
  LiveStatus,
  PNRStatus,
  ProviderId,
  ProviderResult,
  Station,
  Timetable,
  Train,
  TrainSearchResult,
} from '../../shared/index.js';
import { createConversationContext } from '../../shared/index.js';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import type { OrchestratorDependencies, OrchestratorTurn } from '../../ai/orchestrator.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import type { AIProvider } from '../../ai/index.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { clearStationCacheForTests } from '../../tools/executors/index.js';

export const ASR: Station = { code: 'ASR', name: 'Amritsar Jn', zone: null, state: 'Punjab', latitude: null, longitude: null };
export const LDH: Station = { code: 'LDH', name: 'Ludhiana Jn', zone: null, state: 'Punjab', latitude: null, longitude: null };
export const JAT: Station = { code: 'JAT', name: 'Jammu Tawi', zone: null, state: 'J&K', latitude: null, longitude: null };
export const BEAS: Station = { code: 'BEAS', name: 'Beas', zone: null, state: 'Punjab', latitude: null, longitude: null };
export const NDLS: Station = { code: 'NDLS', name: 'New Delhi', zone: null, state: 'Delhi', latitude: null, longitude: null };
export const DLI: Station = { code: 'DLI', name: 'Delhi Jn', zone: null, state: 'Delhi', latitude: null, longitude: null };
export const NZM: Station = { code: 'NZM', name: 'Delhi Hazrat Nizamuddin', zone: null, state: 'Delhi', latitude: null, longitude: null };
export const JRC: Station = { code: 'JRC', name: 'Jalandhar City', zone: null, state: 'Punjab', latitude: null, longitude: null };
export const CHD: Station = { code: 'CHD', name: 'Chandigarh', zone: null, state: 'Chandigarh', latitude: null, longitude: null };

export const HW: Station = { code: 'HW', name: 'Haridwar Jn', zone: null, state: 'Uttarakhand', latitude: null, longitude: null };
export const STATION_INDEX: Station[] = [ASR, LDH, JAT, BEAS, NDLS, DLI, NZM, JRC, CHD, HW];

const SHATABDI: Train = {
  number: '12014',
  name: 'Amritsar Shatabdi',
  originStation: ASR,
  destinationStation: NDLS,
  departureTime: '05:00',
  arrivalTime: '06:55',
  runsOn: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
  travelClasses: ['CC', 'EC'],
  pantryCar: true,
};

const EXPRESS: Train = {
  number: '14542',
  name: 'ASR NDLS Express',
  originStation: ASR,
  destinationStation: NDLS,
  departureTime: '08:10',
  arrivalTime: '10:20',
  runsOn: ['MON', 'WED', 'FRI'],
  travelClasses: ['SL', '3A'],
  pantryCar: null,
};

export function makeSearchResults(): TrainSearchResult[] {
  return [
    { train: SHATABDI, fromStation: ASR, toStation: LDH, departureTime: '05:00', arrivalTime: '06:55', durationMinutes: 115 },
    { train: EXPRESS, fromStation: ASR, toStation: LDH, departureTime: '08:10', arrivalTime: '10:20', durationMinutes: 130 },
  ];
}

const LIVE_STATUS: LiveStatus = {
  trainNumber: '12014',
  journeyDate: '2026-08-27',
  status: 'RUNNING',
  delayMinutes: 6,
  nextStationCode: 'JL',
  currentStation: NDLS,
  lastUpdatedAt: '2026-08-27T08:41:00Z',
  upcomingStops: null,
};

const AVAILABILITY: Availability = {
  trainNumber: '12014',
  journeyDate: '2026-08-27',
  travelClass: 'CC',
  quota: 'GN',
  status: 'AVAILABLE',
  availableCount: 32,
  racCount: null,
  waitlistNumber: null,
  asOf: null,
};

const FARE: Fare = {
  trainNumber: '12014',
  fromStationCode: 'ASR',
  toStationCode: 'LDH',
  journeyDate: '2026-08-27',
  travelClass: 'CC',
  quota: 'GN',
  currency: 'INR',
  breakdown: { baseFareMinor: null, reservationChargeMinor: null, superfastChargeMinor: null, dynamicFareMinor: null, cateringChargeMinor: null, gstMinor: null, totalMinor: 40500 },
  source: 'RAILCORE',
  retrievedAt: '2026-08-26T00:00:00Z',
};

function ttStop(stationCode: string, stationName: string, departureTime: string | null, arrivalTime: string | null, distanceKm: number | null): Timetable['stops'][number] {
  return { stationCode, stationName, arrivalTime, departureTime, dayCount: 1, distanceKm, haltMinutes: arrivalTime && departureTime ? 2 : null };
}

/** All harness stations, plus a closing ASR so reverse pairs (NDLS→ASR) still halt-check in mocks. */
const TIMETABLE: Timetable = {
  trainNumber: '12014',
  trainName: 'Amritsar Shatabdi',
  stops: [
    ttStop('ASR', 'Amritsar Jn', '05:00', null, 0),
    ttStop('BEAS', 'Beas', '05:40', '05:38', 43),
    ttStop('LDH', 'Ludhiana Jn', '06:51', '06:49', 135),
    ttStop('JRC', 'Jalandhar City', '07:20', '07:18', 180),
    ttStop('CHD', 'Chandigarh', '08:10', '08:05', 250),
    ttStop('NDLS', 'New Delhi', '11:15', '11:10', 447),
    ttStop('DLI', 'Delhi Jn', '11:40', '11:35', 452),
    ttStop('NZM', 'Hazrat Nizamuddin', '12:00', '11:55', 458),
    ttStop('JAT', 'Jammu Tawi', '20:00', '19:50', 900),
    ttStop('HW', 'Haridwar Jn', '22:00', '21:50', 1100),
    ttStop('ASR', 'Amritsar Jn', null, '23:50', 1500),
  ],
};

const PNR: PNRStatus = {
  pnr: '4123456789',
  trainNumber: '12014',
  journeyDate: '2026-08-27',
  fromStationCode: 'ASR',
  toStationCode: 'LDH',
  chartPrepared: true,
  overallStatus: 'CONFIRMED',
  passengers: [{ passengerNumber: 1, bookingStatus: 'CNF', currentStatus: 'CNF B2-34', coach: 'B2', seat: '34' }],
};

const CANCELLED: CancelledTrain[] = [
  { trainNumber: '15098', trainName: 'Amritsar LTT Express', journeyDate: null, reason: 'FULLY_CANCELLED' },
];

export type RouterScript = Partial<Record<RailwayCapability, ProviderResult<unknown> | 'EMPTY'>>;
export type HarnessRouterScript = RouterScript;

/** Optional per-test station index (mimics the dynamic, all-India RailCore lookup). */
export interface HarnessOptions {
  stations?: readonly Station[];
  /**
   * Override the trainSearch provider result. Lets tests inject arbitrary
   * verified lists (varied departure/arrival times, missing durations, etc.)
   * to exercise the deterministic query-intelligence engine. Additive only —
   * existing tests keep the default makeSearchResults().
   */
  searchResults?: readonly TrainSearchResult[];
  /** Override official-web fetch (default: blocked so unit tests never hit the network). */
  knowledgeFetch?: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => Promise<{
    ok: boolean; status: number; url?: string; text(): Promise<string>;
  }>;
}

/** Fake provider pair with a realistic station-lookup that filters by query. */
export function createHarness(script: RouterScript = {}, options: HarnessOptions = {}) {
  clearStationCacheForTests(); // fresh provider-call counts per test (station cache is global)
  const calls: Array<{ provider: ProviderId; capability: RailwayCapability }> = [];
  const stationIndex = options.stations && options.stations.length ? options.stations : STATION_INDEX;
  const searchResults = options.searchResults ?? makeSearchResults();

  const resolve = (capability: RailwayCapability, input: Record<string, unknown>): ProviderResult<unknown> => {
    const scripted = script[capability];
    if (scripted && scripted !== 'EMPTY') return scripted;
    if (scripted === 'EMPTY') return providerEmpty('RAILCORE', 'NO_RESULTS');
    // default behaviours
    if (capability === 'stationLookup') {
      const query = String(input.query ?? '').toLowerCase();
      if (query.trim().length < 2) return providerEmpty('RAILCORE', 'NO_RESULTS');
      const matches = stationIndex.filter(
        (station) => station.name?.toLowerCase().includes(query) || station.code.toLowerCase() === query,
      );
      return matches.length > 0 ? providerSuccess('RAILCORE', matches) : providerEmpty('RAILCORE', 'NO_RESULTS');
    }
    if (capability === 'trainSearch') return providerSuccess('RAILCORE', [...searchResults]);
    if (capability === 'liveStatus') return providerSuccess('RAILCORE', LIVE_STATUS);
    if (capability === 'availability') return providerSuccess('RAILCORE', AVAILABILITY);
    if (capability === 'fare') return providerSuccess('RAILCORE', FARE);
    if (capability === 'timetable') return providerSuccess('RAILCORE', TIMETABLE);
    if (capability === 'trainInfo') return providerSuccess('RAILCORE', SHATABDI);
    if (capability === 'pnr') return providerSuccess('RAILKIT', PNR);
    if (capability === 'cancelledTrains') return providerSuccess('RAILKIT', CANCELLED);
    return providerFailure('UNSUPPORTED_CAPABILITY', `no default for ${capability}`);
  };

  const makeProvider = (id: ProviderId, caps: RailwayCapability[]): RailwayProvider =>
    ({
      providerId: id,
      displayName: `${id}-fake`,
      capabilities: caps,
      supports: (c: RailwayCapability) => caps.includes(c),
      stationLookup: (q: unknown) => { calls.push({ provider: id, capability: 'stationLookup' }); return Promise.resolve(resolve('stationLookup', q as never)); },
      trainSearch: (q: unknown) => { calls.push({ provider: id, capability: 'trainSearch' }); return Promise.resolve(resolve('trainSearch', q as never)); },
      trainInfo: (q: unknown) => { calls.push({ provider: id, capability: 'trainInfo' }); return Promise.resolve(resolve('trainInfo', q as never)); },
      timetable: (q: unknown) => { calls.push({ provider: id, capability: 'timetable' }); return Promise.resolve(resolve('timetable', q as never)); },
      liveStatus: (q: unknown) => { calls.push({ provider: id, capability: 'liveStatus' }); return Promise.resolve(resolve('liveStatus', q as never)); },
      availability: (q: unknown) => { calls.push({ provider: id, capability: 'availability' }); return Promise.resolve(resolve('availability', q as never)); },
      fare: (q: unknown) => { calls.push({ provider: id, capability: 'fare' }); return Promise.resolve(resolve('fare', q as never)); },
      pnr: (q: unknown) => { calls.push({ provider: id, capability: 'pnr' }); return Promise.resolve(resolve('pnr', q as never)); },
      cancelledTrains: (q: unknown) => { calls.push({ provider: id, capability: 'cancelledTrains' }); return Promise.resolve(resolve('cancelledTrains', q as never)); },
    }) as unknown as RailwayProvider;

  const router = new RailwayProviderRouter({
    providers: [
      makeProvider('RAILCORE', ['stationLookup', 'trainSearch', 'trainInfo', 'timetable', 'liveStatus', 'availability', 'fare']),
      makeProvider('RAILKIT', ['trainSearch', 'trainInfo', 'timetable', 'liveStatus', 'availability', 'fare', 'pnr', 'cancelledTrains']),
    ],
    now: () => new Date('2026-08-26T10:00:00.000Z'), // fixed test clock — dates are validated against THIS
  });

  const blockedWeb = async () => {
    throw new Error('harness-blocks-web');
  };
  const toolRegistry = createProductionToolRegistry({
    router,
    knowledgeFetch: options.knowledgeFetch ?? (blockedWeb as never),
  });
  const deps: OrchestratorDependencies = {
    ai: new DeterministicNLUProvider(),
    fallbackNlu: new DeterministicNLUProvider(),
    toolRegistry,
    now: () => new Date('2026-08-26T10:00:00.000Z'), // deterministic "today" = 2026-08-26
  };

  return {
    deps,
    toolRegistry,
    routerCalls: calls,
    countCapability: (capability: RailwayCapability) => calls.filter((call) => call.capability === capability).length,
  };
}

export function freshContext(userId = 'user-1'): ConversationContext {
  return createConversationContext({ userId, now: '2026-08-26T10:00:00.000Z' });
}

export async function run(
  harness: ReturnType<typeof createHarness>,
  context: ConversationContext,
  message: string,
  overrides: { ai?: AIProvider; aiTimeoutMs?: number } = {},
): Promise<OrchestratorTurn> {
  const deps: OrchestratorDependencies = { ...harness.deps, ...overrides };
  return orchestrateTurn(deps, context, message);
}

export const NOW = new Date('2026-08-26T10:00:00.000Z');

export function isoPlusDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
