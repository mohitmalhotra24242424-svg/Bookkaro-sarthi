/**
 * DETERMINISTIC RAILWAY TOOL EXECUTORS — the only bridge between the Tool
 * Registry and the RailwayProviderRouter (Step 2). All execution is
 * server-side; the AI layer can request these tools but never execute them.
 * ProviderResult → normalized ToolResult mapping happens here.
 */

import type {
  AvailabilityQuery,
  CancelledTrainsQuery,
  FareQuery,
  LiveStatusQuery,
  PNRQuery,
  ProviderResult,
  QuotaCode,
  StationLookupQuery,
  Timetable,
  Train,
  TrainRefQuery,
  TrainSearchQuery,
  TrainSearchResult,
  TravelClassCode,
} from '../../shared/index.js';
import { isZeroResult } from '../../shared/index.js';
import type { Station } from '../../shared/index.js';
import type { ToolCall, ToolResult } from '../../shared/index.js';
import type { RailwayProviderRouter } from '../../railway/index.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolSuccess } from '../results.js';

function callOf(context: ToolExecutionContext, tool: ToolCall['tool']): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool };
}

function mapProviderFailure(call: { id: string | null; tool: string }, result: ProviderResult<never>): ToolResult<never> {
  if (!result.ok) {
    if (result.error.kind === 'INVALID_INPUT') {
      return toolFailure(call, 'INVALID_RAILWAY_QUERY', result.error.message);
    }
    if (result.error.kind === 'UNSUPPORTED_CAPABILITY' || result.error.kind === 'NOT_IMPLEMENTED') {
      return toolFailure(call, 'RAILWAY_CAPABILITY_UNSUPPORTED', result.error.message);
    }
    // Honest, user-safe failure — no internal details, no fabricated data.
    return toolFailure(
      call,
      'RAILWAY_DATA_UNAVAILABLE',
      'Railway data is currently unavailable (provider failure or missing credentials).',
    );
  }
  return toolFailure(call, 'RAILWAY_DATA_UNAVAILABLE', 'Railway data is currently unavailable.');
}

function mapResult<T>(call: { id: string | null; tool: string }, result: ProviderResult<T>): ToolResult<T | null> {
  if (result.ok) {
    const provider = result.source ? result.source.toLowerCase() : null;
    if (isZeroResult(result)) {
      return {
        callId: call.id,
        tool: call.tool,
        ok: true,
        data: null,
        unavailableReason: result.emptyReason === 'NOT_FOUND' ? 'NOT_FOUND' : 'NO_RESULTS',
        error: null,
        executedBy: 'SERVER',
        provider,
      };
    }
    return { ...toolSuccess(call, result.data), provider };
  }
  return mapProviderFailure(call, result as ProviderResult<never>);
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberInput(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * STATION LOOKUP CACHE (Step 9+): station codes/names are static railway data,
 * and station lookup is served by RailCore ONLY (RailKit has no such capability).
 * Successful RailCore responses are cached server-side with a TTL so repeated
 * lookups ("Amritsar", "Ludhiana"…) do not burn the provider's daily quota.
 * Cache stores ONLY real provider responses — nothing is pre-seeded/hardcoded.
 */
const STATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // stations don't change daily
const STATION_CACHE_MAX = 300;

interface StationCacheEntry {
  stations: Station[];
  source: string;
  retrievedAt: number;
  expiresAt: number;
}

const stationCache = new Map<string, StationCacheEntry>();

function stationCacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function readStationCache(key: string, now: number): StationCacheEntry | null {
  const entry = stationCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < now) {
    stationCache.delete(key);
    return null;
  }
  return entry;
}

function writeStationCache(key: string, stations: Station[], source: string, now: number): void {
  if (stationCache.size >= STATION_CACHE_MAX) {
    const oldest = stationCache.keys().next().value;
    if (oldest !== undefined) stationCache.delete(oldest);
  }
  stationCache.set(key, { stations, source, retrievedAt: now, expiresAt: now + STATION_CACHE_TTL_MS });
}

/** Test hook: clears the station cache. */
export function clearStationCacheForTests(): void {
  stationCache.clear();
}

export function createRailwayToolExecutors(router: RailwayProviderRouter): Record<string, ToolExecutor> {
  return {
    lookupStation: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'lookupStation');
      const query: StationLookupQuery = { query: stringInput(input, 'query') ?? '' };
      const now = Date.now();
      const cacheKey = stationCacheKey(query.query);

      // Cache hit → serve the previously VERIFIED RailCore result (no provider call).
      const cached = readStationCache(cacheKey, now);
      if (cached) {
        return {
          callId: call.id,
          tool: call.tool,
          ok: true,
          data: cached.stations,
          unavailableReason: null,
          error: null,
          executedBy: 'SERVER',
          provider: cached.source,
        };
      }

      const result = await router.stationLookup(query); // RailCore primary (only capability holder)
      if (result.ok && !isZeroResult(result) && result.data !== null && result.data.length > 0) {
        writeStationCache(cacheKey, result.data, result.source.toLowerCase(), now);
        return mapResult(call, result);
      }
      return mapResult(call, result); // honest failure/empty — never cached, never fabricated
    },

    searchTrains: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'searchTrains');
      const query: TrainSearchQuery = {
        originCode: (stringInput(input, 'originCode') ?? '').toUpperCase(),
        destinationCode: (stringInput(input, 'destinationCode') ?? '').toUpperCase(),
        journeyDate: stringInput(input, 'journeyDate'),
      };
      void numberInput(input, 'passengerCount');
      return mapResult<TrainSearchResult[]>(call, await router.trainSearch(query));
    },

    getTrainInfo: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getTrainInfo');
      const query: TrainRefQuery = { trainNumber: stringInput(input, 'trainNumber') ?? '' };
      return mapResult<Train>(call, await router.trainInfo(query));
    },

    getTimetable: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getTimetable');
      const query: TrainRefQuery = { trainNumber: stringInput(input, 'trainNumber') ?? '' };
      return mapResult<Timetable>(call, await router.timetable(query));
    },

    getLiveStatus: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getLiveStatus');
      const query: LiveStatusQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        journeyDate: stringInput(input, 'journeyDate'),
      };
      return mapResult(call, await router.liveStatus(query));
    },

    getAvailability: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getAvailability');
      const travelClass = stringInput(input, 'travelClass')?.toUpperCase() as TravelClassCode | undefined;
      const query: AvailabilityQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        journeyDate: stringInput(input, 'journeyDate') ?? '',
        travelClass: travelClass ?? null,
        quota: (stringInput(input, 'quota')?.toUpperCase() as QuotaCode | undefined) ?? null,
        fromStationCode: stringInput(input, 'fromStationCode')?.toUpperCase() ?? null,
        toStationCode: stringInput(input, 'toStationCode')?.toUpperCase() ?? null,
      };
      return mapResult(call, await router.availability(query));
    },

    getFare: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getFare');
      const travelClass = stringInput(input, 'travelClass')?.toUpperCase() as TravelClassCode | undefined;
      const query: FareQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        fromStationCode: stringInput(input, 'fromStationCode')?.toUpperCase() ?? null,
        toStationCode: stringInput(input, 'toStationCode')?.toUpperCase() ?? null,
        journeyDate: stringInput(input, 'journeyDate'),
        travelClass: travelClass ?? null,
        quota: (stringInput(input, 'quota')?.toUpperCase() as QuotaCode | undefined) ?? null,
      };
      return mapResult(call, await router.fare(query));
    },

    checkPNR: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'checkPNR');
      const query: PNRQuery = { pnr: stringInput(input, 'pnr') ?? '' };
      return mapResult(call, await router.pnr(query));
    },

    getCancelledTrains: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getCancelledTrains');
      const query: CancelledTrainsQuery = { journeyDate: stringInput(input, 'journeyDate') ?? '' };
      return mapResult(call, await router.cancelledTrains(query));
    },
  };
}
