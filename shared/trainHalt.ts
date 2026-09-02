/**
 * Commercial-stop membership (include_intermediate=false schedule).
 * Passing through a city is NOT a halt. Unknown/empty schedule → null (do not guess).
 */

export function commercialHaltIndex(
  stops: readonly { stationCode?: string | null }[],
  code: string,
): number {
  const want = code.toUpperCase();
  return stops.findIndex((stop) => (stop.stationCode ?? '').toUpperCase() === want);
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
  const toIdx = commercialHaltIndex(stops, toCode);
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= toIdx) return false;
  return true;
}
