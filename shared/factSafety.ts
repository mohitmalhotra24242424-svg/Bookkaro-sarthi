/**
 * FACT SAFETY.
 *
 * Railway facts must come from verified provider data or an approved railway
 * knowledge base. `RailwayFact` is the honest tri-state every consumer of
 * railway information works with: VERIFIED (has provenance), UNAVAILABLE, or
 * UNKNOWN. Missing data is NEVER fabricated.
 */

import { SafetyViolationError } from './errors.js';
import type { ProviderId } from './types/railway.js';

export const RAILWAY_FACT_SAFETY_RULES: readonly string[] = [
  'Railway facts must originate from a verified provider response or an approved knowledge base.',
  'Never invent train numbers, station codes, timings, fares, availability, live location, delay, PNR or cancellation info.',
  'Unavailable or unknown data must be reported honestly as UNAVAILABLE / UNKNOWN (or null fields).',
  'A VERIFIED fact must always carry its provider source and retrieval timestamp.',
  'Fares are only ever shown from a verified provider quote.',
  'The AI layer may shape wording but may never add railway facts that tools did not return.',
  'Zero results is a legitimate answer ("no trains found"), not an error and not a reason to invent data.',
];

export type RailwayFact<T> =
  | { status: 'VERIFIED'; source: ProviderId; retrievedAt: string; data: T }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'UNKNOWN'; reason: string };

export function verifiedFact<T>(
  data: T,
  source: ProviderId,
  retrievedAt: string = new Date().toISOString(),
): RailwayFact<T> {
  return { status: 'VERIFIED', source, retrievedAt, data };
}

export function unavailableFact<T>(reason: string): RailwayFact<T> {
  return { status: 'UNAVAILABLE', reason };
}

export function unknownFact<T>(reason = 'Railway information is unknown.'): RailwayFact<T> {
  return { status: 'UNKNOWN', reason };
}

export function isVerifiedFact<T>(fact: RailwayFact<T>): fact is Extract<RailwayFact<T>, { status: 'VERIFIED' }> {
  return fact.status === 'VERIFIED';
}

/** Runtime guard: a VERIFIED fact with null/undefined data is a fabrication bug — fail loudly. */
export function assertFactNeverFabricated<T>(fact: RailwayFact<T>): void {
  if (fact.status === 'VERIFIED') {
    if (fact.data === null || fact.data === undefined) {
      throw new SafetyViolationError(
        `FABRICATED_FACT: VERIFIED fact from ${fact.source} carries no data. This is a bug.`,
      );
    }
  }
}
