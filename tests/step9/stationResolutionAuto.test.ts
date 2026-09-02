/**
 * AUTOMATIC STATION-LOOKUP RESOLUTION (Step 10) — regression suite.
 *
 * Guarantee under test: whenever a railway operation needs an origin/destination
 * (SEARCH_TRAINS, BOOK_TRAIN, GET_AVAILABILITY, GET_FARE) the station input
 * automatically passes through approved provider resolution BEFORE execution.
 * The classifier is provider-backed and generic (all-India, dynamic) — no
 * hardcoded city list, no invented codes/names, RailCore primary / RailKit
 * fallback only where supported (RailKit has no station-name search).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyStationCandidates,
  resolveStationAuto,
  resolvePendingStationChoice,
  matchPendingCandidate,
  isFieldResolved,
  stationFromResolution,
} from '../../ai/station-resolution.js';
import type { StationResolutionCandidate } from '../../shared/index.js';
import { createHarness, freshContext, run } from '../orchestration/harness.js';
import { providerFailure, providerSuccess } from '../../shared/index.js';

/** Provider-shaped Station records used for classifier/recovery tests. */
const station = (code: string, name: string, extra: Record<string, unknown> = {}) => ({
  code,
  name,
  zone: null,
  state: null,
  latitude: null,
  longitude: null,
  ...extra,
});

// ── classification (no hardcoded list; generic for ANY Indian city) ─────────

describe('classifyStationCandidates: exact code / exact name / single / multi / no-match', () => {
  it('1. exact provider-verified CODE → EXACT_STATION (NDLS)', () => {
    const r = classifyStationCandidates('NDLS', [station('NDLS', 'New Delhi'), station('DLI', 'Delhi Jn'), station('NZM', 'Delhi Hazrat Nizamuddin')]);
    expect(r.resolutionType).toBe('EXACT_STATION');
    expect(r.selectedStation?.code).toBe('NDLS');
    expect(r.clarificationRequired).toBe(false);
  });

  it('2. exact station NAME → EXACT_STATION ("New Delhi" → NDLS)', () => {
    const r = classifyStationCandidates('New Delhi', [station('NDLS', 'New Delhi'), station('DLI', 'Delhi Jn'), station('NZM', 'Delhi Hazrat Nizamuddin')]);
    expect(r.resolutionType).toBe('EXACT_STATION');
    expect(r.selectedStation?.code).toBe('NDLS');
  });

  it('3. generic AMBIGUOUS city (any Indian metropolis, dynamic — no hardcoded list) → MULTIPLE_STATIONS', () => {
    // "Chennai" is NOT in any hardcoded Delhi/Mumbai list; the classifier handles it dynamically.
    const r = classifyStationCandidates('Chennai', [station('MAS', 'Chennai Central'), station('MS', 'Chennai Egmore')]);
    expect(r.resolutionType).toBe('MULTIPLE_STATIONS');
    expect(r.candidates.map((c) => c.code).sort()).toEqual(['MAS', 'MS']);
    expect(r.selectedStation).toBeUndefined();
    expect(r.clarificationRequired).toBe(true);
  });

  it('4. single clear provider match → SINGLE_CLEAR_MATCH (auto-continue)', () => {
    const r = classifyStationCandidates('Jalandhar', [station('JRC', 'Jalandhar City'), station('BEAS', 'Beas')]);
    expect(r.resolutionType).toBe('SINGLE_CLEAR_MATCH');
    expect(r.selectedStation?.code).toBe('JRC');
    expect(r.clarificationRequired).toBe(false);
  });

  it('5. unknown station → NO_MATCH, no nearest station/code invented', () => {
    const r = classifyStationCandidates('XYZNONEXISTENT', []);
    expect(r.resolutionType).toBe('NO_MATCH');
    expect(r.candidates).toEqual([]);
    expect(r.selectedStation).toBeUndefined();
    expect(r.clarificationRequired).toBe(true);
  });

  it('10. AI-invented uppercased code ("DELHI") is NOT accepted as a station code → real candidates asked', () => {
    // The AI might uppercase "delhi" → "DELHI". The classifier rejects it as a code
    // (no provider-verified code "DELHI") and surfaces the real multi-station set.
    const r = classifyStationCandidates('DELHI', [station('NDLS', 'New Delhi'), station('DLI', 'Delhi Jn'), station('NZM', 'Delhi Hazrat Nizamuddin')]);
    expect(r.resolutionType).toBe('MULTIPLE_STATIONS');
    expect(r.selectedStation).toBeUndefined();
    expect(r.candidates.map((c) => c.code)).toContain('NDLS');
  });

  it('14. bare city whose junction is literally named like the city ("Delhi" where DLI = "DELHI") still ASKS — never auto-picks DLI', () => {
    // RailCore names Old Delhi's junction literally "DELHI" (code DLI). A bare city
    // query must surface ALL stations (New Delhi / Old Delhi / Nizamuddin / Sarai
    // Rohilla …), NOT silently auto-pick the one junction named like the city.
    const r = classifyStationCandidates('Delhi', [
      station('DLI', 'DELHI', { city: 'New Delhi', isMajor: true }),
      station('NDLS', 'NEW DELHI', { city: 'New Delhi', isMajor: true }),
      station('DEE', 'DELHI S ROHILLA', { city: 'New Delhi' }),
      station('DKZ', 'DELHI KISHANGNJ', { city: 'New Delhi' }),
    ]);
    expect(r.resolutionType).toBe('MULTIPLE_STATIONS');
    expect(r.selectedStation).toBeUndefined();
    const codes = r.candidates.map((c) => c.code);
    expect(codes).toContain('NDLS');
    expect(codes).toContain('DLI');
    expect(codes).toContain('DEE');
  });

  it('15. SPECIFIC multi-word station name ("New Delhi", "Mumbai Central") stays EXACT — never re-asked', () => {
    expect(classifyStationCandidates('New Delhi', [station('NDLS', 'New Delhi'), station('DLI', 'DELHI')]).resolutionType).toBe('EXACT_STATION');
    expect(classifyStationCandidates('Mumbai Central', [station('BCT', 'Mumbai Central'), station('CSTM', 'Mumbai CST')]).resolutionType).toBe('EXACT_STATION');
  });

  it('16. Kolkata-style bare city with a literal-name station also ASKS (KOAA / CP / HWH)', () => {
    const r = classifyStationCandidates('Kolkata', [
      station('KOAA', 'KOLKATA', { city: 'Kolkata', isMajor: true }),
      station('CP', 'KOLKATA', { city: 'Kolkata' }),
      station('HWH', 'HOWRAH JN', { city: 'Howrah' }),
    ]);
    expect(r.resolutionType).toBe('MULTIPLE_STATIONS');
    expect(r.selectedStation).toBeUndefined();
  });
});

// ── provider-backed automatic resolution (through the ToolRegistry) ─────────

describe('resolveStationAuto: provider-backed, RailCore primary, honest NO_MATCH', () => {
  it('resolves an exact code the provider knows (via lookupStation)', async () => {
    const harness = createHarness();
    const result = await resolveStationAuto(harness.toolRegistry, 'NDLS', 'c1', new Date('2026-08-26T10:00:00.000Z'));
    expect(result.resolutionType).toBe('EXACT_STATION');
    expect(result.selectedStation?.code).toBe('NDLS');
    expect(result.clarificationRequired).toBe(false);
  });

  it('resolves an exact name the provider knows', async () => {
    const harness = createHarness();
    const result = await resolveStationAuto(harness.toolRegistry, 'Amritsar Jn', 'c1', new Date('2026-08-26T10:00:00.000Z'));
    expect(result.resolutionType).toBe('EXACT_STATION');
    expect(result.selectedStation?.code).toBe('ASR');
  });

  it('unknown code → NO_MATCH (never invents a nearest station)', async () => {
    const harness = createHarness();
    const result = await resolveStationAuto(harness.toolRegistry, 'ZZZZZZ', 'c1', new Date('2026-08-26T10:00:00.000Z'));
    expect(result.resolutionType).toBe('NO_MATCH');
    expect(result.candidates).toEqual([]);
    expect(result.clarificationRequired).toBe(true);
  });

  it('RailCore stationLookup failure → NO_MATCH (honest; NOT a fabricated fallback)', async () => {
    const harness = createHarness({ stationLookup: providerFailure('HTTP_ERROR', 'upstream failure') });
    const result = await resolveStationAuto(harness.toolRegistry, 'Ludhiana', 'c1', new Date('2026-08-26T10:00:00.000Z'));
    expect(result.resolutionType).toBe('NO_MATCH');
    expect(result.candidates).toEqual([]);
  });

  it('11. provider search DOES fall back RailCore→RailKit for a capability both support (trainSearch)', async () => {
    const harness = createHarness({ trainSearch: providerFailure('HTTP_ERROR', 'railcore down') });
    const turn = await run(harness, freshContext(), 'Ludhiana se Amritsar kal jaana hai');
    // Route/date present, so the router attempts BOTH providers (RailCore then RailKit).
    expect(harness.countCapability('trainSearch')).toBeGreaterThan(0);
    expect(turn.executedTools).toContain('searchTrains');
  });
});

// ── pending resolution: only against verified candidates, never a re-guess ──

describe('pending station resolution (verified candidates only)', () => {
  const pending = {
    field: 'origin' as const,
    originalInput: 'Delhi',
    candidates: [
      station('NDLS', 'New Delhi'),
      station('DLI', 'Delhi Jn'),
      station('NZM', 'Delhi Hazrat Nizamuddin'),
    ] as StationResolutionCandidate[],
    askedAt: '2026-08-26T10:00:00.000Z',
  };

  it('matches a pending candidate by code or name (NDLS / New Delhi)', () => {
    expect(matchPendingCandidate('NDLS', pending.candidates)?.code).toBe('NDLS');
    expect(matchPendingCandidate('New Delhi', pending.candidates)?.code).toBe('NDLS');
    expect(resolvePendingStationChoice(pending, 'NDLS')?.selectedStation?.code).toBe('NDLS');
    expect(resolvePendingStationChoice(pending, 'New Delhi')?.selectedStation?.code).toBe('NDLS');
  });

  it('unmatched reply → null (caller re-asks briefly, never executes)', () => {
    expect(matchPendingCandidate('Ahmedabad', pending.candidates)).toBeNull();
    expect(resolvePendingStationChoice(pending, 'Ahmedabad')).toBeNull();
  });

  it('6. origin resume: choice reconstructs the origin, does NOT invent a new candidate', () => {
    const resolved = resolvePendingStationChoice(pending, 'NZM');
    expect(resolved?.resolutionType).toBe('SINGLE_CLEAR_MATCH');
    expect(resolved?.selectedStation?.code).toBe('NZM');
    expect(resolved?.candidates.map((c) => c.code)).toEqual(['NDLS', 'DLI', 'NZM']);
  });

  it('stationFromResolution maps the chosen candidate to a verified context station', () => {
    const resolved = resolvePendingStationChoice(pending, 'NDLS')!;
    const stationSlot = stationFromResolution(resolved);
    expect(stationSlot?.code).toBe('NDLS');
    expect(stationSlot?.name).toBe('New Delhi');
  });
});

// ── context preservation + no redundant re-lookup (deterministic machine) ───

describe('automatic lookup before railway operations + context preservation', () => {
  it('12. automatic lookup runs before SEARCH_TRAINS (single-station names resolved first)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Ludhiana se Amritsar kal jaana hai');
    expect(harness.countCapability('stationLookup')).toBeGreaterThan(0);
    expect(turn.context.origin?.code).toBe('LDH');
    expect(turn.context.destination?.code).toBe('ASR');
    expect(turn.executedTools).toContain('searchTrains');
  });

  it('9+13. destination ambiguity asks (not auto-picked) AND a verified station is not re-looked-up once stored', async () => {
    const harness = createHarness();
    // Turn 1: origin is single (Ludhiana→LDH), destination "Delhi" is ambiguous.
    const first = await run(harness, freshContext(), 'Ludhiana se Delhi kal jaana hai');
    expect(first.context.origin?.code).toBe('LDH');
    expect(first.context.pendingStationResolution?.field).toBe('destination');
    expect(first.context.stationChoices?.options.map((s) => s.code).sort()).toEqual(['DLI', 'NDLS', 'NZM']);
    expect(first.executedTools).not.toContain('searchTrains'); // nothing executed until chosen

    // Follow-up resolves ONLY against the pending verified candidates.
    const second = await run(harness, first.context, 'NDLS');
    expect(second.context.destination?.code).toBe('NDLS');
    expect(second.context.pendingStationResolution).toBeNull(); // cleared once resolved
    expect(second.context.origin?.code).toBe('LDH'); // origin survives
    expect(second.context.journeyDate).toBe('2026-08-27'); // date survives
    expect(second.executedTools).toContain('searchTrains');
  });

  it('6. origin resume after origin ambiguity: context (date) preserved, nothing re-asked', async () => {
    const harness = createHarness();
    const first = await run(harness, freshContext(), 'Delhi se Ludhiana kal jaana hai');
    expect(first.context.pendingStationResolution?.field).toBe('origin');
    expect(first.context.destination?.code).toBe(''); // Ludhiana placeholder, resolved later
    expect(first.context.journeyDate).toBe('2026-08-27');

    const second = await run(harness, first.context, 'New Delhi');
    expect(second.context.origin?.code).toBe('NDLS');
    expect(second.context.destination?.code).toBe('LDH');
    expect(second.context.journeyDate).toBe('2026-08-27');
    expect(second.executedTools).toContain('searchTrains');
  });

  it('7+8. date AND passenger count survive a destination clarification', async () => {
    const harness = createHarness();
    const first = await run(harness, freshContext(), 'Ludhiana se Delhi kal 2 log jaana hai');
    expect(first.context.journeyDate).toBe('2026-08-27');
    expect(first.context.passengerCount).toBe(2);
    expect(first.context.pendingStationResolution?.field).toBe('destination');

    const second = await run(harness, first.context, 'NDLS');
    expect(second.context.destination?.code).toBe('NDLS');
    expect(second.context.journeyDate).toBe('2026-08-27');
    expect(second.context.passengerCount).toBe(2);
  });

  it('13. isFieldResolved guard: a stored verified station is not re-resolved', () => {
    const ctx = freshContext();
    expect(isFieldResolved(ctx, 'origin')).toBe(false);
    const resolved = classifyStationCandidates('LDH', [station('LDH', 'Ludhiana Jn')]);
    const slot = stationFromResolution(resolved)!;
    const next = { ...ctx, origin: slot } as typeof ctx;
    expect(isFieldResolved(next, 'origin')).toBe(true);
  });
});
