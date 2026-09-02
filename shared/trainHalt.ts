/**
 * Commercial-stop membership (include_intermediate=false schedule).
 * Passing through a city is NOT a halt. Unknown/empty schedule → null (do not guess).
 *
 * Some IR codes were renamed in place (same station, new code). Halt matching
 * must treat those as one station — otherwise BCT search misses MMCT trains
 * and RailCore's fuzzy "Mumbai" list (BDTS/CSMT) leaks through.
 */

/** Obsolete code → current commercial code. Same physical station only. */
export const STATION_CODE_CANON: Readonly<Record<string, string>> = {
  BCT: 'MMCT', // Mumbai Central
  CSTM: 'CSMT', // Chhatrapati Shivaji Maharaj Terminus
};

export function canonicalStationCode(code: string): string {
  const upper = code.toUpperCase();
  return STATION_CODE_CANON[upper] ?? upper;
}

export function stationCodesMatch(a: string, b: string): boolean {
  return canonicalStationCode(a) === canonicalStationCode(b);
}

export function commercialHaltIndex(
  stops: readonly { stationCode?: string | null }[],
  code: string,
): number {
  const want = canonicalStationCode(code);
  return stops.findIndex((stop) => canonicalStationCode(stop.stationCode ?? '') === want);
}

/**
 * true  = both stations are commercial stops, in this order
 * false = missing halt or wrong direction
 * null  = no schedule to judge (caller should not invent either way)
 */
export function trainServesCommercialSegment(
  stops: readonly { stationCode?: string | null }[] | null | undefined,
  fromCode: string,
  toCode: string,
): boolean | null {
  if (!stops || stops.length === 0) return null;
  const fromIdx = commercialHaltIndex(stops, fromCode);
  if (fromIdx < 0) return false;
  const wantTo = canonicalStationCode(toCode);
  const toIdx = stops.findIndex(
    (stop, index) => index > fromIdx && canonicalStationCode(stop.stationCode ?? '') === wantTo,
  );
  if (toIdx < 0) return false;
  return true;
}

/** Keep one row per physical station; prefer the current official code (MMCT over BCT). */
export function collapseEquivalentStations<T extends { code: string }>(stations: readonly T[]): T[] {
  const ranked = [...stations].sort((a, b) => {
    const aCanon = canonicalStationCode(a.code) === a.code.toUpperCase() ? 0 : 1;
    const bCanon = canonicalStationCode(b.code) === b.code.toUpperCase() ? 0 : 1;
    return aCanon - bCanon;
  });
  const out: T[] = [];
  const seen = new Set<string>();
  for (const station of ranked) {
    const canon = canonicalStationCode(station.code);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(station);
  }
  return out;
}
