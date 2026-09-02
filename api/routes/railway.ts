/**
 * SERVER-SIDE railway API routes (Step 2).
 *
 *   GET /api/railway/stations?q=
 *   GET /api/railway/trains?from=&to=&date=
 *   GET /api/railway/train-info?train=
 *   GET /api/railway/timetable?train=
 *   GET /api/railway/live-status?train=&date=
 *   GET /api/railway/availability?train=&from=&to=&date=&class=&quota=
 *   GET /api/railway/fare?train=&from=&to=&date=&class=&quota=
 *   GET /api/railway/pnr?pnr=
 *   GET /api/railway/cancelled?date=
 *   GET /api/railway/provider-config   (safe diagnostics — never keys)
 *
 * Every data route returns the normalized envelope:
 *   { success: true,  provider: 'railcore' | 'railkit_fallback', latencyMs, data }
 *   { success: true,  provider, latencyMs, data: null, empty: true, reason }
 *   { success: false, provider, error: 'RAILWAY_DATA_UNAVAILABLE' | ... }
 *
 * AI/orchestrator code will consume the same router through the tool layer —
 * these HTTP routes are for the developer diagnostics UI and direct testing.
 */

import type { ServerResponse } from 'node:http';
import { RAILWAY_CAPABILITIES, isZeroResult } from '../../shared/index.js';
import type {
  AvailabilityQuery,
  CancelledTrainsQuery,
  FareQuery,
  LiveStatusQuery,
  PNRQuery,
  ProviderFailure,
  ProviderResult,
  RailwayCapability,
  StationLookupQuery,
  TrainRefQuery,
  TrainSearchQuery,
  TravelClassCode,
} from '../../shared/index.js';
import type { RailwayProviderRouter } from '../../railway/index.js';
import { categorizeFailure } from '../../railway/index.js';

type QueryParams = URLSearchParams;

function send(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function param(params: QueryParams, ...names: string[]): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** "railcore" / "railkit_fallback" — provider metadata per the Step 2 spec. */
function providerLabel(result: ProviderResult<unknown>, primary: string | null): string | null {
  if (!result.source) return null;
  const source = result.source.toLowerCase();
  if (result.ok && result.viaFallback) return `${source}_fallback`;
  if (result.ok && primary && source !== primary.toLowerCase()) return `${source}_fallback`;
  return source;
}

function lastAttemptLabel(failure: ProviderFailure): string | null {
  return failure.source ? failure.source.toLowerCase() : null;
}

function emptyReasonToHttp(reason: 'NO_RESULTS' | 'NOT_FOUND'): 'NO_RESULTS' | 'NOT_FOUND' {
  return reason;
}

async function respondWithResult<T>(
  res: ServerResponse,
  result: ProviderResult<T>,
  primary: string | null,
  totalLatencyMs: number,
): Promise<void> {
  if (result.ok) {
    if (isZeroResult(result)) {
      send(res, 200, {
        success: true,
        provider: providerLabel(result, primary),
        latencyMs: totalLatencyMs,
        data: null,
        empty: true,
        reason: emptyReasonToHttp(result.emptyReason),
      });
      return;
    }
    send(res, 200, {
      success: true,
      provider: providerLabel(result, primary),
      latencyMs: totalLatencyMs,
      data: result.data,
    });
    return;
  }

  const error = result.error;
  if (error.kind === 'INVALID_INPUT') {
    send(res, 400, {
      success: false,
      provider: providerLabel(result, primary),
      error: 'INVALID_RAILWAY_QUERY',
      message: error.message, // our own validation text — safe, contains no secrets
      latencyMs: totalLatencyMs,
    });
    return;
  }
  if (error.kind === 'UNSUPPORTED_CAPABILITY' || error.kind === 'NOT_IMPLEMENTED') {
    send(res, 501, {
      success: false,
      provider: providerLabel(result, primary),
      error: 'RAILWAY_CAPABILITY_UNSUPPORTED',
      message: error.message,
      latencyMs: totalLatencyMs,
    });
    return;
  }

  // Both providers failed (or are unconfigured) → normalized honest failure.
  send(res, 503, {
    success: false,
    provider: lastAttemptLabel(result),
    error: 'RAILWAY_DATA_UNAVAILABLE',
    category: categorizeFailure(error),
    latencyMs: totalLatencyMs,
  });
}

export interface RailwayRouteContext {
  router: RailwayProviderRouter;
}

async function run<T>(
  res: ServerResponse,
  context: RailwayRouteContext,
  capability: RailwayCapability,
  buildQuery: () => T,
): Promise<void> {
  const routing = context.router.describeRouting();
  let query: T;
  try {
    query = buildQuery();
  } catch {
    send(res, 400, { success: false, provider: null, error: 'INVALID_RAILWAY_QUERY', message: 'malformed query parameters' });
    return;
  }

  const startedAt = Date.now();
  const result = await routeCapability(context.router, capability, query);
  await respondWithResult(res, result, routing.primary, Date.now() - startedAt);
}

async function routeCapability<T>(router: RailwayProviderRouter, capability: RailwayCapability, query: T): Promise<ProviderResult<unknown>> {
  switch (capability) {
    case 'stationLookup':
      return router.stationLookup(query as StationLookupQuery);
    case 'trainSearch':
      return router.trainSearch(query as TrainSearchQuery);
    case 'trainInfo':
      return router.trainInfo(query as TrainRefQuery);
    case 'timetable':
      return router.timetable(query as TrainRefQuery);
    case 'liveStatus':
      return router.liveStatus(query as LiveStatusQuery);
    case 'availability':
      return router.availability(query as AvailabilityQuery);
    case 'fare':
      return router.fare(query as FareQuery);
    case 'pnr':
      return router.pnr(query as PNRQuery);
    case 'cancelledTrains':
      return router.cancelledTrains(query as CancelledTrainsQuery);
  }
}

function providerConfig(res: ServerResponse, context: RailwayRouteContext): void {
  const routing = context.router.describeRouting();
  const providers = context.router.providers.map((provider) => ({
    provider: provider.providerId.toLowerCase(),
    displayName: provider.displayName,
    role: provider.providerId === routing.primary ? 'primary' : 'fallback',
    capabilities: [...provider.capabilities],
    credentialConfigured: provider.credentialConfigured ?? null,
    endpointStatus: provider.endpointStatus ?? null,
  }));

  const operations = RAILWAY_CAPABILITIES.map((capability) => ({
    operation: capability,
    supportedBy: context.router.providers.filter((provider) => provider.supports(capability)).map((provider) => provider.providerId.toLowerCase()),
  }));

  send(res, 200, {
    success: true,
    primary: routing.primary.toLowerCase(),
    fallbackOrder: routing.fallbackOrder.map((id) => id.toLowerCase()),
    providers,
    operations,
    note: 'Credential VALUES are never exposed. Configure RAILCORE_API_KEY / RAILKIT_API_KEY in the server environment.',
  });
}

export async function handleRailwayApi(
  res: ServerResponse,
  pathname: string,
  params: QueryParams,
  context: RailwayRouteContext,
): Promise<boolean> {
  const route = pathname.slice('/api/railway/'.length);

  switch (route) {
    case 'stations':
      await run(res, context, 'stationLookup', () => ({ query: param(params, 'q', 'query') ?? '' }));
      return true;
    case 'trains':
      await run(res, context, 'trainSearch', () => ({
        originCode: param(params, 'from', 'origin') ?? '',
        destinationCode: param(params, 'to', 'destination') ?? '',
        journeyDate: param(params, 'date'),
      }));
      return true;
    case 'train-info':
      await run(res, context, 'trainInfo', () => ({ trainNumber: param(params, 'train', 'trainNumber', 'number') ?? '' }));
      return true;
    case 'timetable':
      await run(res, context, 'timetable', () => ({ trainNumber: param(params, 'train', 'trainNumber', 'number') ?? '' }));
      return true;
    case 'live-status':
      await run(res, context, 'liveStatus', () => ({
        trainNumber: param(params, 'train', 'trainNumber', 'number') ?? '',
        journeyDate: param(params, 'date'),
      }));
      return true;
    case 'availability': {
      await run(res, context, 'availability', () => {
        const travelClass = param(params, 'class', 'travelClass', 'coach');
        return {
          trainNumber: param(params, 'train', 'trainNumber', 'number') ?? '',
          journeyDate: param(params, 'date') ?? '',
          travelClass: travelClass ? (travelClass.toUpperCase() as TravelClassCode) : null,
          quota: param(params, 'quota'),
          fromStationCode: param(params, 'from'),
          toStationCode: param(params, 'to'),
        };
      });
      return true;
    }
    case 'fare':
      await run(res, context, 'fare', () => {
        const travelClass = param(params, 'class', 'travelClass');
        return {
          trainNumber: param(params, 'train', 'trainNumber', 'number') ?? '',
          fromStationCode: param(params, 'from'),
          toStationCode: param(params, 'to'),
          journeyDate: param(params, 'date'),
          travelClass: travelClass ? (travelClass.toUpperCase() as TravelClassCode) : null,
          quota: param(params, 'quota'),
        };
      });
      return true;
    case 'pnr':
      await run(res, context, 'pnr', () => ({ pnr: param(params, 'pnr', 'number') ?? '' }));
      return true;
    case 'cancelled':
      await run(res, context, 'cancelledTrains', () => ({ journeyDate: param(params, 'date') ?? '' }));
      return true;
    case 'provider-config':
      providerConfig(res, context);
      return true;
    default:
      send(res, 404, { success: false, provider: null, error: 'NOT_FOUND' });
      return true;
  }
}
