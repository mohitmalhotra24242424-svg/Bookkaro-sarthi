/**
 * AUTOMATIC STATION RESOLUTION (All-India, provider-backed, dynamic).
 *
 * Guarantee: before any railway operation that needs an origin/destination
 * (SEARCH_TRAINS, BOOK_TRAIN, GET_AVAILABILITY, GET_FARE), the station input is
 * run through approved provider lookup and a DETERMINISTIC classifier that
 * returns one of four outcomes. The user NEVER has to ask for lookup, and the
 * system NEVER hardcodes a city→station list — every input is classified from
 * live provider data, so ANY Indian station query supported by the providers is
 * handled dynamically.
 *
 *   USER input ─► provider lookup (RailCore primary; RailKit where supported)
 *              ─► deterministic classifier (never invents facts):
 *       EXACT_STATION       provider-verified code/name  → auto-continue
 *       SINGLE_CLEAR_MATCH  exactly one verified match   → auto-continue
 *       MULTIPLE_STATIONS   more than one verified match → ask the user
 *       NO_MATCH            zero verified matches         → honest clarification
 *
 * The AI is NEVER the station authority — only approved provider data populates
 * candidates. Codes trusted only after the provider verifies them.
 */

import type {
  Station,
  ToolCall,
  ToolName,
  ToolResult,
  ConversationContext,
  StationResolutionCandidate,
  PendingStationResolution,
} from '../shared/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { stationFromLookup } from './slotResolution.js';

/** Deterministic outcome of resolving one station input. */
export type StationResolutionType =
  | 'EXACT_STATION'
  | 'SINGLE_CLEAR_MATCH'
  | 'MULTIPLE_STATIONS'
  | 'NO_MATCH';

/** The structured result of automatic station resolution (spec: StationResolutionResult). */
export interface StationResolutionResult {
  input: string;
  resolutionType: StationResolutionType;
  selectedStation?: StationResolutionCandidate;
  candidates: StationResolutionCandidate[];
  clarificationRequired: boolean;
}

export type { StationResolutionCandidate, PendingStationResolution };

export function toCandidate(station: { code: string; name: string | null }): StationResolutionCandidate {
  return {
    name: station.name ?? station.code,
    code: station.code.toUpperCase(),
    verified: true,
  };
}

/**
 * DETERMINISTIC classifier over an already-fetched provider candidate set.
 * Generic for ANY Indian location. It mirrors the deterministic machine's
 * stationFromLookup relevance logic (so a single CLEAR match auto-continues while
 * a genuinely ambiguous city asks), but always returns the spec-shaped result.
 * Priority:
 *   1. provider-verified exact code OR exact name → EXACT_STATION
 *   2. exactly one clearly-relevant verified station → SINGLE_CLEAR_MATCH
 *   3. more than one clearly-relevant verified station → MULTIPLE_STATIONS (ask user)
 *   4. zero verified stations → NO_MATCH (honest clarification; never invents)
 */
export function classifyStationCandidates(input: string, stations: ReadonlyArray<{ code: string; name: string | null }>): StationResolutionResult {
  const text = (input ?? '').trim();

  // Build provider-shaped Station records and de-duplicate by code (preserve order).
  const unique: Station[] = [];
  const seen = new Set<string>();
  for (const station of stations) {
    const code = (station.code ?? '').toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    unique.push({ code: station.code, name: station.name, zone: null, state: null, latitude: null, longitude: null });
  }

  // 1. Exact, provider-verified code.
  const byCode = unique.filter((station) => station.code.toUpperCase() === text.toUpperCase());
  if (byCode.length === 1 && byCode[0]) {
    return { input: text, resolutionType: 'EXACT_STATION', selectedStation: toCandidate(byCode[0]), candidates: unique.map(toCandidate), clarificationRequired: false };
  }

  // 2–4. Delegates to stationFromLookup, which already handles the generic-city
  //      collision (a bare "Delhi" is NOT the literal "DELHI" junction — it asks
  //      for New Delhi / Old Delhi / Nizamuddin / Sarai Rohilla). A specific
  //      multi-word name ("New Delhi") stays EXACT_STATION; a single clear match
  //      is SINGLE_CLEAR_MATCH; >1 → MULTIPLE_STATIONS; none → NO_MATCH.
  const lookup = stationFromLookup(text, unique);
  if (lookup.station) {
    const exactName = (lookup.station.name ?? '').toLowerCase() === text.toLowerCase();
    const isExact = exactName; // code handled above
    return {
      input: text,
      resolutionType: isExact ? 'EXACT_STATION' : 'SINGLE_CLEAR_MATCH',
      selectedStation: toCandidate(lookup.station),
      candidates: unique.map(toCandidate),
      clarificationRequired: false,
    };
  }
  if (lookup.choiceNeeded && lookup.choiceNeeded.length > 0) {
    return { input: text, resolutionType: 'MULTIPLE_STATIONS', candidates: lookup.choiceNeeded.map(toCandidate), clarificationRequired: true };
  }
  return { input: text, resolutionType: 'NO_MATCH', candidates: [], clarificationRequired: true };
}

/** The station lookup registry tool (RailCore primary via the ProviderRouter). */
const LOOKUP_TOOL: ToolName = 'lookupStation';

/**
 * Provider-backed automatic resolution. Runs approved station lookup (RailCore
 * primary; RailKit fallback is handled by the ProviderRouter where supported),
 * then classifies the verified candidates. Never trusts an AI code that the
 * provider did not verify. Never invents a nearest station on NO_MATCH.
 */
export async function resolveStationAuto(
  registry: ToolRegistry,
  query: string,
  conversationId: string | null,
  now: Date,
): Promise<StationResolutionResult> {
  const text = (query ?? '').trim();
  if (text.length === 0) {
    return { input: text, resolutionType: 'NO_MATCH', candidates: [], clarificationRequired: true };
  }
  const call: ToolCall = {
    id: `stn_${Math.random().toString(36).slice(2, 10)}`,
    tool: LOOKUP_TOOL,
    input: { query: text },
    requestedBy: 'SERVER',
    conversationId,
    createdAt: now.toISOString(),
  };
  const result: ToolResult = await registry.execute(call, {
    actor: 'SERVER',
    userId: null,
    conversationId,
    call,
  });
  const stations = (result.data as Station[] | null) ?? [];
  if (!result.ok || stations.length === 0) {
    // NO_MATCH — never invent a nearest station / code.
    return { input: text, resolutionType: 'NO_MATCH', candidates: [], clarificationRequired: true };
  }
  return classifyStationCandidates(text, stations);
}

/** Skip-if-already-resolved guard: a verified station should not be re-looked-up. */
export function isFieldResolved(context: ConversationContext, field: 'origin' | 'destination'): boolean {
  const station = field === 'origin' ? context.origin : context.destination;
  return Boolean(station?.code);
}

/** Convert a resolved result into the context slot station (verified name+code). */
export function stationFromResolution(resolution: StationResolutionResult): Station | null {
  if (!resolution.selectedStation) return null;
  return {
    code: resolution.selectedStation.code,
    name: resolution.selectedStation.name,
    zone: null,
    state: null,
    latitude: null,
    longitude: null,
  };
}

/**
 * Follow-up replies must resolve ONLY against the pending verified candidates.
 * No broad re-guess, no new provider call that could invent facts. Unmatched
 * input → null (caller asks again briefly).
 */
export function matchPendingCandidate(input: string, candidates: ReadonlyArray<StationResolutionCandidate>): StationResolutionCandidate | null {
  const text = (input ?? '').trim();
  if (candidates.length === 0) return null;
  const normalized = text.toLowerCase();
  const byCode = candidates.find((candidate) => candidate.code.toLowerCase() === normalized);
  if (byCode) return byCode;
  const byName = candidates.find((candidate) => candidate.name.toLowerCase() === normalized);
  if (byName) return byName;
  const bySubstring = candidates.find(
    (candidate) => candidate.name.toLowerCase().includes(normalized) || normalized.includes(candidate.name.toLowerCase()),
  );
  return bySubstring ?? null;
}

/**
 * Reconstruct the station resolution from a pending verified choice ONLY.
 * The follow-up reply resolves against the pending survivors — never a broad
 * re-guess or a new provider call that could invent a fact. Unmatched → null.
 */
export function resolvePendingStationChoice(
  pending: PendingStationResolution,
  reply: string,
): StationResolutionResult | null {
  const choice = matchPendingCandidate(reply, pending.candidates);
  if (!choice) return null;
  return {
    input: pending.originalInput,
    resolutionType: 'SINGLE_CLEAR_MATCH',
    selectedStation: choice,
    candidates: [...pending.candidates],
    clarificationRequired: false,
  };
}
