/**
 * TOOL DEFINITIONS — the extensible tool vocabulary.
 *
 * Every tool declares its name, input schema, output shape, who may request
 * it and its side effects. In Step 1 ALL tools are registered as
 * NOT_IMPLEMENTED: the registry can describe and validate them, but executing
 * any tool honestly reports "not implemented" instead of ever fabricating
 * railway data. Executors are attached in later steps.
 */

import { ValidationError } from '../shared/index.js';
import type { ToolDefinition, ToolFieldSpec, ToolFieldType, ToolName } from '../shared/index.js';

const field = (
  name: string,
  type: ToolFieldType,
  required: boolean,
  description: string,
  extra: Partial<ToolFieldSpec> = {},
): ToolFieldSpec => ({ name, type, required, description, ...extra });

const NOT_IMPLEMENTED_NOTE = 'NOT IMPLEMENTED in Step 1 — returns an honest unavailable result; never fabricates data.';

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'searchTrains',
    category: 'RAILWAY_DATA',
    summary: 'Search trains between two stations on a date.',
    description: 'Returns real train search results from the railway provider (via the provider router).',
    input: [
      field('originCode', 'stationCode', true, 'Origin station code, e.g. ASR'),
      field('destinationCode', 'stationCode', true, 'Destination station code, e.g. LDH'),
      field('journeyDate', 'date', false, 'Journey date (YYYY-MM-DD); omit for generic schedule'),
      field('passengerCount', 'number', false, 'Number of passengers (1–6)', { min: 1, max: 6 }),
    ],
    outputDescription: 'TrainSearchResult[] (empty list when no trains found — a legitimate answer)',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'lookupStation',
    category: 'RAILWAY_DATA',
    summary: 'Resolve a station name/query to station code(s).',
    description: 'Station lookup from provider data.',
    input: [field('query', 'string', true, 'Station name or partial name, e.g. "Ludhiana"', { min: 2 })],
    outputDescription: 'Station[]',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getTrainInfo',
    category: 'RAILWAY_DATA',
    summary: 'General information about one train.',
    description: 'Train info by train number.',
    input: [field('trainNumber', 'trainNumber', true, 'Train number, e.g. 12014')],
    outputDescription: 'Train',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getTimetable',
    category: 'RAILWAY_DATA',
    summary: 'Timetable / stop list of a train.',
    description: 'Ordered stops with times from provider data.',
    input: [field('trainNumber', 'trainNumber', true, 'Train number')],
    outputDescription: 'Timetable',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getLiveStatus',
    category: 'RAILWAY_DATA',
    summary: 'Live running status of a train.',
    description: 'Live position/delay strictly from provider data — never estimated by AI.',
    input: [
      field('trainNumber', 'trainNumber', true, 'Train number'),
      field('journeyDate', 'date', false, 'Journey date for the run (YYYY-MM-DD)'),
    ],
    outputDescription: 'LiveStatus',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getAvailability',
    category: 'RAILWAY_DATA',
    summary: 'Seat availability for a train/class/date.',
    description: 'Availability from provider data.',
    input: [
      field('trainNumber', 'trainNumber', true, 'Train number'),
      field('journeyDate', 'date', true, 'Journey date (YYYY-MM-DD)'),
      field('travelClass', 'travelClass', false, 'Travel class, e.g. SL/3A/CC'),
      field('quota', 'quota', false, 'Quota, e.g. GN/TQ'),
      field('fromStationCode', 'stationCode', false, 'Boarding station code (verified: providers require the segment)'),
      field('toStationCode', 'stationCode', false, 'Destination station code'),
    ],
    outputDescription: 'Availability',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getFare',
    category: 'RAILWAY_DATA',
    summary: 'Fare for a train/class/route.',
    description: 'Fare quote strictly from provider data — fares are never invented.',
    input: [
      field('trainNumber', 'trainNumber', true, 'Train number'),
      field('fromStationCode', 'stationCode', false, 'Origin station code'),
      field('toStationCode', 'stationCode', false, 'Destination station code'),
      field('journeyDate', 'date', false, 'Journey date (YYYY-MM-DD)'),
      field('travelClass', 'travelClass', false, 'Travel class'),
      field('quota', 'quota', false, 'Quota'),
    ],
    outputDescription: 'Fare (verified provider quote with provenance)',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getCancelledTrains',
    category: 'RAILWAY_DATA',
    summary: 'Cancelled trains for a date.',
    description: 'Cancellation list from provider data.',
    input: [field('journeyDate', 'date', true, 'Date (YYYY-MM-DD)')],
    outputDescription: 'CancelledTrain[]',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'checkPNR',
    category: 'RAILWAY_DATA',
    summary: 'Check PNR status.',
    description: 'PNR status strictly from provider data.',
    input: [field('pnr', 'pnr', true, '10-digit PNR number')],
    outputDescription: 'PNRStatus',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getBookings',
    category: 'USER_DATA',
    summary: "List the user's bookings.",
    description: 'Read-only access to the authenticated user’s booking history.',
    input: [field('limit', 'number', false, 'Max results (1–50)', { min: 1, max: 50 })],
    outputDescription: 'Booking[]',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getWallet',
    category: 'USER_DATA',
    summary: 'Read wallet balance and recent transactions.',
    description: 'READ-ONLY wallet snapshot. The AI can never debit, credit or refund.',
    input: [],
    outputDescription: 'WalletReadSnapshot',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'getRailwayKnowledge',
    category: 'RAILWAY_DATA',
    summary: 'Approved general railway knowledge (glossary first; allowlisted official web only as fallback).',
    description:
      'Answers stable CONCEPT questions (classes, quotas, RAC/WL, tatkal, coach types) from the approved deterministic knowledge base, and may attempt retrieval ONLY from allowlisted official railway domains for concepts the glossary does not cover. NEVER used for live data (status/availability/fare/PNR) — those require the railway providers.',
    input: [
      field('query', 'string', true, 'General railway concept question (no live-data requests)'),
      field('domain', 'string', false, 'Optional approved-domain restriction (must be on the official allowlist)'),
    ],
    outputDescription: '{ source: deterministic|web, title, url, retrievedText, timestamp }',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes:
      'Web retrieval is domain-allowlisted server-side; arbitrary URLs are rejected; live-data queries are refused web access. Honest unavailable when neither source answers.',
  },
  {
    name: 'compareTrains',
    category: 'RAILWAY_DATA',
    summary: 'Compare 2–5 trains to help the user choose.',
    description: 'Comparison computed only from verified provider data for every train listed.',
    input: [
      field('trainNumbers', 'trainNumberList', true, 'Train numbers to compare, e.g. [12014, 14542]'),
      field('journeyDate', 'date', false, 'Journey date (YYYY-MM-DD)'),
    ],
    outputDescription: 'TrainComparison (future shape)',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: NOT_IMPLEMENTED_NOTE,
  },
  {
    name: 'createBookingDraft',
    category: 'BOOKING_FLOW',
    summary: 'Create a booking draft from confirmed journey details.',
    description: 'Creates a DRAFT only — no money moves, nothing is booked.',
    input: [
      field('originCode', 'stationCode', true, 'Origin station code'),
      field('destinationCode', 'stationCode', true, 'Destination station code'),
      field('journeyDate', 'date', true, 'Journey date (YYYY-MM-DD)'),
      field('trainNumber', 'trainNumber', true, 'Selected train number'),
      field('travelClass', 'travelClass', true, 'Selected travel class'),
      field('passengerCount', 'number', true, 'Number of passengers (1–6)', { min: 1, max: 6 }),
    ],
    outputDescription: 'BookingDraft (status OPEN)',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'CREATES_DRAFT',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: `${NOT_IMPLEMENTED_NOTE} A draft is never a booking.`,
  },
  {
    name: 'reviewFare',
    category: 'BOOKING_FLOW',
    summary: 'Fetch the verified fare quote for a draft and present it for review.',
    description: 'Attaches a provider fare quote to the draft so the user can review before confirming.',
    input: [field('draftId', 'string', true, 'Booking draft id')],
    outputDescription: 'Fare (verified provider quote)',
    aiRequestable: true,
    executionPolicy: 'AI_REQUEST_SERVER_VALIDATED',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes: `${NOT_IMPLEMENTED_NOTE} Fare shown to user must be exactly the provider quote.`,
  },
  {
    name: 'confirmBooking',
    category: 'PAYMENT',
    summary: 'Execute a confirmed booking (money moves).',
    description:
      'Final booking execution. Requires an explicit user confirmation validated server-side and runs only in deterministic server code.',
    input: [field('draftId', 'string', true, 'Booking draft id to execute')],
    outputDescription: 'Booking',
    aiRequestable: false,
    executionPolicy: 'DETERMINISTIC_ONLY',
    sideEffects: 'EXECUTES_BOOKING',
    status: 'NOT_IMPLEMENTED',
    safetyNotes:
      'HIGHEST-SAFETY TOOL. AI can NEVER request it. Server requires: draft at WAITING_CONFIRMATION + valid explicit user confirmation + verified provider fare quote. NOT IMPLEMENTED (no booking executor exists).',
  },
  {
    name: 'acknowledgeBookingConfirmation',
    category: 'BOOKING_FLOW',
    summary: "Record the user's explicit confirmation of a reviewed booking draft (executes NOTHING).",
    description:
      'Only valid after the full booking review (train, date, route, passengers, class, railway fare, service fee, total) has been presented and the app is explicitly waiting for confirmation. Records the confirmation on the draft. Does NOT book, does NOT move money.',
    input: [field('draftId', 'string', true, 'Booking draft id'), field('utterance', 'string', false, 'What the user said to confirm')],
    outputDescription: 'BookingDraft with confirmation recorded (execution still pending a future step)',
    aiRequestable: false,
    executionPolicy: 'DETERMINISTIC_ONLY',
    sideEffects: 'NONE',
    status: 'NOT_IMPLEMENTED',
    safetyNotes:
      'AI can never request it. Records intent only until the deterministic mock executor takes over.',
  },
  {
    name: 'executeMockBooking',
    category: 'PAYMENT',
    summary: 'Deterministic MOCK booking executor (DEMO only — never a real railway ticket).',
    description:
      'Runs only after: (1) full fare review presented, (2) explicit user confirmation recorded via acknowledgeBookingConfirmation, (3) verified provider fare on the draft. Performs a deterministic server-side wallet balance check and DEMO ledger debit, then creates a clearly-labelled MOCK booking record. No real ticket, no real payment, no PNR generation.',
    input: [field('draftId', 'string', true, 'Booking draft id'), field('expectedTotalMinor', 'number', false, 'Total payable the user reviewed', { min: 1 })],
    outputDescription: 'Booking (isDemo: true, pnr: null, id "MOCK-…")',
    aiRequestable: false,
    executionPolicy: 'DETERMINISTIC_ONLY',
    sideEffects: 'EXECUTES_BOOKING',
    status: 'NOT_IMPLEMENTED',
    safetyNotes:
      'HIGHEST SAFETY. Requires recorded explicit confirmation + verified fare + sufficient DEMO wallet balance. Never generates a real-looking PNR. Failures are reported honestly (never as success).',
  },
];

export const TOOL_NAMES: readonly ToolName[] = TOOL_DEFINITIONS.map((definition) => definition.name);

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

export function getToolDefinition(name: ToolName): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) throw new ValidationError(`No tool definition for "${name}"`);
  return definition;
}
