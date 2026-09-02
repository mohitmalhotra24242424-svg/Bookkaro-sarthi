/**
 * Deterministic slot resolution — dates, stations, result references and
 * correction merges. Pure functions, no AI, no provider calls (station name →
 * code resolution is done by the orchestrator via the lookupStation tool).
 */

import type {
  ContextSlotField,
  ConversationContext,
  Station,
  TrainSearchResult,
} from '../shared/index.js';
import { setContextSlots } from '../shared/context.js';
import type { ContextSlots } from '../shared/context.js';

/** aaj → today, kal → tomorrow, parso → day after tomorrow; explicit dates pass through. */
export function resolveDateText(dateText: string | null, now: Date = new Date()): string | null {
  if (!dateText) return null;
  const text = dateText.trim().toLowerCase();
  if (text === 'aaj' || text === 'today') return isoShift(now, 0);
  if (text === 'kal' || text === 'tomorrow') return isoShift(now, 1);
  if (text === 'parso' || text === 'parsu' || text === 'day after tomorrow') return isoShift(now, 2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = Date.parse(`${text}T00:00:00Z`);
    return Number.isNaN(time) ? null : text;
  }
  // weekday tokens from the NLU: next-<day> (strictly future) or weekday-<day> (this week, else next)
  const weekdayToken = text.match(/^(?:next|weekday)-(\d)$/);
  if (weekdayToken) {
    const target = Number(weekdayToken[1]);
    const todayDow = now.getUTCDay();
    let diff = (target - todayDow + 7) % 7;
    if (diff === 0) diff = 7; // "next Monday" on a Monday → next week; bare weekday today → next week (never silently today)
    return isoShift(now, diff);
  }
  // "27-08" (day-month, unambiguous in the current year); past dates → null (ask for the year)
  const dayMonth = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = Number(dayMonth[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${now.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return iso >= now.toISOString().slice(0, 10) ? iso : null; // ambiguous year → caller asks
  }
  // "22 August" / "22 aug" / "August 22" → day-month (year applied by rule below).
  const monthNames: Record<string, string> = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03', apr: '04', april: '04',
    may: '05', jun: '06', june: '06', jul: '07', july: '07', aug: '08', august: '08', sep: '09', sept: '09',
    september: '09', oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const ddm = text.match(/^(\d{1,2})[\s-]+([a-z]{3,9})$/i);
  const mdd = text.match(/^([a-z]{3,9})[\s-]+(\d{1,2})$/i);
  let day: number | null = null;
  let month: string | null = null;
  if (ddm) {
    day = Number(ddm[1]);
    month = monthNames[ddm[2]!.toLowerCase()] ?? null;
  } else if (mdd) {
    day = Number(mdd[2]);
    month = monthNames[mdd[1]!.toLowerCase()] ?? null;
  }
  if (day !== null && month !== null) {
    if (month < '01' || month > '12' || day < 1 || day > 31) return null;
    const iso = `${now.getUTCFullYear()}-${month}-${String(day).padStart(2, '0')}`;
    return iso >= now.toISOString().slice(0, 10) ? iso : null;
  }
  return null;
}

function isoShift(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export interface StationResolution {
  station: Station | null;
  /** true when the user typed a station CODE directly (no lookup invention). */
  fromCode: boolean;
  error: string | null;
}

// A direct code is what the USER TYPED as a code (ASR, NDLS, BCT, or lowercase
// asr/ldh on mobile). Mixed-case words ("Jammu", "Amritsar") are NAMES and must
// be resolved by the lookup tool — codes are never guessed from names.
const TYPED_STATION_CODE = /^[A-Z]{2,6}\d{0,2}$/;
const TYPED_STATION_CODE_LOWER = /^[a-z]{3,4}\d{0,2}$/;
const LOWER_CODE_STOP = new Set([
  'kal', 'aaj', 'hai', 'hain', 'bhai', 'yaar', 'from', 'city', 'cant',
  'this', 'that', 'with', 'have', 'been', 'just', 'then', 'than',
]);

function asTypedCode(query: string): string | null {
  const trimmed = query.trim();
  if (TYPED_STATION_CODE.test(trimmed)) return trimmed;
  if (TYPED_STATION_CODE_LOWER.test(trimmed) && !LOWER_CODE_STOP.has(trimmed)) return trimmed.toUpperCase();
  return null;
}

/** A user-typed code is user-provided (allowed, name stays null); names need the provider. */
export function stationFromDirectInput(query: string): StationResolution | null {
  const code = asTypedCode(query);
  if (!code) return null;
  return { station: { code, name: null, zone: null, state: null, latitude: null, longitude: null }, fromCode: true, error: null };
}

/** Historic / colloquial city names → the name RailCore actually indexes. */
export const STATION_QUERY_ALIASES: Readonly<Record<string, string>> = {
  bangalore: 'bengaluru',
  banglore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  poona: 'pune',
  benares: 'varanasi',
  banaras: 'varanasi',
  kashi: 'varanasi',
  allahabad: 'prayagraj',
  gurgaon: 'gurugram',
  trivandrum: 'thiruvananthapuram',
  cochin: 'kochi',
  vizag: 'visakhapatnam',
  waltair: 'visakhapatnam',
  baroda: 'vadodara',
  mysore: 'mysuru',
  calicut: 'kozhikode',
  pondicherry: 'puducherry',
  belgaum: 'belagavi',
};

/**
 * Lookup query sent to the provider — aliases only, never a station-code guess.
 * A junction/cantt suffix is stripped so "amritsar jn" / "ldh jn" look up cleanly
 * ("amritsar", "ldh") instead of returning every "JN" station (the user bug).
 */
export function canonicalLookupQuery(query: string): string {
  const trimmed = query.trim();
  const stripped = trimmed.replace(/\s+(jn\.?|jnc|junction|cantt\.?|cant|cantonment|terminus|terminal|cst|central|city)$/i, '').trim();
  const alias = STATION_QUERY_ALIASES[stripped.toLowerCase()];
  return alias ?? (stripped.length > 0 ? stripped : trimmed);
}

function queryNeedles(query: string): string[] {
  const lowered = query.trim().toLowerCase();
  const alias = STATION_QUERY_ALIASES[lowered];
  return alias && alias !== lowered ? [lowered, alias] : [lowered];
}

/** Normalize a junction/cantt/terminus suffix: "LUDHIANA JN" → "ludhiana". */
function stationBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+(jn\.?|junction|cantt\.?|cant|cantonment|city|terminus|terminal|central|ctl|east|west|south|north|peta|saheb|road|halt)$/g, '')
    .replace(/\s+(jn\.?|junction)$/g, '')
    .trim();
}

function stationMentionsQuery(station: Station, query: string): boolean {
  const n = (station.name ?? '').toLowerCase();
  const city = (station.city ?? '').toLowerCase();
  const code = station.code.toLowerCase();
  for (const needle of queryNeedles(query)) {
    if (code === needle) return true;
    if (n === needle || stationBaseName(n) === needle) return true;
    if (city === needle || stationBaseName(city) === needle) return true;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`\\b${escaped}\\b`, 'i');
    if (word.test(n) || word.test(city)) return true;
  }
  return false;
}

/** Cabins / yards / meter-gauge / booking-office codes are not passenger boarding choices. */
function isOperationalNoise(station: Station): boolean {
  const name = (station.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\b(cabin|yard|goods marshal|cbo|cbosa|rvlwr)\b/.test(name)) return true;
  if (/(?:^|\s)(c b|cb|ca cb|ck cb|ap cb|cbo sd)$/.test(name)) return true;
  if (/\bmg\b/.test(name) && !/\bbg\b/.test(name)) return true;
  return false;
}

function uniqueByCode(stations: readonly Station[]): Station[] {
  const seen = new Set<string>();
  const out: Station[] = [];
  for (const station of stations) {
    const code = station.code.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(station);
  }
  return out;
}

function rankStations(stations: Station[]): Station[] {
  return [...stations].sort((a, b) => {
    const major = Number(Boolean(b.isMajor)) - Number(Boolean(a.isMajor));
    if (major !== 0) return major;
    const conf = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (conf !== 0) return conf;
    return (a.name ?? a.code).localeCompare(b.name ?? b.code);
  });
}

function choiceList(stations: Station[]): Station[] {
  const withoutNoise = stations.filter((station) => !isOperationalNoise(station));
  const usable = withoutNoise.length > 0 ? withoutNoise : stations;
  return rankStations(usable).slice(0, 12);
}

/**
 * Smart station resolution for NAMES from REAL lookup results — no city hardcode.
 *
 * Pick order (deterministic, provider-verified stations only):
 *   1. exact station CODE ("NDLS") — user was specific
 *   2. exact station NAME ("New Delhi") — user was specific
 *   3. 2+ DISTINCT real passenger stations matching the query → ASK
 *   4. unique related match ("haridwar" → "HARIDWAR JN")
 *   5. unique leftover result
 * Otherwise → USER chooses from the real lookup list.
 */
export function stationFromLookup(query: string, stations: Station[]): { station: Station | null; choiceNeeded: Station[] | null } {
  if (stations.length === 0) return { station: null, choiceNeeded: null };
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  const unique = uniqueByCode(stations);

  // "amritsar jn" / "ldh jn" / "ludhiana junction" — the user named the TYPE.
  // Prefer the matching JN/CANTT among provider results instead of asking ASR vs ASRA vs VKA.
  const suffixMatch = trimmed.match(/^(.+?)\s+(jn\.?|jnc|junction|cantt\.?|cant|cantonment)$/i);
  const qualifier = suffixMatch?.[2]?.toLowerCase().replace(/\./g, '') ?? null;
  const core = (suffixMatch?.[1] ?? trimmed).trim();
  const coreLower = core.toLowerCase();

  const byCodeCore = unique.filter((station) => station.code.toLowerCase() === coreLower);
  if (byCodeCore.length === 1 && byCodeCore[0]) return { station: byCodeCore[0], choiceNeeded: null };

  const byFullName = unique.filter((station) => (station.name ?? '').toLowerCase() === lowered);
  if (byFullName.length === 1 && byFullName[0] && suffixMatch) {
    return { station: byFullName[0], choiceNeeded: null };
  }

  if (qualifier && /^(jn|jnc|junction)$/.test(qualifier)) {
    const jnHits = unique.filter((station) => {
      const name = (station.name ?? '').toLowerCase();
      if (!/\bjn\b|\bjunction\b/.test(name)) return false;
      return station.code.toLowerCase() === coreLower || stationBaseName(name) === coreLower || stationMentionsQuery(station, coreLower);
    });
    const exactJn = jnHits.filter((station) => {
      const name = (station.name ?? '').toLowerCase();
      return station.code.toLowerCase() === coreLower || stationBaseName(name) === coreLower;
    });
    const jnChoice = choiceList(exactJn.length > 0 ? exactJn : jnHits);
    if (jnChoice.length === 1 && jnChoice[0]) return { station: jnChoice[0], choiceNeeded: null };
    if (jnChoice.length > 1) return { station: null, choiceNeeded: jnChoice };
  }
  if (qualifier && /^(cantt|cant|cantonment)$/.test(qualifier)) {
    const canttHits = unique.filter((station) => {
      const name = (station.name ?? '').toLowerCase();
      if (!/\bcantt\b|\bcant\b|\bcantonment\b/.test(name)) return false;
      return station.code.toLowerCase() === coreLower || stationBaseName(name) === coreLower || stationMentionsQuery(station, coreLower);
    });
    const exactCantt = canttHits.filter((station) => {
      const name = (station.name ?? '').toLowerCase();
      return station.code.toLowerCase() === coreLower || stationBaseName(name) === coreLower;
    });
    const canttChoice = choiceList(exactCantt.length > 0 ? exactCantt : canttHits);
    if (canttChoice.length === 1 && canttChoice[0]) return { station: canttChoice[0], choiceNeeded: null };
    if (canttChoice.length > 1) return { station: null, choiceNeeded: canttChoice };
  }

  const byCode = unique.filter((station) => station.code.toLowerCase() === lowered);
  if (byCode.length === 1 && byCode[0]) return { station: byCode[0], choiceNeeded: null };

  const related = unique.filter((station) => stationMentionsQuery(station, lowered));
  const relatedChoice = choiceList(related);

  const byExactName = unique.filter((station) => station.name?.toLowerCase() === lowered);
  if (byExactName.length === 1 && byExactName[0]) {
    const exact = byExactName[0];
    // A bare SINGLE-TOKEN city name may coincide with a station's literal name
    // (RailCore names Old Delhi's junction "DELHI", Kolkata "KOLKATA", Nagpur
    // "NAGPUR"). If ≥2 OTHER distinct real passenger stations also serve the same
    // place, the query is a generic CITY (Delhi → New Delhi / Old Delhi /
    // Nizamuddin / Sarai Rohilla …) and we must ASK — never silently auto-pick
    // the one junction that happens to be named like the city. A multi-word
    // specific station name ("New Delhi", "Mumbai Central", "Jalandhar City")
    // is still exact. No city list, no hardcode — purely provider-verified data.
    const isSingleToken = lowered.split(/\s+/).filter(Boolean).length === 1;
    const otherRelated = relatedChoice.filter((station) => station.code !== exact.code);
    if (!(isSingleToken && otherRelated.length >= 2)) {
      return { station: exact, choiceNeeded: null };
    }
    // else: fall through — the query is a generic city → ask below.
  }

  if (relatedChoice.length > 1) return { station: null, choiceNeeded: relatedChoice };
  if (relatedChoice.length === 1 && relatedChoice[0]) return { station: relatedChoice[0], choiceNeeded: null };

  const leftover = choiceList(unique);
  if (leftover.length === 1 && leftover[0]) return { station: leftover[0], choiceNeeded: null };
  if (leftover.length > 1) return { station: null, choiceNeeded: leftover };
  return { station: null, choiceNeeded: null };
}

/** Match a user's disambiguation reply ("New Delhi", "pehla", "NZM") against the offered options. */
export function resolveStationChoice(reply: string, options: readonly Station[]): Station | null {
  const text = reply.trim().toLowerCase();
  if (options.length === 0) return null;
  const ordinalWords: Record<string, number> = { pehla: 0, pehli: 0, first: 0, doosra: 1, doosri: 1, second: 1, teesra: 2, teesri: 2, third: 2 };
  for (const [word, index] of Object.entries(ordinalWords)) {
    if (text === word && options[index]) return options[index] ?? null;
  }
  if (/^\d$/.test(text) && options[Number(text) - 1]) return options[Number(text) - 1] ?? null;
  for (const option of options) {
    const name = option.name?.toLowerCase() ?? '';
    const code = option.code.toLowerCase();
    const first = text.split(/[\s/|,—–-]+/).filter(Boolean)[0] ?? '';
    if (name === text || code === text || name.includes(text)) return option;
    if (first === code || text.startsWith(`${code} `) || text.includes(`(${code})`)) return option;
  }
  return null;
}

/**
 * Result references: "pehli wali"(0) "doosri wali"(1) "third train"(2)
 * "last wali"(n-1) "upar wali"(0) "12014 wali"(match by number)
 * "Shatabdi wali"(match by train NAME substring).
 * Never returns a train that is not in the provided list.
 */
export function resolveResultReference(reference: string, results: readonly TrainSearchResult[]): TrainSearchResult | null {
  if (results.length === 0) return null;
  const normalized = reference.trim().toLowerCase();
  if (normalized === 'last' || normalized === 'aakhri' || normalized === 'antim') return results[results.length - 1] ?? null;
  if (/^\d+$/.test(normalized)) {
    if (/^\d{4,6}$/.test(normalized)) {
      return results.find((entry) => entry.train.number === normalized) ?? null; // train-number reference
    }
    const index = Number(normalized) - 1;
    return index >= 0 && index < results.length ? (results[index] ?? null) : null;
  }
  // name-based reference ("Shatabdi wali") — substring match against the CURRENT list only
  const byName = results.find((entry) => entry.train.name?.toLowerCase().includes(normalized));
  return byName ?? null;
}

/**
 * CORRECTION MERGE (§11): correct ONE slot, never wipe the other.
 *  - "Nahi, Ludhiana se jaana hai" → origin=Ludhiana, destination preserved
 *  - "Delhi nahi, Chandigarh"      → destination=Chandigarh, origin preserved
 * The old value is identified by matching mentioned stations against the
 * CURRENT context slots; the unmatched station becomes the new value.
 */
export function mergeCorrection(
  context: ConversationContext,
  mentionedStations: readonly string[],
  originCandidate: string | null,
  destinationCandidate: string | null,
): { context: ConversationContext; changedFields: ContextSlotField[] } {
  const changed: ContextSlotField[] = [];

  // Case A: explicit "X se …" → origin correction only.
  if (originCandidate && !destinationCandidate) {
    const next = setContextSlots(context, { origin: stationForCandidate(originCandidate) }, 'CORRECT');
    return { context: next, changedFields: ['origin'] };
  }

  // Case B: two stations mentioned — figure out which slot the OLD value belongs to.
  if (mentionedStations.length >= 2) {
    const [first, second] = mentionedStations;
    const originText = context.origin?.name?.toLowerCase() ?? context.origin?.code.toLowerCase() ?? '';
    const destinationText = context.destination?.name?.toLowerCase() ?? context.destination?.code.toLowerCase() ?? '';
    const firstMatchesOrigin = originText.length > 0 && (first?.toLowerCase().includes(originText) || originText.includes(first!.toLowerCase()));
    const firstMatchesDestination = destinationText.length > 0 && (first?.toLowerCase().includes(destinationText) || destinationText.includes(first!.toLowerCase()));
    if (firstMatchesOrigin && second) {
      return { context: setContextSlots(context, { origin: stationForCandidate(second) }, 'CORRECT'), changedFields: ['origin'] };
    }
    if (firstMatchesDestination && second) {
      return {
        context: setContextSlots(context, { destination: stationForCandidate(second) }, 'CORRECT'),
        changedFields: ['destination'],
      };
    }
  }

  // Case C: single station, no 'se' marker — if it matches an existing slot value, it's a correction of the OTHER slot… ambiguous, so prefer destination only when context already has origin and the message pattern ends with the station ("…nahi, Chandigarh").
  if (mentionedStations.length === 1 && context.origin && !destinationCandidate) {
    const station = mentionedStations[0]!;
    return { context: setContextSlots(context, { destination: stationForCandidate(station) }, 'CORRECT'), changedFields: ['destination'] };
  }

  return { context, changedFields: changed };
}

/** Resolve a bare candidate into a minimal Station (name-only; code comes from lookup later). */
export function stationForCandidate(candidate: string): Station {
  const trimmed = candidate.trim();
  const code = asTypedCode(trimmed);
  if (code) {
    return { code, name: null, zone: null, state: null, latitude: null, longitude: null };
  }
  // name-only placeholder — the orchestrator resolves the code via lookupStation before any tool call
  return { code: '', name: trimmed, zone: null, state: null, latitude: null, longitude: null };
}

export function slotsMissingForJourney(context: ConversationContext): ContextSlotField[] {
  const missing: ContextSlotField[] = [];
  if (!context.origin) missing.push('origin');
  if (!context.destination) missing.push('destination');
  if (!context.journeyDate) missing.push('journeyDate');
  if (!context.passengerCount) missing.push('passengerCount');
  return missing;
}

export function applySlots(context: ConversationContext, slots: ContextSlots): ConversationContext {
  return setContextSlots(context, slots, 'FILL_MISSING');
}
