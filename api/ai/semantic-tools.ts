/**
 * SEMANTIC TOOL REGISTRY — the strict server-side allowlist the Semantic AI
 * Tool Planner may select from (FINAL SPEC §"SEMANTIC TOOL REGISTRY").
 *
 * Exactly NINE approved tools, in UPPER_SNAKE semantic ids. Each maps to a
 * Step-6 catalog id (which itself maps to a Step-1 registry tool + executor),
 * so every plan entry flows through the SAME catalog validation → ToolRegistry
 * → ProviderRouter (RailCore primary → RailKit fallback) boundary. The AI
 * never sees a URL, a provider, a method or a credential — it only emits a
 * logical capability + validated args.
 *
 * The AI provider NEVER executes; the backend validates the plan and executes.
 */

import type { RailwayCapability } from '../../shared/index.js';

/** The only tool ids any AI model may emit. */
export const SEMANTIC_TOOL_IDS = [
  'SEARCH_TRAINS',
  'GET_TRAIN_INFO',
  'GET_TIMETABLE',
  'TRACK_TRAIN',
  'CHECK_AVAILABILITY',
  'GET_FARE',
  'CHECK_PNR',
  'GET_CANCELLED_TRAINS',
  'GENERAL_RAILWAY_ANSWER',
] as const;

export type SemanticToolId = (typeof SEMANTIC_TOOL_IDS)[number];

export function isSemanticToolId(value: unknown): value is SemanticToolId {
  return typeof value === 'string' && (SEMANTIC_TOOL_IDS as readonly string[]).includes(value);
}

/** Argument model used by the plan validator + emitted in the AI tool definitions. */
export interface SemanticToolArgSpec {
  name: string;
  /**
   * The catalog arg kind — the SAME kind strings the Step-6 `validateToolArguments`
   * understands (trainNumber / pnr / date / class / quota / stationCode /
   * passengerCount / string), so we can hand a plan entry to the catalog validator
   * unchanged.
   */
  kind: 'trainNumber' | 'pnr' | 'date' | 'class' | 'quota' | 'stationCode' | 'passengerCount' | 'string';
  required: boolean;
  description: string;
}

export interface SemanticToolDefinition {
  /** The semantic id the AI emits. */
  id: SemanticToolId;
  /** Human/prompt summary. */
  summary: string;
  description: string;
  /** Step-6 catalog id this maps to (what the executor consumes). */
  catalogId: string;
  /** Server-side capability needed — used for provider routing diagnostics. */
  capability: RailwayCapability | null;
  args: readonly SemanticToolArgSpec[];
}

/** The strict, approved semantic tool list (exactly nine). */
export const SEMANTIC_TOOLS: readonly SemanticToolDefinition[] = [
  {
    id: 'SEARCH_TRAINS',
    summary: 'Search trains between two stations on a date',
    description: 'Use for: trains between stations, journey options, trains for a date, route search, fastest train between stations.',
    catalogId: 'SEARCH_TRAINS',
    capability: 'trainSearch',
    args: [
      { name: 'originCode', kind: 'stationCode', required: true, description: 'Origin station code, e.g. ASR' },
      { name: 'destinationCode', kind: 'stationCode', required: true, description: 'Destination station code, e.g. LDH' },
      { name: 'journeyDate', kind: 'date', required: true, description: 'Journey date (YYYY-MM-DD)' },
      { name: 'passengerCount', kind: 'passengerCount', required: false, description: 'Number of passengers (1–6)' },
    ],
  },
  {
    id: 'GET_TRAIN_INFO',
    summary: 'General information about one train',
    description: 'Use for: train details, route details, journey information, train duration, train information.',
    catalogId: 'GET_TRAIN_INFO',
    capability: 'trainInfo',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true, description: 'Train number, e.g. 12014' }],
  },
  {
    id: 'GET_TIMETABLE',
    summary: 'Scheduled stops and timings of a train',
    description: 'Use for: scheduled departure, scheduled arrival, station timings, route timings, "kab pahuchegi?", "kab niklegi?".',
    catalogId: 'GET_TIMETABLE',
    capability: 'timetable',
    args: [{ name: 'trainNumber', kind: 'trainNumber', required: true, description: 'Train number' }],
  },
  {
    id: 'TRACK_TRAIN',
    summary: 'Live running status, delay, current/next station',
    description: 'Use for: where is the train now, live location, live running status, current station, delay, running late?',
    catalogId: 'GET_LIVE_STATUS',
    capability: 'liveStatus',
    args: [
      { name: 'trainNumber', kind: 'trainNumber', required: true, description: 'Train number' },
      { name: 'journeyDate', kind: 'date', required: false, description: 'Journey date for the run (YYYY-MM-DD); omit for the current run' },
    ],
  },
  {
    id: 'CHECK_AVAILABILITY',
    summary: 'Seat availability for a train/class/segment/date',
    description: 'Use for: seats available, AVL, WL, RAC, class availability.',
    catalogId: 'GET_AVAILABILITY',
    capability: 'availability',
    args: [
      { name: 'trainNumber', kind: 'trainNumber', required: true, description: 'Train number' },
      { name: 'journeyDate', kind: 'date', required: true, description: 'Journey date (YYYY-MM-DD)' },
      { name: 'travelClass', kind: 'class', required: true, description: 'Travel class, e.g. SL/3A/CC' },
      { name: 'fromStationCode', kind: 'stationCode', required: false, description: 'Boarding station code' },
      { name: 'toStationCode', kind: 'stationCode', required: false, description: 'Destination station code' },
      { name: 'quota', kind: 'quota', required: false, description: 'Quota, e.g. GN/TQ' },
    ],
  },
  {
    id: 'GET_FARE',
    summary: 'Fare for a train/class/route',
    description: 'Use for: ticket price, railway fare, class fare, journey fare, "kitne paise lagenge?".',
    catalogId: 'GET_FARE',
    capability: 'fare',
    args: [
      { name: 'trainNumber', kind: 'trainNumber', required: true, description: 'Train number' },
      { name: 'fromStationCode', kind: 'stationCode', required: false, description: 'Origin station code' },
      { name: 'toStationCode', kind: 'stationCode', required: false, description: 'Destination station code' },
      { name: 'journeyDate', kind: 'date', required: false, description: 'Journey date (YYYY-MM-DD)' },
      { name: 'travelClass', kind: 'class', required: false, description: 'Travel class' },
      { name: 'quota', kind: 'quota', required: false, description: 'Quota' },
    ],
  },
  {
    id: 'CHECK_PNR',
    summary: 'Check PNR status',
    description: 'Use when the user provides a PNR or asks to check an existing PNR. Never invent a PNR.',
    catalogId: 'GET_PNR',
    capability: 'pnr',
    args: [{ name: 'pnr', kind: 'pnr', required: true, description: '10-digit PNR number' }],
  },
  {
    id: 'GET_CANCELLED_TRAINS',
    summary: 'Cancelled trains list for a date',
    description: 'Use for: cancelled trains, trains cancelled today, trains cancelled tomorrow.',
    catalogId: 'GET_CANCELLED_TRAINS',
    capability: 'cancelledTrains',
    args: [{ name: 'journeyDate', kind: 'date', required: true, description: 'Date (YYYY-MM-DD)' }],
  },
  {
    id: 'GENERAL_RAILWAY_ANSWER',
    summary: 'General railway concepts (glossary + allowlisted official web)',
    description: 'Use for: RAC meaning, WL meaning, GNWL meaning, railway terminology, general railway knowledge. Do NOT call a live railway API.',
    catalogId: 'RAILWAY_KNOWLEDGE',
    capability: null,
    args: [
      { name: 'query', kind: 'string', required: true, description: 'General railway concept question (no live-data request)' },
      { name: 'domain', kind: 'string', required: false, description: 'Optional approved-domain restriction' },
    ],
  },
];

const BY_ID = new Map<string, SemanticToolDefinition>(SEMANTIC_TOOLS.map((tool) => [tool.id, tool]));

export function getSemanticTool(id: string): SemanticToolDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** Serializable, credential-free tool definitions — the only shape handed to an AI model. */
export function describeSemanticTools(): readonly { id: string; summary: string; description: string; args: readonly SemanticToolArgSpec[] }[] {
  return SEMANTIC_TOOLS.map((tool) => ({ id: tool.id, summary: tool.summary, description: tool.description, args: tool.args }));
}

/** Map a semantic tool id → the Step-6 catalog id the executor consumes. */
export function semanticToolToCatalogId(id: string): string | null {
  return getSemanticTool(id)?.catalogId ?? null;
}
