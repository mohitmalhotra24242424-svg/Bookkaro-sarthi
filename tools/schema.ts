/**
 * Deterministic tool INPUT validation.
 *
 * This is the hard boundary between "AI requested a tool" and "server executes
 * a tool": unknown fields are rejected, types are checked, formats (train
 * number, PNR, date, station code) are enforced, and no string value may ever
 * contain a URL — the AI cannot smuggle endpoints or code into a tool call.
 */

import {
  QUOTAS,
  TRAVEL_CLASSES,
  containsUrl,
  isValidIsoDate,
  isValidPnr,
  isValidStationCode,
  isValidTrainNumber,
} from '../shared/index.js';
import type { ToolFieldSpec } from '../shared/index.js';

export interface InputValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_LIST_ITEMS = 5;

export function validateToolInput(
  fields: readonly ToolFieldSpec[],
  input: unknown,
): InputValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['tool input must be a JSON object'] };
  }

  const errors: string[] = [];
  const entries = Object.entries(input as Record<string, unknown>);
  const knownNames = new Set(fields.map((field) => field.name));

  for (const [key, value] of entries) {
    const spec = fields.find((field) => field.name === key);
    if (!spec) {
      errors.push(`unknown field "${key}" — allowed: ${[...knownNames].join(', ') || '(none)'}`);
      continue;
    }
    if (value === null || value === undefined) {
      if (spec.required) errors.push(`field "${key}" is required`);
      continue;
    }
    errors.push(...validateValue(key, spec, value));
  }

  for (const spec of fields) {
    if (spec.required && !entries.some(([key, value]) => key === spec.name && value !== null && value !== undefined)) {
      errors.push(`missing required field "${spec.name}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function typeError(name: string, expected: string): string {
  return `field "${name}" must be ${expected}`;
}

function validateValue(name: string, spec: ToolFieldSpec, value: unknown): string[] {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return [typeError(name, 'a string')];
      if (containsUrl(value)) return [`field "${name}" must not contain URLs`];
      const min = spec.min ?? 1;
      if (value.trim().length < min) return [`field "${name}" must be at least ${min} characters`];
      if (value.length > 200) return [`field "${name}" must be at most 200 characters`];
      return [];
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [typeError(name, 'a finite number')];
      if (!Number.isInteger(value)) return [`field "${name}" must be an integer`];
      if (spec.min !== undefined && value < spec.min) return [`field "${name}" must be >= ${spec.min}`];
      if (spec.max !== undefined && value > spec.max) return [`field "${name}" must be <= ${spec.max}`];
      return [];
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [typeError(name, 'a boolean')];
      return [];
    }
    case 'date': {
      if (typeof value !== 'string' || !isValidIsoDate(value)) {
        return [`field "${name}" must be a valid ISO date (YYYY-MM-DD)`];
      }
      return [];
    }
    case 'stationCode': {
      if (!isValidStationCode(value)) return [`field "${name}" must be a valid station code (2–10 letters/digits)`];
      return [];
    }
    case 'trainNumber': {
      if (!isValidTrainNumber(value)) return [`field "${name}" must be a valid train number (4–6 digits)`];
      return [];
    }
    case 'pnr': {
      if (!isValidPnr(value)) return [`field "${name}" must be a valid 10-digit PNR`];
      return [];
    }
    case 'travelClass': {
      if (typeof value !== 'string' || !TRAVEL_CLASSES.includes(value as never)) {
        return [`field "${name}" must be one of: ${TRAVEL_CLASSES.join(', ')}`];
      }
      return [];
    }
    case 'quota': {
      if (typeof value !== 'string' || !QUOTAS.includes(value as never)) {
        return [`field "${name}" must be one of: ${QUOTAS.join(', ')}`];
      }
      return [];
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.enumValues?.includes(value)) {
        return [`field "${name}" must be one of: ${(spec.enumValues ?? []).join(', ') || '(none)'}`];
      }
      return [];
    }
    case 'trainNumberList': {
      if (!Array.isArray(value)) return [typeError(name, 'an array of train numbers')];
      if (value.length < 2 || value.length > MAX_LIST_ITEMS) {
        return [`field "${name}" must contain 2–${MAX_LIST_ITEMS} train numbers`];
      }
      const bad = value.filter((item) => !isValidTrainNumber(item));
      if (bad.length > 0) return [`field "${name}" contains invalid train numbers: ${bad.join(', ')}`];
      return [];
    }
  }
}
