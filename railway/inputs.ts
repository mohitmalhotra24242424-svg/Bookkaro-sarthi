/**
 * Deterministic server-side validation of railway queries.
 * Runs BEFORE any provider is called (invalid user input must not trigger
 * fallback — it is a real answer, not a provider failure).
 */

import {
  QUOTAS,
  TRAVEL_CLASSES,
  containsUrl,
  isIsoDateInPast,
  isoDateOf,
  isValidIsoDate,
  isValidPnr,
  isValidStationCode,
  isValidTrainNumber,
} from '../shared/index.js';
import type { RailwayCapability } from '../shared/index.js';

export interface RailwayQueryValidation {
  ok: boolean;
  errors: string[];
}

function isTravelClass(value: unknown): boolean {
  return typeof value === 'string' && (TRAVEL_CLASSES as readonly string[]).includes(value);
}

function isQuota(value: unknown): boolean {
  return typeof value === 'string' && (QUOTAS as readonly string[]).includes(value);
}

export function validateRailwayQuery(
  capability: RailwayCapability,
  query: unknown,
  now: () => Date = () => new Date(),
): RailwayQueryValidation {
  const errors: string[] = [];
  const q = (query ?? {}) as Record<string, unknown>;

  const checkTrainNumber = (required: boolean): void => {
    if (q.trainNumber === null || q.trainNumber === undefined) {
      if (required) errors.push('trainNumber is required');
    } else if (!isValidTrainNumber(q.trainNumber)) {
      errors.push('trainNumber must be 4–6 digits');
    }
  };
  const checkDate = (name: string, required: boolean, allowPast: boolean): void => {
    const value = q[name];
    if (value === null || value === undefined) {
      if (required) errors.push(`${name} is required`);
      return;
    }
    if (typeof value !== 'string' || !isValidIsoDate(value)) {
      errors.push(`${name} must be a valid ISO date (YYYY-MM-DD)`);
      return;
    }
    if (!allowPast && isIsoDateInPast(value, isoDateOf(now()))) errors.push(`${name} must not be in the past`);
  };

  switch (capability) {
    case 'stationLookup': {
      const queryText = q.query;
      if (typeof queryText !== 'string' || queryText.trim().length < 2 || queryText.length > 40) {
        errors.push('query must be a 2–40 character station name');
      } else if (containsUrl(queryText)) {
        errors.push('query must not contain URLs');
      }
      break;
    }
    case 'trainSearch': {
      if (!isValidStationCode(q.originCode)) errors.push('originCode must be a valid station code');
      if (!isValidStationCode(q.destinationCode)) errors.push('destinationCode must be a valid station code');
      if (q.originCode && q.destinationCode && q.originCode === q.destinationCode) {
        errors.push('originCode and destinationCode must differ');
      }
      // Step 2: journey date is required — verified: RailCore /routes/trains requires `date`.
      checkDate('journeyDate', true, false);
      break;
    }
    case 'trainInfo':
    case 'timetable': {
      checkTrainNumber(true);
      break;
    }
    case 'liveStatus': {
      checkTrainNumber(true);
      checkDate('journeyDate', false, true);
      break;
    }
    case 'availability': {
      checkTrainNumber(true);
      checkDate('journeyDate', true, false);
      // Step 2: verified — RailCore /availability/seats and the RailKit SDK both require the segment + class.
      if (!isValidStationCode(q.fromStationCode)) errors.push('fromStationCode must be a valid station code');
      if (!isValidStationCode(q.toStationCode)) errors.push('toStationCode must be a valid station code');
      if (q.travelClass == null || !isTravelClass(q.travelClass)) errors.push('travelClass is required');
      if (q.quota != null && !isQuota(q.quota)) errors.push('quota is invalid');
      break;
    }
    case 'fare': {
      checkTrainNumber(true);
      if (q.fromStationCode != null && !isValidStationCode(q.fromStationCode)) errors.push('fromStationCode is invalid');
      if (q.toStationCode != null && !isValidStationCode(q.toStationCode)) errors.push('toStationCode is invalid');
      checkDate('journeyDate', false, false);
      if (q.travelClass != null && !isTravelClass(q.travelClass)) errors.push('travelClass is invalid');
      if (q.quota != null && !isQuota(q.quota)) errors.push('quota is invalid');
      break;
    }
    case 'pnr': {
      if (!isValidPnr(q.pnr)) errors.push('pnr must be a 10-digit number');
      break;
    }
    case 'cancelledTrains': {
      checkDate('journeyDate', true, false);
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}
