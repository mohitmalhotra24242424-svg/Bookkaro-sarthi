/**
 * AI TOOL CATALOG (Step 6 §2) — the ONLY tools the AI may select.
 *
 * Catalog ids are the spec's UPPER_SNAKE names; each maps to a Step-1 registry
 * tool. PROHIBITED tools (CONFIRM_BOOKING / PAYMENT / WALLET_DEBIT) are listed
 * explicitly so any AI request for them is rejected by name, not by accident.
 *
 * The catalog contains NO URLs, NO HTTP methods, NO credentials — the AI can
 * only pick a logical capability; the server-side executor + ProviderRouter do
 * the rest.
 */

import type { ToolName } from '../../shared/index.js';

export type CatalogPermission = 'READ' | 'BOOKING_FLOW' | 'CONFIRMATION_GATED' | 'PROHIBITED';

export interface CatalogTool {
  id: string;
  registryTool: ToolName | null; // null → no executable registry tool (handled by the booking flow)
  permission: CatalogPermission;
  summary: string;
  /** Argument spec — validated before ANY execution. */
  args: readonly {
    name: string;
    kind: 'trainNumber' | 'pnr' | 'date' | 'class' | 'quota' | 'stationCode' | 'passengerCount' | 'string';
    required: boolean;
  }[];
}

export const AI_TOOL_CATALOG: readonly CatalogTool[] = [
  { id: 'SEARCH_TRAINS', registryTool: 'searchTrains', permission: 'READ', summary: 'Search trains between stations on a date',
    args: [{ name: 'originCode', kind: 'stationCode', required: true }, { name: 'destinationCode', kind: 'stationCode', required: true }, { name: 'journeyDate', kind: 'date', required: true }, { name: 'passengerCount', kind: 'passengerCount', required: false }] },
  { id: 'LOOKUP_STATION', registryTool: 'lookupStation', permission: 'READ', summary: 'Resolve a station name to its code',
    args: [{ name: 'query', kind: 'string', required: true }, { name: 'domain', kind: 'string', required: false }] },
  { id: 'GET_TRAIN_INFO', registryTool: 'getTrainInfo', permission: 'READ', summary: 'Train identity, route endpoints, running days',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true }] },
  { id: 'GET_TIMETABLE', registryTool: 'getTimetable', permission: 'READ', summary: 'Scheduled stops and timings',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true }] },
  { id: 'GET_LIVE_STATUS', registryTool: 'getLiveStatus', permission: 'READ', summary: 'Live running status, delay, current/next station',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true }, { name: 'journeyDate', kind: 'date', required: false }] },
  { id: 'GET_AVAILABILITY', registryTool: 'getAvailability', permission: 'READ', summary: 'Seat availability for train+class+segment+date',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true }, { name: 'journeyDate', kind: 'date', required: true }, { name: 'travelClass', kind: 'class', required: true }, { name: 'fromStationCode', kind: 'stationCode', required: false }, { name: 'toStationCode', kind: 'stationCode', required: false }, { name: 'quota', kind: 'quota', required: false }] },
  { id: 'GET_FARE', registryTool: 'getFare', permission: 'READ', summary: 'Provider fare quote (railway fare only — service fee added by the app)',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true }, { name: 'fromStationCode', kind: 'stationCode', required: false }, { name: 'toStationCode', kind: 'stationCode', required: false }, { name: 'journeyDate', kind: 'date', required: false }, { name: 'travelClass', kind: 'class', required: false }, { name: 'quota', kind: 'quota', required: false }] },
  { id: 'GET_PNR', registryTool: 'checkPNR', permission: 'READ', summary: 'PNR status (RailKit capability)',
    args: [{ name: 'pnr', kind: 'pnr', required: true }] },
  { id: 'GET_CANCELLED_TRAINS', registryTool: 'getCancelledTrains', permission: 'READ', summary: 'Cancelled trains list (RailKit capability)',
    args: [{ name: 'journeyDate', kind: 'date', required: true }] },
  { id: 'GET_BOOKING_HISTORY', registryTool: 'getBookings', permission: 'READ', summary: "User's booking history (application records)",
    args: [] },
  { id: 'GET_WALLET', registryTool: 'getWallet', permission: 'READ', summary: 'Wallet balance (application backend only)',
    args: [] },
  { id: 'RAILWAY_KNOWLEDGE', registryTool: 'getRailwayKnowledge', permission: 'READ', summary: 'General railway concepts (glossary + allowlisted official web only)',
    args: [{ name: 'query', kind: 'string', required: true }, { name: 'domain', kind: 'string', required: false }] },
  { id: 'COMPARE_TRAINS', registryTool: null, permission: 'READ', summary: 'Compare trains from the CURRENT search results (no provider call)',
    args: [{ name: 'firstTrainNumber', kind: 'trainNumber', required: false }, { name: 'secondTrainNumber', kind: 'trainNumber', required: false }] },
  { id: 'CREATE_BOOKING_DRAFT', registryTool: 'createBookingDraft', permission: 'BOOKING_FLOW', summary: 'Create a data-only booking draft (no money, no booking)',
    args: [{ name: 'originCode', kind: 'stationCode', required: true }, { name: 'destinationCode', kind: 'stationCode', required: true }, { name: 'journeyDate', kind: 'date', required: true }, { name: 'trainNumber', kind: 'trainNumber', required: true }, { name: 'travelClass', kind: 'class', required: true }, { name: 'passengerCount', kind: 'passengerCount', required: true }] },
  { id: 'FARE_REVIEW', registryTool: null, permission: 'BOOKING_FLOW', summary: 'Present the full fare review (railway fare + service fee + total)',
    args: [] },
  { id: 'REQUEST_BOOKING_CONFIRMATION', registryTool: null, permission: 'CONFIRMATION_GATED', summary: 'Ask the user for explicit confirmation — valid ONLY after a presented review',
    args: [] },
  // ── explicitly PROHIBITED for the AI (deterministic server-side only) ──
  { id: 'CONFIRM_BOOKING', registryTool: 'confirmBooking', permission: 'PROHIBITED', summary: 'Final booking execution — AI may NEVER select this',
    args: [] },
  { id: 'PAYMENT', registryTool: null, permission: 'PROHIBITED', summary: 'Payment operations — deterministic server-side only',
    args: [] },
  { id: 'WALLET_DEBIT', registryTool: null, permission: 'PROHIBITED', summary: 'Wallet money movement — deterministic server-side only',
    args: [] },
];

const BY_ID = new Map(AI_TOOL_CATALOG.map((tool) => [tool.id, tool]));

export function getCatalogTool(id: string): CatalogTool | null {
  return BY_ID.get(id) ?? null;
}

export function aiSelectableToolIds(): string[] {
  return AI_TOOL_CATALOG.filter((tool) => tool.permission !== 'PROHIBITED').map((tool) => tool.id);
}

export function isAiSelectableTool(id: string): boolean {
  const tool = getCatalogTool(id);
  return tool !== null && tool.permission !== 'PROHIBITED';
}

/** Map a registry tool name back to its catalog id (for reporting). */
export function catalogIdForRegistryTool(registryTool: string): string | null {
  return AI_TOOL_CATALOG.find((tool) => tool.registryTool === registryTool)?.id ?? null;
}

// ── argument validation (§6) ─────────────────────────────────────────────────

const FORBIDDEN_ARG_KEYS = new Set(['url', 'uri', 'endpoint', 'method', 'apiKey', 'api_key', 'token', 'authorization', 'provider', 'baseUrl', 'host']);

export interface ToolArgumentValidation {
  ok: boolean;
  errors: string[];
  sanitized: Record<string, unknown>;
}

const TRAIN_NUMBER = /^\d{4,6}$/;
const PNR = /^\d{10}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATION_CODE = /^[A-Za-z0-9]{2,10}$/;
const CLASSES = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'SL', '2S'];
const QUOTAS = ['GN', 'TQ', 'PT', 'LD', 'SS', 'DP', 'HP'];

function validateValue(kind: CatalogTool['args'][number]['kind'], name: string, value: unknown, errors: string[]): unknown | undefined {
  switch (kind) {
    case 'trainNumber':
      if (typeof value !== 'string' || !TRAIN_NUMBER.test(value)) { errors.push(`${name}: invalid train number (4–6 digits expected)`); return undefined; }
      return value;
    case 'pnr':
      if (typeof value !== 'string' || !PNR.test(value)) { errors.push(`${name}: invalid PNR (10 digits expected)`); return undefined; }
      return value;
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) { errors.push(`${name}: invalid date (YYYY-MM-DD expected)`); return undefined; }
      return value;
    case 'class': {
      const upper = typeof value === 'string' ? value.toUpperCase() : '';
      if (!CLASSES.includes(upper)) { errors.push(`${name}: unknown travel class`); return undefined; }
      return upper;
    }
    case 'quota': {
      const upper = typeof value === 'string' ? value.toUpperCase() : '';
      if (!QUOTAS.includes(upper)) { errors.push(`${name}: unknown quota`); return undefined; }
      return upper;
    }
    case 'stationCode': {
      if (typeof value !== 'string' || !STATION_CODE.test(value)) { errors.push(`${name}: invalid station code`); return undefined; }
      return value.toUpperCase();
    }
    case 'passengerCount':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) { errors.push(`${name}: passenger count must be 1–6`); return undefined; }
      return value;
    case 'string': {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 80) { errors.push(`${name}: invalid string`); return undefined; }
      if (/https?:\/\//i.test(value)) { errors.push(`${name}: URLs are not allowed`); return undefined; }
      return value.trim();
    }
  }
}

/**
 * Validates tool arguments against the catalog spec. Unknown keys and any
 * URL/method/credential-shaped keys are rejected — the AI can never smuggle an
 * endpoint, a provider choice or a key into an execution.
 */
export function validateToolArguments(id: string, args: Record<string, unknown> | undefined | null): ToolArgumentValidation {
  const tool = getCatalogTool(id);
  if (!tool) return { ok: false, errors: [`unknown tool "${id}"`], sanitized: {} };
  const errors: string[] = [];
  const sanitized: Record<string, unknown> = {};

  const input = args !== null && typeof args === 'object' ? args : {};
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_ARG_KEYS.has(key)) {
      errors.push(`argument "${key}" is forbidden (AI cannot choose endpoints, methods or credentials)`);
    }
  }
  for (const spec of tool.args) {
    const value = input[spec.name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) errors.push(`${spec.name}: required`);
      continue;
    }
    const validated = validateValue(spec.kind, spec.name, value, errors);
    if (validated !== undefined) sanitized[spec.name] = validated;
  }
  return { ok: errors.length === 0, errors, sanitized };
}
