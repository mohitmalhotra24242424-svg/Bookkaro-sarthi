/**
 * UNIVERSAL RAILWAY QUESTION ENGINE — DETERMINISTIC QUERY INTELLIGENCE.
 *
 * This module is the "brain" that turns natural railway phrases into a VERIFIED,
 * deterministic answer. It is PURE — no AI, no provider calls, no I/O. The
 * orchestrator feeds it real, normalized search results (already provider-verified)
 * and it returns the winner + a Hinglish line. It NEVER estimates: if the needed
 * verified field is missing for any candidate, it returns null (the caller says
 * "data unavailable") rather than guessing.
 *
 * Guarantees:
 *  - stays inside the existing deterministic pipeline (no new capabilities/URLs);
 *  - no hardcoded city/train lists (only general clock/time/rank logic);
 *  - the LLM never picks the winner — these functions do, from verified fields.
 */

import type { TrainSearchResult } from '../shared/index.js';
import type { SearchFilterHint } from '../shared/index.js';

// ── universal source classes (the 8-class taxonomy) ──────────────────────────
export type UniversalSourceClass =
  | 'LIVE_RAILWAY_DATA'
  | 'TRAIN_SEARCH'
  | 'TRAIN_COMPARISON'
  | 'TRAIN_CALCULATION'
  | 'GENERAL_RAILWAY_KNOWLEDGE'
  | 'CONTEXTUAL_RAILWAY_QUERY'
  | 'MULTI_CAPABILITY_QUERY'
  | 'NORMAL_CHAT';

export interface ClassifySourceInput {
  message?: string;
  intent: string;
  executedTools?: readonly string[];
  wasFollowUp?: boolean;
  hasContextResults?: boolean;
}

/**
 * Pure, deterministic universal classifier. It decides WHICH source class a
 * question belongs to, independent of the AI — so the answer's provenance and
 * budget are never at the mercy of a model guess. The 8 classes are exhaustive
 * and mutually exclusive in priority order.
 */
export function classifyUniversalQuerySource(input: ClassifySourceInput): UniversalSourceClass {
  const intent = input.intent;
  const tools = input.executedTools ?? [];
  const message = (input.message ?? '').toLowerCase();

  // Multi-capability: the turn exercised more than one approved capability →
  // it is a compound question, not a single source.
  const informationalTools = new Set([
    'getLiveStatus', 'getAvailability', 'getFare', 'getTimetable', 'getTrainInfo',
    'checkPNR', 'getBookings', 'getWallet', 'getCancelledTrains', 'lookupStation',
    'searchTrains', 'getRailwayKnowledge',
  ]);
  const distinctCaps = new Set(tools.filter((t) => informationalTools.has(t)));
  if (distinctCaps.size > 1) return 'MULTI_CAPABILITY_QUERY';

  // Contextual follow-up: a short pronoun/ordinal/class turn reusing the current
  // results selected for a known train.
  if (input.wasFollowUp && distinctCaps.size <= 1 && /(uska|uski|isme|usme|doosri|pehli|last|wali|wala|kitni|kitna)/.test(message)) {
    return 'CONTEXTUAL_RAILWAY_QUERY';
  }

  switch (intent) {
    case 'NORMAL_CHAT':
    case 'HELP':
    case 'UNKNOWN':
      return 'NORMAL_CHAT';
    case 'GENERAL_RAILWAY_QUERY':
      return 'GENERAL_RAILWAY_KNOWLEDGE';
    case 'COMPARE_TRAINS':
      return 'TRAIN_COMPARISON';
    case 'BOOK_TRAIN':
    case 'SEARCH_TRAIN':
      return 'TRAIN_SEARCH';
    case 'GET_CANCELLED_TRAINS': // calculation-ish, but provider-backed live data
      return 'LIVE_RAILWAY_DATA';
    case 'GET_AVAILABILITY':
    case 'GET_FARE':
    case 'GET_TIMETABLE':
    case 'GET_TRAIN_INFO':
    case 'LIVE_TRAIN_STATUS':
    case 'CHECK_PNR':
    case 'VIEW_BOOKINGS':
    case 'VIEW_WALLET':
    case 'LOOKUP_STATION':
      return 'LIVE_RAILWAY_DATA';
    default:
      return 'NORMAL_CHAT';
  }
}

// ── day-part buckets (time-of-day filtering) ─────────────────────────────────
export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/** Central, single definition of the day-time buckets. */
export const DAY_PART_BOUNDARIES: Record<DayPart, { start: number; end: number }> = {
  // 00:00–11:59 — the hours AFTER midnight (00:00–04:59) are EARLY MORNING and
  // belong to 'morning', NOT night. A 4:55am Shatabdi is a morning train, not a
  // "raat" train.
  morning: { start: 0, end: 11 }, // 00:00–11:59
  afternoon: { start: 12, end: 16 }, // 12:00–16:59
  evening: { start: 17, end: 20 }, // 17:00–20:59
  night: { start: 21, end: 23 }, // 21:00–23:59
};

export function dayPartOfHour(hour: number): DayPart {
  if (hour >= 0 && hour < 12) return 'morning'; // 00:00–11:59 (early-morning after midnight included)
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night'; // 21:00–23:59 only
}

export function dayPartLabel(part: DayPart): string {
  switch (part) {
    case 'morning': return 'subah';
    case 'afternoon': return 'dopahar';
    case 'evening': return 'shaam';
    case 'night': return 'raat';
  }
}

/** Parse a "subah/dopahar/shaam/raat/morning/afternoon/evening/night" phrase. */
export function parseDayPart(message: string): DayPart | null {
  const lower = message.toLowerCase();
  if (/\b(subah|subha|morning|savere|early morning)\b/.test(lower) || /(सुबह|सवेरे|प्रातः|प्रभात)/.test(lower)) return 'morning';
  if (/\b(dopahar|dophar|afternoon|midday|dopahr)\b/.test(lower) || /(दोपहर|दपहर)/.test(lower)) return 'afternoon';
  if (/\b(shaam|sham|evening|raat|night|late night|sandhya)\b/.test(lower) || /(शाम|संध्या|रात)/.test(lower)) {
    if (/\b(raat|night)\b/.test(lower) && !/\b(shaam|evening)\b/.test(lower)) return 'night';
    if (/(रात)/.test(lower) && !/(शाम|संध्या)/.test(lower)) return 'night';
    return 'evening';
  }
  return null;
}

/** "Subah wali" / "morning" (shorthand) also resolves to a day part. */
function dayPartHintIn(message: string): DayPart | null {
  const part = parseDayPart(message);
  if (part) return part;
  if (/\b(morning|subah|savere)\b/i.test(message) || /(सुबह|सवेरे)/.test(message)) return 'morning';
  if (/\b(afternoon|dopahar)\b/i.test(message) || /दोपहर/.test(message)) return 'afternoon';
  if (/\b(evening|shaam)\b/i.test(message) || /(शाम|संध्या)/.test(message)) return 'evening';
  if (/\b(night|raat)\b/i.test(message) || /रात/.test(message)) return 'night';
  return null;
}

/** Filter verified search results to those departing in the given day part. */
export function filterByDayPart<T extends { departureTime?: string | null }>(
  results: readonly T[],
  part: DayPart,
): T[] {
  return results.filter((entry) => {
    const minutes = clockToMinutes(entry.departureTime ?? null);
    if (minutes === null) return false; // unknown departure → cannot bucket it
    return dayPartOfHour(Math.floor(minutes / 60)) === part;
  });
}

// ── explicit time-window parsing + search-filter hints ───────────────────────

/** Parse an explicit clock window like "4am se 6am", "04:00 se 06:00", "4 se 6 baje". */
export function parseTimeWindow(message: string): { fromMin: number; toMin: number } | null {
  const norm = message.toLowerCase().replace(/(\d)\s*(am|pm)\b/g, (_, d, ap) => `${d}${ap}`).replace(/\s+/g, ' ');
  // "4am se 6am" / "4am to 6am" / "04:00 se 06:00" / "4 se 6 baje" — capture two clock-ish tokens.
  const two = norm.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:se|to|-|tak|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:baje|bje|ke beech|ke bich)?/);
  if (!two) return null;
  const toMinutes = (h: number, m: number, ap?: string): number | null => {
    let hour = h;
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || m < 0 || m > 59) return null;
    return hour * 60 + m;
  };
  const from = toMinutes(Number(two[1]), Number(two[2] ?? 0), two[3]);
  const to = toMinutes(Number(two[4]), Number(two[5] ?? 0), two[6]);
  if (from === null || to === null) return null;
  // A window that wraps midnight ("10pm se 2am") — normalise by adding 24h to `to`.
  const fromNorm = from;
  const toNorm = to <= from && to > 0 ? to + 24 * 60 : to;
  if (toNorm === fromNorm) return null;
  return { fromMin: fromNorm, toMin: toNorm };
}

/**
 * Extract a single time-of-day filter hint from the user's words. Named day-parts
 * (morning/subah/…) take precedence; otherwise an explicit "X se Y" clock window.
 */
export function extractSearchFilterHint(message: string): SearchFilterHint | null {
  // An explicit clock window is more specific than a day-part word, so when BOTH
  // appear (\"morning 4am se 6am\") the window wins.
  const window = parseTimeWindow(message);
  if (window) return { source: message, kind: 'timeWindow', fromMin: window.fromMin, toMin: window.toMin };
  const part = parseDayPart(message) ?? dayPartHintIn(message);
  if (part) return { source: message, kind: 'dayPart', dayPart: part };
  return null;
}

/** Does the message carry any time-of-day / clock-window filter? */
export function hasSearchFilterHint(message: string): boolean {
  return extractSearchFilterHint(message) !== null;
}

/** Does the message use ANY time-of-day language at all (word or clock)? */
export function hasAnyTimeSignal(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b(subah|subha|morning|savere|dopahar|dophar|afternoon|midday|shaam|sham|evening|raat|night|sandhya)\b/.test(lower) ||
    /(सुबह|सवेरे|दोपहर|शाम|संध्या|रात)/.test(lower) ||
    /\b\d{1,2}\s*(am|pm|baje|bje|bajay)\b/.test(lower) ||
    /\b\d{1,2}:\d{2}\b/.test(lower)
  );
}

/**
 * Reconcile the AI's filter reading with the user's LITERAL words.
 *
 * The AI is encouraged to interpret the time-of-day phrase itself, but it may
 * never invent a filter the user didn't ask for. So:
 *   - the deterministic read (extractSearchFilterHint) is authoritative whenever
 *     it fires — it is guaranteed to come from the user's own words;
 *   - an AI-ONLY hint is accepted only when the message clearly used time-of-day
 *     language that the deterministic pattern missed (a regex gap), so the AI is
 *     genuinely the one who understood it, not a fiction.
 *
 * This keeps the user-visible "the AI understood the filter" behaviour while the
 * actual filtering still runs through applySearchFilter (deterministic).
 */
export function reconcileSearchFilter(message: string, aiHint: SearchFilterHint | null): SearchFilterHint | null {
  const detHint = extractSearchFilterHint(message);
  if (detHint) return detHint;
  if (aiHint && hasAnyTimeSignal(message)) return aiHint;
  return null;
}

/**
 * A short, clearly-worded acknowledgment the assistant shows when it applies a
 * time-of-day filter — makes the AI's understanding VISIBLE in the reply rather
 * than silently truncating the list. Honest when the bucket came up empty.
 */
export function searchFilterAck(hint: SearchFilterHint, filtered: readonly TrainSearchResult[]): string {
  const label = hint.kind === 'dayPart' && hint.dayPart
    ? `${dayPartLabel(hint.dayPart)} (${dayPartWindowLabel(hint.dayPart)})`
    : hint.fromMin !== undefined && hint.toMin !== undefined
      ? `${formatClock(hint.fromMin)}–${formatClock(hint.toMin)}`
      : 'is time window';
  if (filtered.length === 0) {
    return `Samajh gaya — aapko ${label} wali trains chahiye thi. Is route par ${label} ki koi verified train nahi mili, isliye pura list upar dikha raha hoon.`;
  }
  const firstFew = filtered
    .slice(0, 4)
    .map((entry) => `${entry.train.number}${entry.departureTime ? ` (${entry.departureTime})` : ''}`)
    .join(', ');
  return `Samajh gaya — aapko ${label} wali chahiye thi. ${filtered.length} trains ${label} mein mili: ${firstFew}${filtered.length > 4 ? ` +${filtered.length - 4}` : ''} — dikha raha hoon.`;
}

/** Filter verified search results to those departing within the given hint. */
export function applySearchFilter<T extends { departureTime?: string | null }>(results: readonly T[], hint: SearchFilterHint): T[] {
  if (hint.kind === 'dayPart' && hint.dayPart) return filterByDayPart(results, hint.dayPart);
  if (hint.kind === 'timeWindow' && hint.fromMin !== undefined && hint.toMin !== undefined) {
    return results.filter((entry) => {
      const minutes = clockToMinutes(entry.departureTime ?? null);
      if (minutes === null) return false;
      return minutes >= hint.fromMin! && minutes < hint.toMin!;
    });
  }
  return [...results];
}

/** Human Hinglish line describing a filtered sub-list (honest when empty). */
export function searchFilterNote(hint: SearchFilterHint, filtered: readonly TrainSearchResult[], total: number): string {
  const label = hint.kind === 'dayPart' && hint.dayPart
    ? `${dayPartLabel(hint.dayPart)} (${dayPartWindowLabel(hint.dayPart)})`
    : hint.fromMin !== undefined && hint.toMin !== undefined
      ? `${formatClock(hint.fromMin)}–${formatClock(hint.toMin)}`
      : 'is time window';
  if (filtered.length === 0) {
    return `(${label} ki koi verified train is list mein nahi mili — pura ${total > 0 ? `${total}-train` : ''} list upar hai.)`;
  }
  const list = filtered
    .slice(0, 4)
    .map((entry) => `${entry.train.number} (${entry.departureTime ?? '?'})`)
    .join(', ');
  return `(${label} ki trains: ${list}${filtered.length > 4 ? ` +${filtered.length - 4}` : ''} — current results se.)`;
}

/** Human label for the day-part's clock span (for honest phrasing). */
function dayPartWindowLabel(part: DayPart): string {
  const b = DAY_PART_BOUNDARIES[part];
  return `${String(b.start).padStart(2, '0')}:00–${b.end <= 24 ? `${String(b.end).padStart(2, '0')}:00` : '00:00'}`;
}

// ── time + duration helpers ──────────────────────────────────────────────────

export function clockToMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const [hRaw, mRaw] = String(time).split(':');
  const h = Number(hRaw);
  const m = Number(mRaw ?? 0);
  return Number.isFinite(h) && Number.isFinite(m) && hRaw !== undefined ? h * 60 + m : null;
}

export function formatDuration(minutes: number): string {
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${h}h ${m}m`;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── comparison metrics ───────────────────────────────────────────────────────

export type ComparisonMetric = 'duration' | 'arrival' | 'departure';
export type ComparisonDirection = 'min' | 'max';

export interface ComparisonRequest {
  metric: ComparisonMetric;
  direction: ComparisonDirection;
  /** Human label for the reply, e.g. "sabse tez / shortest". */
  label: string;
}

/** Deterministic, canonical metric detection from natural language. */
export function detectComparisonRequest(message: string): ComparisonRequest | null {
  const lower = message.toLowerCase();
  if (/longest|sabse zyada (samay|time|der)|zyada ?time lagat|sabse dheere|dheere chalti|slowest/.test(lower)) {
    return { metric: 'duration', direction: 'max', label: 'longest journey (sabse lambi)' };
  }
  if (/latest\s+departure|sabse late nikal/.test(lower)) {
    return { metric: 'departure', direction: 'max', label: 'latest departure (sabse late nikalti)' };
  }
  if (/latest\s+arrival|sabse late pahunch/.test(lower)) {
    return { metric: 'arrival', direction: 'max', label: 'latest arrival (sabse late pahunchti)' };
  }
  if (/jaldi[\w\s]{0,20}pahunch|pahunch[\w\s]{0,20}jaldi|pehle[\w\s]{0,20}pahunch|earliest arrival|sabse jaldi (pahunch|delhi|destination)/.test(lower)) {
    return { metric: 'arrival', direction: 'min', label: 'earliest arrival (sabse pehle pahunchti)' };
  }
  if (/pehle\s+\w+\s+(nikal|chalu)|earliest departure|sabse pehle nikal|sabse pehle (nikalti|chalti)/.test(lower)) {
    return { metric: 'departure', direction: 'min', label: 'earliest departure (sabse pehle nikalti)' };
  }
  if (/fastest|sabse tez|sabse fast|jaldi pahunchti|quickest|fast\b|kam time|less time|sabse less|shortest|sabse kam (samay|time|der)|tez|jaldi\b/.test(lower)) {
    return { metric: 'duration', direction: 'min', label: 'shortest journey (sabse kam samay)' };
  }
  return null;
}

/** Shorthand: is the message asking for some rank/"kaunsi ... tez/fast/pehle"? */
export function isComparisonQuery(message: string): boolean {
  return detectComparisonRequest(message) !== null;
}

// ── "best" is ambiguous unless a basis is explicit or context provides one ───

/**
 * "Best" alone is ambiguous. If the sentence gives an explicit basis (fastest /
 * earliest / shortest...) OR the conversation already has a clear preference,
 * it is actionable; otherwise we must ask a concise clarification.
 */
export function isBestAmbiguous(message: string, hasContextBasis: boolean): boolean {
  const lower = message.toLowerCase();
  const mentionsBest = /\bbest\b|\bbetter\b|\bbest option\b|kaunsi (better|best)|sabse badiya|\bbest option\b|kaunsi (better|best)|sabse badiya/.test(lower);
  if (!mentionsBest) return false;
  const hasExplicitBasis = /fastest|sabse tez|jaldi|pehle|earliest|shortest|longest|kam time|less time|fast\b|slow|dheere/.test(lower);
  return !hasExplicitBasis && !hasContextBasis;
}

// ── verified winner selection ────────────────────────────────────────────────

export interface BestChoice {
  number: string;
  name: string | null;
  /** The verified field value in canonical units (minutes for duration, clock-minute for arrival/departure). */
  value: number;
  metric: ComparisonMetric;
  direction: ComparisonDirection;
  label: string;
}

function valueOf(entry: TrainSearchResult, metric: ComparisonMetric): number | null {
  if (metric === 'duration') return entry.durationMinutes;
  if (metric === 'arrival') return clockToMinutes(entry.arrivalTime);
  return clockToMinutes(entry.departureTime);
}

/**
 * Pick the best train across a verified list by a metric. Returns null when the
 * list is empty, or when the winner's required verified field is missing, or the
 * winning value cannot be resolved for EVERY candidate we must rank against
 * (never estimate over an incomplete set).
 */
export function pickBestByMetric(
  results: readonly TrainSearchResult[],
  request: ComparisonRequest,
): BestChoice | null {
  if (results.length === 0) return null;
  const ranked = results
    .map((entry) => ({ entry, value: valueOf(entry, request.metric) }))
    .filter((item): item is { entry: TrainSearchResult; value: number } => item.value !== null);
  // To say "X is the fastest" we must rank at least two verified values, else the
  // claim is not a comparison. (A single verified train is a fact, not a winner.)
  if (ranked.length < 2) return null;
  const best = ranked.reduce((acc, item) =>
    request.direction === 'max' ? (item.value > acc.value ? item : acc) : item.value < acc.value ? item : acc,
  );
  return {
    number: best.entry.train.number,
    name: best.entry.train.name,
    value: best.value,
    metric: request.metric,
    direction: request.direction,
    label: request.label,
  };
}

// ── duration difference between two verified trains ──────────────────────────

export interface DurationDifference {
  aNumber: string;
  bNumber: string;
  minutes: number;
  /** true => b is the longer journey; false => a is the longer journey. */
  bLonger: boolean;
}

export function durationDifferenceBetween(a: TrainSearchResult, b: TrainSearchResult): DurationDifference | null {
  if (a.train.number === b.train.number) return null; // same train → not a difference
  if (a.durationMinutes === null || b.durationMinutes === null) return null;
  const diff = Math.abs(a.durationMinutes - b.durationMinutes);
  return {
    aNumber: a.train.number,
    bNumber: b.train.number,
    minutes: diff,
    bLonger: b.durationMinutes > a.durationMinutes,
  };
}

// ── human Hinglish note for the search / answer path ─────────────────────────

function travelLabel(number: string, name: string | null): string {
  return name ? `${number} — ${name}` : number;
}

/** A short deterministic Hinglish note describing the best train in a list. */
export function bestChoiceNote(choice: BestChoice): string {
  const label = choice.label;
  if (choice.metric === 'duration') {
    return `(${travelLabel(choice.number, choice.name)} · ${label}: ${formatDuration(choice.value)} — current results se.)`;
  }
  return `(${travelLabel(choice.number, choice.name)} · ${label}: ${formatClock(choice.value)} — current results se.)`;
}

/** Build the intelligence note for a fresh search (fastest / earliest / day part). */
export function summarizeSearchIntelligence(
  results: readonly TrainSearchResult[],
  message: string,
  hasContextBasis: boolean,
): string | null {
  // Day-part filtering takes precedence when a bucket is named.
  const dayPart = dayPartHintIn(message);
  if (dayPart) {
    const filtered = filterByDayPart(results, dayPart);
    if (filtered.length === 0) {
      return `(${dayPartLabel(dayPart)} ki koi verified train is list mein nahi mili — pura list upar hai.)`;
    }
    const list = filtered
      .slice(0, 4)
      .map((entry) => `${entry.train.number} (${entry.departureTime ?? '?'})`)
      .join(', ');
    return `(${dayPartLabel(dayPart)} wali trains: ${list}${filtered.length > 4 ? ` +${filtered.length - 4}` : ''} — current results se.)`;
  }
  const request = detectComparisonRequest(message);
  if (!request) return null;
  const best = pickBestByMetric(results, request);
  if (!best) return null;
  if (request.metric === 'duration' && request.direction === 'min') {
    return `Sabse tez: ${best.number}${best.name ? ` — ${best.name}` : ''}, duration ${formatDuration(best.value)}.`;
  }
  const label = request.label;
  const shown = request.metric === 'duration' ? formatDuration(best.value) : formatClock(best.value);
  return `${label} (current results se): ${best.number}, ${shown}.`;
}
