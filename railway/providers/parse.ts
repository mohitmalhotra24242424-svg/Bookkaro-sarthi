/**
 * Defensive payload parsing shared by provider adapters.
 * Every accessor is total: wrong/missing types become null — never throws,
 * never coerces, never invents values.
 */

import type { TravelClassCode, WeekdayCode } from '../../shared/index.js';
import { TRAVEL_CLASSES } from '../../shared/index.js';

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asInteger(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function pickRecord(source: UnknownRecord, ...keys: string[]): UnknownRecord | null {
  for (const key of keys) {
    const record = asRecord(source[key]);
    if (record) return record;
  }
  return null;
}

export function pickArray(source: UnknownRecord, ...keys: string[]): unknown[] | null {
  for (const key of keys) {
    const array = asArray(source[key]);
    if (array) return array;
  }
  return null;
}

export function pickString(source: UnknownRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const text = asString(source[key]);
    if (text) return text;
  }
  return null;
}

export function pickNumber(source: UnknownRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = asNumber(source[key]);
    if (number !== null) return number;
  }
  return null;
}

export function pickInteger(source: UnknownRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = asInteger(source[key]);
    if (number !== null) return number;
  }
  return null;
}

export function pickBoolean(source: UnknownRecord, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const boolean = asBoolean(source[key]);
    if (boolean !== null) return boolean;
  }
  return null;
}

/** Times may arrive as "HH:mm" strings or {scheduled, actual} objects — extract the string. */
export function pickTime(source: UnknownRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    const direct = asString(value);
    if (direct) return direct;
    const container = asRecord(value);
    if (container) {
      const inner = pickString(container, 'scheduled', 'actual', 'time', 'eta', 'etd');
      if (inner) return inner;
    }
  }
  return null;
}

export function normalizeWeekdays(value: unknown): WeekdayCode[] | null {
  const array = asArray(value);
  if (!array) return null;
  const days = array
    .map((entry) => (typeof entry === 'string' ? entry.trim().toUpperCase().slice(0, 3) : ''))
    .filter((entry): entry is WeekdayCode => ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(entry));
  return days.length > 0 ? days : null;
}

export function normalizeTravelClasses(value: unknown): TravelClassCode[] | null {
  const array = asArray(value);
  if (!array) return null;
  const classes = array
    .map((entry) => (typeof entry === 'string' ? entry.trim().toUpperCase() : ''))
    .filter((entry): entry is TravelClassCode => (TRAVEL_CLASSES as readonly string[]).includes(entry));
  return classes.length > 0 ? classes : null;
}

/** Providers publish fares in whole INR (verified docs) — convert to integer paise (minor units). */
export function rupeesToMinor(value: unknown): number | null {
  const number = asNumber(value);
  if (number === null || number < 0) return null;
  return Math.round(number * 100);
}

/** Envelope-aware payload extraction: {success:true, data} → data; bare payload → itself. */
export function unwrapEnvelope(body: unknown): unknown {
  const record = asRecord(body);
  if (record && record.success === true && 'data' in record) {
    return record.data;
  }
  return body;
}
