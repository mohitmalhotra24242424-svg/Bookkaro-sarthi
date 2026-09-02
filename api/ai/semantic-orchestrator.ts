/**
 * SEMANTIC AI TOOL PLANNER — BACKEND ORCHESTRATOR.
 *
 * Input : SemanticPlannerResult (a validated plan) + conversation.
 * Output: reply + executed tools + source diagnostics.
 *
 * The backend is the ONLY executor:
 *   - validates the plan's required args (via the Step-6 catalog),
 *   - fills missing args from conversation context / deterministic resolution,
 *   - routes every real call through the ToolRegistry → ProviderRouter
 *     (RailCore primary → RailKit fallback),
 *   - computes comparisons deterministically from real data,
 *   - words the reply from verified data ONLY (never invented).
 *
 * The AI never receives keys/URLs and never executes. This module is the
 * deterministic server-side boundary.
 */

import type { ConversationContext, ToolResult, TrainSearchResult, Timetable } from '../../shared/index.js';
import { isZeroResult, newId } from '../../shared/index.js';
import { resolveDateText, resolveStationChoice } from '../../ai/slotResolution.js';
import { setContextSlots } from '../../shared/index.js';
import {
  cancelledReply,
  fareReply,
  liveStatusReply,
  pnrReply,
  railwayUnavailableReply,
  searchResultsReply,
  stationChoiceReply,
  timetableReply,
  trainInfoReply,
} from '../../ai/replyTemplates.js';
import type { ToolRegistry } from '../../tools/index.js';
import { validateToolArguments } from './tool-catalog.js';
import type { Station } from '../../shared/index.js';
import { stationFromLookup } from '../../ai/slotResolution.js';
import type { SemanticPlannerResult, SemanticPlan, SemanticToolCall } from './semantic-plan.js';
import { getSemanticTool, semanticToolToCatalogId } from './semantic-tools.js';
import type { ToolCall, ToolName, ToolResult as SharedToolResult } from '../../shared/index.js';

export interface SemanticDiagnostics {
  aiProvider: string;
  source: string;
  modelUsed: string | null;
  intent: string;
  confidence: number;
  selectedTools: string[];
  toolSuccess: boolean;
  toolLatencyMs: number;
  railwayProviderAttempted: string | null;
  railwayProviderUsed: string | null;
  railwayFallbackReason: string | null;
  providerLatencyMs: number;
  fallbackReason: string | null;
  /** true => this answer was written from REAL provider data. */
  realData: boolean;
}

export interface SemanticTurnResult {
  reply: string;
  intent: string;
  usedNlu: boolean;
  executedTools: string[];
  safetyRejections: string[];
  diagnostics: SemanticDiagnostics;
  cards: unknown[] | null;
  panel: unknown | null;
  context: ConversationContext;
}

export interface SemanticOrchestratorDeps {
  registry: ToolRegistry;
  now?: () => Date;
  /** Raw user message (present when continuing a journey after a station choice). */
  message?: string;
}

/** JSON-safe snapshot of a SemanticPlannerResult so a journey can resume. */
export function snapshotSemanticPlan(planResult: SemanticPlannerResult): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    plan: planResult.plan,
    source: planResult.source,
    modelUsed: planResult.modelUsed,
    fallbackReason: planResult.fallbackReason,
    raw: planResult.raw,
    usedNlu: planResult.usedNlu,
  }));
}

/** Restore a SemanticPlannerResult from a snapshot (tolerates missing/guarded fields). */
export function restoreSemanticPlan(snapshot: Record<string, unknown> | null): SemanticPlannerResult | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const plan = snapshot.plan as SemanticPlan | null;
  if (plan !== null && typeof plan !== 'object') return null;
  return {
    plan: plan ?? null,
    source: (snapshot.source as SemanticPlannerResult['source']) ?? 'none',
    modelUsed: typeof snapshot.modelUsed === 'string' ? snapshot.modelUsed : null,
    fallbackReason: typeof snapshot.fallbackReason === 'string' ? snapshot.fallbackReason : null,
    raw: typeof snapshot.raw === 'string' ? snapshot.raw : null,
    usedNlu: snapshot.usedNlu === true,
  };
}

/** Replace the ambiguous origin/destination arg in every planned call with the chosen code. */
function patchPlanStation(plan: SemanticPlan, field: 'origin' | 'destination', code: string): SemanticPlan {
  return {
    ...plan,
    toolPlan: plan.toolPlan.map((call) => {
      const args = { ...call.args };
      if (field === 'origin') {
        if ('originCode' in args) args.originCode = code;
        if ('fromStationCode' in args) args.fromStationCode = code;
      } else {
        if ('destinationCode' in args) args.destinationCode = code;
        if ('toStationCode' in args) args.toStationCode = code;
      }
      return { ...call, args };
    }),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const REGISTRY_TOOL_FOR_CATALOG: Record<string, ToolName> = {
  SEARCH_TRAINS: 'searchTrains',
  GET_TRAIN_INFO: 'getTrainInfo',
  GET_TIMETABLE: 'getTimetable',
  GET_LIVE_STATUS: 'getLiveStatus',
  GET_AVAILABILITY: 'getAvailability',
  GET_FARE: 'getFare',
  GET_PNR: 'checkPNR',
  GET_CANCELLED_TRAINS: 'getCancelledTrains',
  RAILWAY_KNOWLEDGE: 'getRailwayKnowledge',
};

function registryToolForCatalogId(catalogId: string): ToolName | null {
  return REGISTRY_TOOL_FOR_CATALOG[catalogId] ?? null;
}

/** Unique key for a planned call — distinguishes two calls of the same tool. */
function semanticResultKey(call: SemanticToolCall): string {
  const train = typeof call.args.trainNumber === 'string' ? call.args.trainNumber : '';
  return `${call.tool}${train ? `:${train}` : ''}`;
}

/** Collect all results for a given semantic tool (e.g. both GET_TIMETABLE calls). */
function resultsForTool(results: Map<string, SharedToolResult>, tool: string): SharedToolResult[] {
  const out: SharedToolResult[] = [];
  for (const [key, result] of results) {
    if (key === tool || key.startsWith(`${tool}:`)) out.push(result);
  }
  return out;
}

function asToolResult(tool: string): SharedToolResult {
  return {
    callId: null,
    tool,
    ok: false,
    data: null,
    unavailableReason: null,
    error: { code: 'RAILWAY_DATA_UNAVAILABLE', message: 'Railway data is currently unavailable.' },
    executedBy: 'SERVER',
  };
}

function dataOf<T>(result: SharedToolResult | null | undefined): T | null {
  if (!result || !result.ok) return null;
  if (isZeroResult(result as never)) return null;
  return result.data as T | null;
}

/** Resolve one plan call into a catalog id + args, filling from context/dates where safe. */
function resolveCall(
  call: SemanticToolCall,
  context: ConversationContext,
  now: Date,
): { catalogId: string | null; args: Record<string, unknown>; rejection: string | null; needsClarification: string | null } {
  const definition = getSemanticTool(call.tool);
  if (!definition) return { catalogId: null, args: {}, rejection: `unknown semantic tool "${call.tool}"`, needsClarification: null };
  const catalogId = semanticToolToCatalogId(call.tool);
  if (!catalogId) return { catalogId: null, args: {}, rejection: `no catalog mapping for "${call.tool}"`, needsClarification: null };

  // Strip explicit nulls — the model emits null for "not known"; treat as absent.
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.args)) {
    if (value !== null && value !== '') args[key] = value;
  }

  if (args.trainNumber === undefined && call.tool !== 'SEARCH_TRAINS' && context.selectedTrain?.number) {
    args.trainNumber = context.selectedTrain.number;
  }
  if (args.travelClass === undefined && context.selectedClass) args.travelClass = context.selectedClass;
  if (args.fromStationCode === undefined && context.origin?.code) args.fromStationCode = context.origin.code;
  if (args.toStationCode === undefined && context.destination?.code) args.toStationCode = context.destination.code;

  if (args.journeyDate !== undefined && typeof args.journeyDate === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(args.journeyDate)) {
    const resolved = resolveDateText(args.journeyDate, now);
    if (resolved) args.journeyDate = resolved;
    else return { catalogId, args, rejection: null, needsClarification: 'journeyDate' };
  }

  if ((call.tool === 'CHECK_AVAILABILITY' || call.tool === 'GET_FARE') && context.lastSearchResults?.[0]) {
    const first = context.lastSearchResults[0];
    if (args.fromStationCode === undefined && first?.fromStation?.code) args.fromStationCode = first.fromStation.code;
    if (args.toStationCode === undefined && first?.toStation?.code) args.toStationCode = first.toStation.code;
  }

  return { catalogId, args, rejection: null, needsClarification: null };
}

interface StationResolve {
  /** The single resolved station (unambiguous name/code), if any. */
  station: Station | null;
  /** Multiple candidate stations (>1) — the user MUST choose; never auto-pick. */
  ambiguous: Station[] | null;
}

/**
 * Resolve a station NAME → code via the existing lookupStation tool (RailCore,
 * cached server-side). Never silently auto-picks among several matches: when the
 * lookup returns >1 candidate the result is `ambiguous` (so the orchestrator
 * surfaces the choice). Only an unambiguous single match, or an explicit code,
 * yields a `station`.
 */
async function resolveStationToCode(
  registry: ToolRegistry,
  value: unknown,
  conversationId: string | null,
  now: Date,
): Promise<StationResolve> {
  if (typeof value !== 'string' || value.trim().length === 0) return { station: null, ambiguous: null };
  const query = value.trim();
  const catalogId = 'LOOKUP_STATION';
  const validation = validateToolArguments(catalogId, { query });
  if (!validation.ok) return { station: null, ambiguous: null };
  const registryTool: ToolName | null = 'lookupStation';
  const call: ToolCall = { id: newId('stn'), tool: registryTool, input: validation.sanitized, requestedBy: 'SERVER', conversationId, createdAt: now.toISOString() };
  const result = await registry.execute(call, { actor: 'SERVER', userId: null, conversationId, call });
  if (!result.ok) return { station: null, ambiguous: null };
  const stations = (result.data as Station[] | null) ?? [];
  // De-duplicate by code, preserving order (the deterministic machine does the same).
  const unique: Station[] = [];
  const seen = new Set<string>();
  for (const station of stations) {
    const code = (station.code ?? '').toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    unique.push(station);
  }
  // EXACT CODES ARE PROVIDER-VERIFIED: even a code-looking token (the AI might
  // emit "DELHI", "NDLS") goes through the provider. We NEVER trust an AI code
  // that RailCore did not return. First check the code-only match, then route
  // through the name classifier (which surfaces genuine city ambiguity).
  // An upper-case token the provider did NOT verify (byCode empty) is not a real
  // code — it falls through to the name classifier so the real stations are asked
  // (never a fabricated code). This is the AI-invented-code guard.
  const byCode = unique.filter((station) => station.code.toUpperCase() === query.toUpperCase());
  if (byCode.length === 1 && byCode[0]) return { station: byCode[0], ambiguous: null };
  const { station, choiceNeeded } = stationFromLookup(query, unique);
  if (station) return { station, ambiguous: null };
  // Use the SAME top-ranked selection as the deterministic machine ONLY when the
  // lookup genuinely collapsed to a single candidate.
  if (unique.length === 1) return { station: unique[0] ?? null, ambiguous: null };
  // >1 genuine candidates → ask the user; never auto-pick.
  if (choiceNeeded && choiceNeeded.length > 0) return { station: null, ambiguous: choiceNeeded };
  if (unique.length > 1) return { station: null, ambiguous: unique };
  return { station: null, ambiguous: null };
}

/**
 * When CHECK_AVAILABILITY / GET_FARE lack an explicit segment, derive the
 * journey segment deterministically from the train's own origin→destination
 * (real trainInfo data). Honest: the user did not name a partial segment, so
 * the full train route is the requested segment.
 */
async function fillSegmentFromTrainInfo(
  registry: ToolRegistry,
  args: Record<string, unknown>,
  conversationId: string | null,
  now: Date,
): Promise<Record<string, unknown>> {
  if (args.fromStationCode !== undefined || args.toStationCode !== undefined || typeof args.trainNumber !== 'string') return args;
  const catalogId = 'GET_TRAIN_INFO';
  const validation = validateToolArguments(catalogId, { trainNumber: args.trainNumber });
  if (!validation.ok) return args;
  const call: ToolCall = { id: newId('seg'), tool: 'getTrainInfo', input: validation.sanitized, requestedBy: 'SERVER', conversationId, createdAt: now.toISOString() };
  const result = await registry.execute(call, { actor: 'SERVER', userId: null, conversationId, call });
  if (!result.ok) return args;
  const train = result.data as { originStation?: { code: string } | null; destinationStation?: { code: string } | null } | null;
  if (!train?.originStation?.code || !train.destinationStation?.code) return args;
  return { ...args, fromStationCode: train.originStation.code, toStationCode: train.destinationStation.code };
}

/** Pre-execution result: normalized args, or a pending station choice. */
interface ResolvedSearch {
  args: Record<string, unknown>;
  /** Set when a station name matched >1 station — ask the user (never auto-pick). */
  stationChoice: { field: 'origin' | 'destination'; options: Station[]; originalInput: string } | null;
}

/** Pre-execution: normalize station args in a SEARCH_TRAINS/AVAILABILITY/FARE call to codes. */
async function resolveSearchStations(
  registry: ToolRegistry,
  args: Record<string, unknown>,
  conversationId: string | null,
  now: Date,
  context: ConversationContext,
): Promise<ResolvedSearch> {
  const from = args.originCode ?? args.fromStationCode;
  const to = args.destinationCode ?? args.toStationCode;
  const resolvedFrom = from !== undefined ? await resolveStationToCode(registry, from, conversationId, now) : null;
  const resolvedTo = to !== undefined ? await resolveStationToCode(registry, to, conversationId, now) : null;

  // Origin ambiguity takes precedence (ask one field at a time, like the machine).
  if (resolvedFrom?.ambiguous && resolvedFrom.ambiguous.length > 1) {
    return { args, stationChoice: { field: 'origin', options: resolvedFrom.ambiguous, originalInput: String(from ?? '') } };
  }

  const next = { ...args };
  if (resolvedFrom?.station) {
    if (args.originCode !== undefined) next.originCode = resolvedFrom.station.code;
    if (args.fromStationCode !== undefined) next.fromStationCode = resolvedFrom.station.code;
    context.origin = resolvedFrom.station;
  }

  if (resolvedTo?.ambiguous && resolvedTo.ambiguous.length > 1) {
    return { args: next, stationChoice: { field: 'destination', options: resolvedTo.ambiguous, originalInput: String(to ?? '') } };
  }
  if (resolvedTo?.station) {
    if (args.destinationCode !== undefined) next.destinationCode = resolvedTo.station.code;
    if (args.toStationCode !== undefined) next.toStationCode = resolvedTo.station.code;
    context.destination = resolvedTo.station;
  }
  return { args: next, stationChoice: null };
}

// ── execute one call through the registry ────────────────────────────────────

interface ExecutedOne {
  ok: boolean;
  result: SharedToolResult | null;
  rejection: string | null;
  latencyMs: number;
}

async function executeOne(
  registry: ToolRegistry,
  catalogId: string,
  args: Record<string, unknown>,
  conversationId: string | null,
  actor: 'AI' | 'SERVER',
  now: Date,
): Promise<ExecutedOne> {
  const startedAt = Date.now();

  const validation = validateToolArguments(catalogId, args);
  if (!validation.ok) {
    return { ok: false, result: null, rejection: validation.errors.join('; '), latencyMs: 0 };
  }

  const registryTool = registryToolForCatalogId(catalogId);
  if (!registryTool) {
    return { ok: false, result: null, rejection: `"${catalogId}" has no executable registry tool`, latencyMs: 0 };
  }

  const call: ToolCall = {
    id: newId('smc'),
    tool: registryTool,
    input: validation.sanitized,
    requestedBy: actor,
    conversationId,
    createdAt: now.toISOString(),
  };
  const result = await registry.execute(call, { actor: 'AI', userId: null, conversationId, call });
  return { ok: result.ok, result, rejection: result.ok ? null : (result.error?.code ?? 'TOOL_FAILED'), latencyMs: Date.now() - startedAt };
}

// ── reply composition (verified data only) ───────────────────────────────────

function clockMinutes(time: string | null): number | null {
  if (!time) return null;
  const [hRaw, mRaw] = time.split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  return Number.isFinite(h) && Number.isFinite(m) && hRaw !== undefined && mRaw !== undefined ? h * 60 + m : null;
}

function availabilityLines(data: Record<string, unknown>): string {
  const train = String(data.trainNumber ?? '');
  const cls = String(data.travelClass ?? '');
  const status = String(data.status ?? '');
  const base = `${train} mein ${cls}:`;
  switch (status) {
    case 'AVAILABLE': return `${base} seats AVAILABLE hain${data.availableCount != null ? ` (${data.availableCount} seats)` : ''}.`;
    case 'RAC': return `${base} RAC hai${data.racCount != null ? ` (${data.racCount} RAC)` : ''}.`;
    case 'WAITLIST': return `${base} waiting list hai${data.waitlistNumber != null ? ` (WL ${data.waitlistNumber})` : ''}.`;
    case 'REGRET': return `${base} booking band hai (REGRET).`;
    default: return railwayUnavailableReply(asToolResult('CHECK_AVAILABILITY'));
  }
}

/** Build a comparison reply ONLY from verified provider data. Never invents a winner. */
function buildComparisonReply(plan: SemanticPlan, results: Map<string, SharedToolResult>): string | null {
  const plannedNumbers = plan.toolPlan
    .filter((call) => call.tool === 'GET_TIMETABLE' || call.tool === 'GET_TRAIN_INFO')
    .map((call) => String(call.args.trainNumber ?? '').trim().replace(/"/g, ''))
    .filter(Boolean);
  const entityNumbers = plan.entities.trainNumbers.filter(Boolean);
  const candidates = [...new Set([...entityNumbers, ...plannedNumbers])].slice(0, 2);
  if (candidates.length < 2) return null;

  const metric = plan.comparison ?? 'EARLIEST_ARRIVAL';
  const entries: { number: string; arrival: string | null; departure: string | null }[] = [];
  const timetableResults = resultsForTool(results, 'GET_TIMETABLE');
  const infoResults = resultsForTool(results, 'GET_TRAIN_INFO');
  for (const number of candidates) {
    let timetable: Timetable | null = null;
    for (const result of timetableResults) {
      const data = result.data as Timetable | null;
      if (data?.trainNumber === number) timetable = data;
    }
    if (timetable) {
      const last = timetable.stops[timetable.stops.length - 1];
      const first = timetable.stops[0];
      entries.push({ number, arrival: last?.arrivalTime ?? null, departure: first?.departureTime ?? null });
    } else {
      let train: { number: string; arrivalTime: string | null; departureTime: string | null } | null = null;
      for (const result of infoResults) {
        const data = result.data as { number: string; arrivalTime: string | null; departureTime: string | null } | null;
        if (data?.number === number) train = data;
      }
      if (train?.number === number) entries.push({ number, arrival: train.arrivalTime, departure: train.departureTime });
      else entries.push({ number, arrival: null, departure: null });
    }
  }
  if (entries.length < 2) return null;

  const values: number[] = [];
  for (const entry of entries) {
    const value = metric === 'EARLIEST_DEPARTURE' ? clockMinutes(entry.departure) : clockMinutes(entry.arrival);
    if (value !== null) values.push(value);
  }
  if (values.length < 2) {
    return `Compare nahi kar paya — ${metric === 'EARLIEST_DEPARTURE' ? 'departure' : 'arrival'} time dono trains ke liye provider data mein nahi mila. Main andaza nahi lagata.`;
  }
  const best = Math.min(...values);
  const winner = entries[values.indexOf(best)]?.number ?? null;
  if (!winner) return null;
  const label = metric === 'EARLIEST_ARRIVAL' ? 'EARLIEST ARRIVAL' : metric === 'EARLIEST_DEPARTURE' ? 'EARLIEST DEPARTURE' : 'SHORTEST DURATION';
  const lines = entries.map((entry) => `• ${entry.number} — ${metric === 'EARLIEST_DEPARTURE' ? (entry.departure ?? '?') : (entry.arrival ?? '?')}`);
  return `Poorni list compare (verified data se):\n${lines.join('\n')}\n→ Winner: ${winner} (${label}).`;
}

function speak(results: Map<string, SharedToolResult>, plan: SemanticPlan, context: ConversationContext): string {
  const parts: string[] = [];
  if (plan.comparison) {
    const comparison = buildComparisonReply(plan, results);
    if (comparison) parts.push(comparison);
    return parts.join('\n\n');
  }
  for (const call of plan.toolPlan) {
    const result = results.get(semanticResultKey(call)) ?? resultsForTool(results, call.tool)[0];
    if (!result || !result.ok) {
      parts.push(railwayUnavailableReply(asToolResult(call.tool)));
      continue;
    }
    const data = result.data as Record<string, unknown> | null;
    if (call.tool === 'SEARCH_TRAINS' && data) {
      const list = (data as unknown as { results?: TrainSearchResult[] }).results ?? (data as unknown as TrainSearchResult[]);
      parts.push(searchResultsReply(Array.isArray(list) ? list : [], context.origin, context.destination));
    } else if (call.tool === 'TRACK_TRAIN' && data) {
      parts.push(liveStatusReply(data as never));
    } else if (call.tool === 'CHECK_AVAILABILITY' && data) {
      parts.push(availabilityLines(data));
    } else if (call.tool === 'GET_FARE' && data) {
      parts.push(fareReply(data as never));
    } else if (call.tool === 'GET_TIMETABLE' && data) {
      parts.push(timetableReply(data as never));
    } else if (call.tool === 'GET_TRAIN_INFO' && data) {
      parts.push(trainInfoReply(data as never));
    } else if (call.tool === 'CHECK_PNR' && data) {
      parts.push(pnrReply(data as never));
    } else if (call.tool === 'GET_CANCELLED_TRAINS' && data) {
      parts.push(cancelledReply((data as unknown as readonly import('../../shared/index.js').CancelledTrain[]) ?? []));
    } else if (call.tool === 'GENERAL_RAILWAY_ANSWER' && data) {
      const text = (data as Record<string, unknown>).retrievedText;
      parts.push(typeof text === 'string' ? text : railwayUnavailableReply(asToolResult(call.tool)));
    } else {
      parts.push(railwayUnavailableReply(asToolResult(call.tool)));
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : 'Abhi railway data available nahi ho raha. Thodi der baad try karein.';
}

// ── diagnostics ──────────────────────────────────────────────────────────────

function diagnosticsFor(
  source: string,
  planResult: SemanticPlannerResult,
  intent: string,
  selectedTools: string[],
  toolSuccess: boolean,
  toolLatencyMs: number,
  railwayProviderUsed: string | null,
  fallbackReason: string | null,
  realData: boolean,
): SemanticDiagnostics {
  return {
    aiProvider: source,
    source,
    modelUsed: planResult.modelUsed,
    intent,
    confidence: planResult.plan?.confidence ?? 0,
    selectedTools,
    toolSuccess,
    toolLatencyMs,
    railwayProviderAttempted: railwayProviderUsed,
    railwayProviderUsed,
    railwayFallbackReason: railwayProviderUsed && fallbackReason ? fallbackReason : null,
    providerLatencyMs: 0,
    fallbackReason,
    realData,
  };
}

// ── main entry ───────────────────────────────────────────────────────────────

export async function runSemanticOrchestrator(
  planResult: SemanticPlannerResult,
  context: ConversationContext,
  deps: SemanticOrchestratorDeps,
  input: { userId: string | null; conversationId: string | null },
): Promise<SemanticTurnResult> {
  const now = deps.now ?? (() => new Date());
  const plan = planResult.plan;
  const source = planResult.source;
  const rejections: string[] = [];
  const executedTools: string[] = [];

  // ── Station disambiguation resume ──────────────────────────────────────────
  // We just asked the user to pick a station. Their reply resolves the choice
  // deterministically (never re-run the AI on "pehla"/"ASR"), patch the slot +
  // plan args, and resume the interrupted journey.
  if (context.stationChoices && deps.message) {
    const pending = context.stationChoices;
    const choice = resolveStationChoice(deps.message, pending.options);
    const question = stationChoiceReply(pending.field as 'origin' | 'destination', pending.options);
    if (!choice) {
      // Didn't match → keep waiting; re-ask.
      context = { ...context, pendingQuestion: question, updatedAt: now().toISOString() };
      return {
        reply: `Samajh nahi aaya — ${question}`,
        intent: plan?.intent ?? 'BOOK_TRAIN',
        usedNlu: planResult.usedNlu,
        executedTools: [],
        safetyRejections: [],
        diagnostics: diagnosticsFor(source, planResult, plan?.intent ?? 'BOOK_TRAIN', [], false, 0, null, planResult.fallbackReason, false),
        cards: null,
        panel: null,
        context,
      };
    }
    const field = pending.field as 'origin' | 'destination';
    const slot: { origin?: Station; destination?: Station } = field === 'origin' ? { origin: choice } : { destination: choice };
    let next = setContextSlots(context, slot, 'FILL_MISSING', now().toISOString());
    next = { ...next, stationChoices: null, pendingStationResolution: null, lastAskedField: null, pendingQuestion: null, pendingSemanticPlan: null, updatedAt: now().toISOString() };
    if (plan) {
      const patched = patchPlanStation(plan, field, choice.code);
      return runSemanticOrchestrator({ ...planResult, plan: patched }, next, deps, input);
    }
    return runSemanticOrchestrator(planResult, next, deps, input);
  }

  const emptyDiag = (intent: string, success: boolean, used: string | null): SemanticDiagnostics =>
    diagnosticsFor(source, planResult, intent, executedTools, success, 0, used, planResult.fallbackReason, false);

  if (!plan) {
    return {
      reply: 'Abhi railway data available nahi ho raha. Thodi der baad try karein.',
      intent: 'UNKNOWN',
      usedNlu: true,
      executedTools: [],
      safetyRejections: ['no executable plan'],
      diagnostics: emptyDiag('UNKNOWN', false, null),
      cards: null,
      panel: null,
      context,
    };
  }

  if (plan.needsClarification || (plan.toolPlan.length === 0 && plan.comparison === null)) {
    const question = plan.clarificationQuestion ?? 'Aur kuch bataiye? (missing detail)';
    return {
      reply: question,
      intent: plan.intent,
      usedNlu: planResult.usedNlu,
      executedTools: [],
      safetyRejections: [],
      diagnostics: emptyDiag(plan.intent, false, null),
      cards: null,
      panel: null,
      context,
    };
  }

  const results = new Map<string, SharedToolResult>();
  let toolLatencyTotal = 0;
  let anySuccess = false;
  let providerUsed: string | null = null;

  for (const call of plan.toolPlan) {
    // Key results per specific call (two GET_TIMETABLE calls for two trains must not collide).
    const resultKey = semanticResultKey(call);
    const resolved = resolveCall(call, context, now());
    if (resolved.rejection) {
      rejections.push(resolved.rejection);
      continue;
    }
    if (resolved.needsClarification) {
      return {
        reply: 'Journey date ka hisaab nahi ho paya — kis date ka jaana hai?',
        intent: plan.intent,
        usedNlu: planResult.usedNlu,
        executedTools,
        safetyRejections: [],
        diagnostics: emptyDiag(plan.intent, false, providerUsed),
        cards: null,
        panel: null,
        context,
      };
    }
    const catalogId = resolved.catalogId;
    if (!catalogId) continue;
    // Resolve free-text stations to codes before a search so a real route executes.
    let callArgs = resolved.args;
    if (catalogId === 'SEARCH_TRAINS' || catalogId === 'GET_AVAILABILITY' || catalogId === 'GET_FARE') {
      const resolvedStations = await resolveSearchStations(deps.registry, callArgs, input.conversationId, now(), context);
      if (resolvedStations.stationChoice) {
        const field = resolvedStations.stationChoice.field;
        const options = resolvedStations.stationChoice.options;
        // Persist the pending disambiguation so the NEXT turn resolves the user's
        // choice, and stash the interrupted plan so the journey can resume.
        // Step 10 — also persist the VERIFIED candidates (pendingStationResolution)
        // so the interrupted railway request survives the clarification.
        context = {
          ...context,
          stationChoices: { field, options, askedAt: now().toISOString() },
          pendingStationResolution: {
            field,
            originalInput: resolvedStations.stationChoice.originalInput,
            candidates: options.map((station) => ({ name: station.name ?? station.code, code: station.code.toUpperCase(), verified: true })),
            askedAt: now().toISOString(),
          },
          lastAskedField: field,
          pendingQuestion: stationChoiceReply(field, options),
          pendingSemanticPlan: snapshotSemanticPlan(planResult),
          updatedAt: now().toISOString(),
        };
        return {
          reply: stationChoiceReply(field, options),
          intent: plan.intent,
          usedNlu: planResult.usedNlu,
          executedTools,
          safetyRejections: [],
          diagnostics: diagnosticsFor(source, planResult, plan.intent, executedTools, false, toolLatencyTotal, providerUsed, planResult.fallbackReason, false),
          cards: null,
          panel: null,
          context,
        };
      }
      callArgs = resolvedStations.args;
    }
    // Availability/Fare without a segment: derive the full train route (real data).
    if ((catalogId === 'GET_AVAILABILITY' || catalogId === 'GET_FARE') && callArgs.fromStationCode === undefined) {
      callArgs = await fillSegmentFromTrainInfo(deps.registry, callArgs, input.conversationId, now());
    }
    const executed = await executeOne(deps.registry, catalogId, callArgs, input.conversationId, 'AI', now());
    toolLatencyTotal += executed.latencyMs;
    executedTools.push(catalogId);
    if (executed.result?.provider) providerUsed = executed.result.provider;
    if (executed.ok && executed.result) {
      results.set(resultKey, executed.result);
      anySuccess = true;
    } else if (executed.rejection) {
      rejections.push(executed.rejection);
    }
  }

  // Comparison / fastest-route: if no route search was planned but we have a route,
  // fetch real trains so the backend can rank them deterministically.
  if (plan.comparison && !results.has('SEARCH_TRAINS') && context.origin?.code && context.destination?.code && context.journeyDate) {
    const executed = await executeOne(deps.registry, 'SEARCH_TRAINS', {
      originCode: context.origin.code,
      destinationCode: context.destination.code,
      journeyDate: context.journeyDate,
    }, input.conversationId, 'SERVER', now());
    toolLatencyTotal += executed.latencyMs;
    executedTools.push('SEARCH_TRAINS');
    if (executed.ok && executed.result) {
      results.set('SEARCH_TRAINS', executed.result);
      anySuccess = true;
      if (executed.result.provider) providerUsed = executed.result.provider;
    }
  }

  const reply = anySuccess ? speak(results, plan, context) : 'Abhi railway data available nahi ho raha. Thodi der baad try karein.';
  return {
    reply,
    intent: plan.intent,
    usedNlu: planResult.usedNlu,
    executedTools,
    safetyRejections: rejections,
    diagnostics: diagnosticsFor(source, planResult, plan.intent, executedTools, anySuccess, toolLatencyTotal, providerUsed, planResult.fallbackReason, anySuccess),
    cards: null,
    panel: null,
    context,
  };
}

export type { ToolResult, Timetable, ConversationContext };
