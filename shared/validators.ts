/** Deterministic, dependency-free validators shared by tools, railway and api layers. */

export const TRAIN_NUMBER_PATTERN = /^\d{4,6}$/;
export const PNR_PATTERN = /^\d{10}$/;
export const STATION_CODE_PATTERN = /^[A-Z0-9]{2,10}$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const URL_PATTERN = /https?:\/\//i;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** AI-supplied strings must never contain URLs — the AI cannot fetch arbitrary endpoints. */
export function containsUrl(value: string): boolean {
  return URL_PATTERN.test(value);
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isoDateOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isIsoDateInPast(value: string, today: string = isoDateOf()): boolean {
  return isValidIsoDate(value) && value < today;
}

export function isValidTrainNumber(value: unknown): value is string {
  return typeof value === 'string' && TRAIN_NUMBER_PATTERN.test(value);
}

export function isValidPnr(value: unknown): value is string {
  return typeof value === 'string' && PNR_PATTERN.test(value);
}

export function isValidStationCode(value: unknown): value is string {
  return typeof value === 'string' && STATION_CODE_PATTERN.test(value.toUpperCase());
}

export function isSafeShortText(value: string, minLength = 1, maxLength = 200): boolean {
  return value.trim().length >= minLength && value.length <= maxLength;
}
