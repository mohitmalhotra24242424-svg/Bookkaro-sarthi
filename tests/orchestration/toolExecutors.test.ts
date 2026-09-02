/**
 * Tool executor + permission layer tests (MOCK router): deterministic
 * execution, ProviderResult→ToolResult mapping, and booking safety.
 */

import { describe, expect, it } from 'vitest';
import { RailwayProviderRouter } from '../../railway/index.js';
import type { RailwayProvider } from '../../railway/index.js';
import { providerEmpty, providerFailure, providerSuccess } from '../../shared/index.js';
import type { ProviderId, RailwayCapability, ProviderResult, Station } from '../../shared/index.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { createInMemoryDraftStore } from '../../tools/executors/index.js';
import { TOOL_PERMISSIONS, canAiRequestTool, toolPermission } from '../../tools/permissions.js';

function fakeRouter(script: Partial<Record<RailwayCapability, ProviderResult<unknown>>>): RailwayProviderRouter {
  const make = (id: ProviderId, caps: RailwayCapability[]): RailwayProvider =>
    ({
      providerId: id,
      displayName: `${id}-fake`,
      capabilities: caps,
      supports: (c: RailwayCapability) => caps.includes(c),
      stationLookup: () => Promise.resolve(script.stationLookup ?? providerEmpty(id)),
      trainSearch: () => Promise.resolve(script.trainSearch ?? providerEmpty(id)),
      trainInfo: () => Promise.resolve(script.trainInfo ?? providerEmpty(id)),
      timetable: () => Promise.resolve(script.timetable ?? providerEmpty(id)),
      liveStatus: () => Promise.resolve(script.liveStatus ?? providerEmpty(id)),
      availability: () => Promise.resolve(script.availability ?? providerEmpty(id)),
      fare: () => Promise.resolve(script.fare ?? providerEmpty(id)),
      pnr: () => Promise.resolve(script.pnr ?? providerEmpty(id)),
      cancelledTrains: () => Promise.resolve(script.cancelledTrains ?? providerEmpty(id)),
    }) as unknown as RailwayProvider;
  return new RailwayProviderRouter({ providers: [make('RAILCORE', ['stationLookup', 'trainSearch', 'liveStatus', 'availability', 'fare'])] });
}

describe('permission layer (§4)', () => {
  it('READ / DRAFT / SENSITIVE_ACTION tiers are exactly as specified', () => {
    expect(TOOL_PERMISSIONS.confirmBooking).toBe('SENSITIVE_ACTION');
    expect(TOOL_PERMISSIONS.createBookingDraft).toBe('DRAFT');
    for (const tool of [
      'lookupStation', 'searchTrains', 'getTrainInfo', 'getTimetable', 'getLiveStatus',
      'getAvailability', 'getFare', 'checkPNR', 'getCancelledTrains', 'getBookings', 'getWallet',
    ] as const) {
      expect(toolPermission(tool), tool).toBe('READ');
    }
  });

  it('AI can never request confirmBooking — even if a registry entry were misconfigured', () => {
    expect(canAiRequestTool('confirmBooking', true)).toBe(false);
    expect(canAiRequestTool('confirmBooking', false)).toBe(false);
    expect(canAiRequestTool('searchTrains', true)).toBe(true);
    expect(canAiRequestTool('createBookingDraft', true)).toBe(true);
  });

  it('unknown tools fail closed to SENSITIVE_ACTION', () => {
    expect(toolPermission('launchMissiles' as never)).toBe('SENSITIVE_ACTION');
  });
});

describe('railway executors: ProviderResult → ToolResult mapping', () => {
  it('success carries normalized data, executed by SERVER', async () => {
    const stations: Station[] = [{ code: 'LDH', name: 'Ludhiana Jn', zone: null, state: null, latitude: null, longitude: null }];
    const registry = createProductionToolRegistry({ router: fakeRouter({ stationLookup: providerSuccess('RAILCORE', stations) }) });
    const result = await registry.execute(
      { id: 't1', tool: 'lookupStation', input: { query: 'Ludhiana' }, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(true);
    expect(result.executedBy).toBe('SERVER');
    expect(result.data).toEqual(stations);
  });

  it('legitimate zero results → ok:true with NO_RESULTS (honest, not an error)', async () => {
    const registry = createProductionToolRegistry({ router: fakeRouter({ trainSearch: providerEmpty('RAILCORE', 'NO_RESULTS') }) });
    const result = await registry.execute(
      { id: 't2', tool: 'searchTrains', input: { originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2099-01-01' }, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
    expect(result.unavailableReason).toBe('NO_RESULTS');
  });

  it('provider failure → honest RAILWAY_DATA_UNAVAILABLE (both providers failed → no data, no invention)', async () => {
    const registry = createProductionToolRegistry({
      router: fakeRouter({ liveStatus: providerFailure('HTTP_ERROR', '503', { httpStatus: 503, source: 'RAILCORE' }) }),
    });
    const result = await registry.execute(
      { id: 't3', tool: 'getLiveStatus', input: { trainNumber: '12014' }, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RAILWAY_DATA_UNAVAILABLE');
    expect(result.data).toBeNull();
  });

  it('invalid query through the executor → INVALID_RAILWAY_QUERY', async () => {
    const registry = createProductionToolRegistry({ router: fakeRouter({}) });
    const result = await registry.execute(
      { id: 't4', tool: 'getLiveStatus', input: { trainNumber: 'abc' }, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_CALL_REJECTED'); // schema rejects before the router
  });
});

describe('application tools: booking safety & honest user data', () => {
  it('createBookingDraft creates DATA ONLY — no booking, no money, no confirmation', async () => {
    const store = createInMemoryDraftStore();
    const registry = createProductionToolRegistry({ router: fakeRouter({}), draftStore: store });
    const result = await registry.execute(
      {
        id: 't5',
        tool: 'createBookingDraft',
        input: { originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2099-01-01', trainNumber: '12014', travelClass: 'CC', passengerCount: 2 },
        requestedBy: 'SERVER',
        conversationId: 'conv-1',
        createdAt: new Date().toISOString(),
      },
      { actor: 'SERVER', userId: 'user-1', conversationId: 'conv-1' },
    );
    expect(result.ok).toBe(true);
    const draft = result.data as { stage: string; status: string; fareQuote: unknown; confirmation: unknown };
    expect(draft.stage).toBe('CLASS_SELECTED');
    expect(draft.status).toBe('OPEN');
    expect(draft.fareQuote).toBeNull();
    expect(draft.confirmation).toBeNull();
  });

  it('getBookings is honest (empty — no booking executor exists)', async () => {
    const registry = createProductionToolRegistry({ router: fakeRouter({}) });
    const result = await registry.execute(
      { id: 't6', tool: 'getBookings', input: {}, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('getWallet is honest unavailable — no balance is ever invented', async () => {
    const registry = createProductionToolRegistry({ router: fakeRouter({}) });
    const result = await registry.execute(
      { id: 't7', tool: 'getWallet', input: {}, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toBe('NO_DATA');
    expect(result.data).toBeNull();
  });

  it('confirmBooking in the production registry: NOT_IMPLEMENTED + not AI-requestable + no executor', async () => {
    const registry = createProductionToolRegistry({ router: fakeRouter({}) });
    const definition = registry.get('confirmBooking');
    expect(definition?.status).toBe('NOT_IMPLEMENTED');
    expect(definition?.aiRequestable).toBe(false);
    expect(definition?.executionPolicy).toBe('DETERMINISTIC_ONLY');

    const aiResult = await registry.execute(
      { id: 't8', tool: 'confirmBooking', input: { draftId: 'x' }, requestedBy: 'AI', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'AI', userId: 'u', conversationId: null },
    );
    expect(aiResult.ok).toBe(false); // rejected at the boundary

    const serverResult = await registry.execute(
      { id: 't9', tool: 'confirmBooking', input: { draftId: 'x' }, requestedBy: 'SERVER', conversationId: null, createdAt: new Date().toISOString() },
      { actor: 'SERVER', userId: 'u', conversationId: null },
    );
    expect(serverResult.ok).toBe(false); // even server-side, no executor exists in Step 3
    expect(serverResult.unavailableReason).toBe('NOT_IMPLEMENTED');
  });
});
