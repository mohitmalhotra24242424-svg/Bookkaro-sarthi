/**
 * SEMANTIC AI TOOL PLANNER — plan schema, prompt builder, parser + validator.
 *
 * The AI (both NVIDIA models) returns ONE structured JSON plan per railway
 * message. The parser/validator normalize + whitelist it; the backend then
 * validates args (via the Step-6 catalog), routes to RailCore→RailKit and
 * executes. The semantic planner NEVER executes, and NEVER receives provider
 * keys/URLs — it only emits logical capabilities + validated args.
 */

import type { ConversationContext } from '../../shared/index.js';
import { extractJson } from '../../ai/providers/NvidiaAIProvider.js';
import { describeSemanticTools, getSemanticTool, semanticToolToCatalogId } from './semantic-tools.js';
import type { SemanticToolId } from './semantic-tools.js';

/** Comparison metric the model may request. Backend computes the winner. */
export type SemanticComparison =
  | 'EARLIEST_ARRIVAL'
  | 'SHORTEST_DURATION'
  | 'EARLIEST_DEPARTURE'
  | 'FASTEST'
  | null;

export interface SemanticEntity {
  origin: string | null;
  destination: string | null;
  trainNumbers: string[];
  trainName: string | null;
  /** Raw date expression ("kal"/"parso"/"aaj"/ISO) — resolved deterministically server-side. */
  date: string | null;
  travelClass: string | null;
  passengers: number | null;
  pnr: string | null;
}

export interface SemanticToolCall {
  tool: SemanticToolId;
  args: Record<string, unknown>;
}

export interface SemanticPlan {
  intent: string;
  confidence: number;
  entities: SemanticEntity;
  toolPlan: SemanticToolCall[];
  comparison: SemanticComparison;
  needsClarification: boolean;
  missingFields: string[];
  clarificationQuestion: string | null;
}

/** Diagnostic model source — mirrors the spec's `source` field. */
export type SemanticPlannerSource = 'ai_primary' | 'ai_secondary' | 'nlu' | 'none';

export interface SemanticPlannerResult {
  plan: SemanticPlan | null;
  source: SemanticPlannerSource;
  modelUsed: string | null;
  fallbackReason: string | null;
  /** Raw model text (already validated; kept for diagnostics/debugging only). */
  raw: string | null;
  /** True when the plan came from the deterministic NLU (offline, safe). */
  usedNlu: boolean;
}

// ── prompt builder (SAME tool definitions for both models) ───────────────────

export function buildSemanticPlanSystemPrompt(): string {
  const toolLines = describeSemanticTools()
    .map((tool) => {
      const argLine = tool.args.map((arg) => `${arg.name}${arg.required ? '' : '?'}`).join(', ');
      return `- ${tool.id}${argLine ? ` (args: ${argLine})` : ''}: ${tool.description}`;
    })
    .join('\n');

  return [
    'You are the semantic railway tool planner of BookKaro, an Indian railway assistant.',
    'Understand the MEANING of the user question (Hindi, Hinglish, English, mixed, indirect, comparison or multi-part) and return ONLY a JSON object — no markdown, no prose.',
    'JSON schema (all fields required, use null / [] when absent):',
    '{"intent":"<short semantic description>","confidence":0.0,',
    ' "entities":{"origin":str|null,"destination":str|null,"trainNumbers":[],"trainName":str|null,"date":str|null,"travelClass":str|null,"passengers":int|null,"pnr":str|null},',
    ' "toolPlan":[{"tool":"<ALLOWED_TOOL>","args":{...}}],',
    ' "comparison":"EARLIEST_ARRIVAL|SHORTEST_DURATION|EARLIEST_DEPARTURE|FASTEST|null",',
    ' "needsClarification":false,"missingFields":[],"clarificationQuestion":null}',
    '',
    'APPROVED TOOLS (you may ONLY use these ids):',
    toolLines,
    '',
    'RULES:',
    '- Use ONLY approved tool ids. Never return a URL, endpoint, method, apiKey, provider name or credential anywhere.',
    '- Extract ONLY what the user literally said; never invent a station code, train number, date, time, fare, availability or PNR. If the AI would have to guess, set needsClarification=true and name the missing field(s).',
    '- Comparison questions (fastest / jaldi pahunch / kam time / kaunsi pehle) → set "comparison" and, when the backend needs real data, plan the tools that FETCH it (e.g. SEARCH_TRAINS or GET_TIMETABLE). The backend picks the winner; the AI never names a winner or a time.',
    '- A route/journey query (trains between two places) MUST plan SEARCH_TRAINS with originCode + destinationCode + journeyDate. Put the station tokens (even names, e.g. \"Amritsar\", \"Ludhiana\", \"Delhi\") in originCode/destinationCode — the backend resolves names to codes. Do NOT leave toolPlan empty for a route query.',
    '- A bare route search (\"X se Y jaana hai\", \"X se Y ki trains\") is SEARCH_TRAINS only — do NOT require passengers or travelClass, and do NOT treat it as a booking. Set needsClarification only when route or date is genuinely missing.',
    '- Multi-part questions may plan MULTIPLE approved tools (e.g. CHECK_AVAILABILITY + GET_FARE).',
    '- General terminology (RAC/WL/GNWL/IRCTC booking) → GENERAL_RAILWAY_ANSWER with a query. Do NOT also plan a live-data tool.',
    '- Missing route/date/train → set needsClarification=true, missingFields=[...] and clarificationQuestion (a short Hinglish question). Never silently default a date to today unless the user said aaj/today.',
    '- Dates: keep the user\u2019s expression (aaj/kal/parso/YYYY-MM-DD) in entities.date; the backend resolves it.',
    '- Stations: put the user\u2019s word in entities.origin/entities.destination as free text if you do not know the code.',
  ].join('\n');
}

export function buildSemanticPlanUserPrompt(message: string, conversation: ConversationContext): string {
  const bits: string[] = [];
  if (conversation.origin?.code) bits.push(`origin=${conversation.origin.code}`);
  if (conversation.destination?.code) bits.push(`destination=${conversation.destination.code}`);
  if (conversation.journeyDate) bits.push(`date=${conversation.journeyDate}`);
  if (conversation.selectedTrain?.number) bits.push(`selectedTrain=${conversation.selectedTrain.number}`);
  if (conversation.selectedClass) bits.push(`selectedClass=${conversation.selectedClass}`);
  if (conversation.passengerCount) bits.push(`passengers=${conversation.passengerCount}`);
  if (conversation.lastAskedField) bits.push(`pendingField=${conversation.lastAskedField}`);
  const context = bits.length > 0 ? `Conversation context (do not invent beyond this): ${bits.join('; ')}\n` : '';
  return `${context}User message: ${message}`;
}

// ── plan validation ──────────────────────────────────────────────────────────

const SEMANTIC_COMPARISONS: readonly string[] = ['EARLIEST_ARRIVAL', 'SHORTEST_DURATION', 'EARLIEST_DEPARTURE', 'FASTEST'];

function emptyEntities(): SemanticEntity {
  return { origin: null, destination: null, trainNumbers: [], trainName: null, date: null, travelClass: null, passengers: null, pnr: null };
}

function normalizeEntities(raw: unknown): SemanticEntity {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const trainNumbers = Array.isArray(source.trainNumbers)
    ? source.trainNumbers.filter((value): value is string => typeof value === 'string' && /^\d{4,6}$/.test(value))
    : [];
  return {
    origin: typeof source.origin === 'string' && source.origin.trim().length > 0 ? source.origin.trim() : null,
    destination: typeof source.destination === 'string' && source.destination.trim().length > 0 ? source.destination.trim() : null,
    trainNumbers,
    trainName: typeof source.trainName === 'string' && source.trainName.trim().length > 0 ? source.trainName.trim() : null,
    date: typeof source.date === 'string' && source.date.trim().length > 0 ? source.date.trim() : null,
    travelClass: typeof source.travelClass === 'string' && source.travelClass.trim().length > 0 ? source.travelClass.trim().toUpperCase() : null,
    passengers: typeof source.passengers === 'number' && Number.isInteger(source.passengers) ? source.passengers : null,
    pnr: typeof source.pnr === 'string' && /^\d{10}$/.test(source.pnr.trim()) ? source.pnr.trim() : null,
  };
}

function normalizeToolCall(raw: unknown): SemanticToolCall | null {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const tool = source.tool;
  if (typeof tool !== 'string' || !getSemanticTool(tool)) return null;
  const args = source.args !== null && typeof source.args === 'object' && !Array.isArray(source.args) ? (source.args as Record<string, unknown>) : {};
  return { tool: tool as SemanticToolId, args };
}

/** Strictly normalize + whitelist a model plan. Unknown tools and URLs are dropped. */
export function parseSemanticPlan(content: unknown): SemanticPlan | null {
  const parsed = extractJson((content ?? '') as string);
  if (Object.keys(parsed).length === 0) return null;

  const rawPlan = parsed.toolPlan;
  const toolPlan: SemanticToolCall[] = [];
  if (Array.isArray(rawPlan)) {
    for (const entry of rawPlan) {
      const normalized = normalizeToolCall(entry);
      if (normalized) toolPlan.push(normalized);
    }
  }

  const comparisonRaw = typeof parsed.comparison === 'string' ? parsed.comparison.toUpperCase() : null;
  const comparison = comparisonRaw && SEMANTIC_COMPARISONS.includes(comparisonRaw) ? (comparisonRaw as NonNullable<SemanticComparison>) : null;

  return {
    intent: typeof parsed.intent === 'string' && parsed.intent.trim().length > 0 ? parsed.intent.trim().slice(0, 80) : 'UNKNOWN',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    entities: normalizeEntities(parsed.entities),
    toolPlan,
    comparison,
    needsClarification: parsed.needsClarification === true,
    missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields.filter((value): value is string => typeof value === 'string').slice(0, 8) : [],
    clarificationQuestion: typeof parsed.clarificationQuestion === 'string' && parsed.clarificationQuestion.trim().length > 0 ? parsed.clarificationQuestion.trim().slice(0, 160) : null,
  };
}

/** Backend check: real data tools must have their required args present (model may under-specify). */
export interface PlanValidationIssue {
  tool: string;
  missingArgs: string[];
  invalid: boolean;
}

export function validateSemanticPlanRequiredArgs(plan: SemanticPlan): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  for (const call of plan.toolPlan) {
    const definition = getSemanticTool(call.tool);
    if (!definition) continue;
    const missingArgs = definition.args.filter((arg) => {
      const value = call.args[arg.name];
      return arg.required && (value === undefined || value === null || value === '' || (typeof value === 'string' && value.trim().length === 0));
    });
    // CHECK_AVAILABILITY for the provider also needs from/to; we allow backend fill.
    if (missingArgs.length > 0) {
      issues.push({ tool: call.tool, missingArgs: missingArgs.map((arg) => arg.name), invalid: false });
    }
  }
  return issues;
}

/** Convenience: a plan that referenced NO approved tool and needs no clarification is unusable. */
export function planIsExecutable(plan: SemanticPlan | null | undefined): boolean {
  if (!plan) return false;
  if (plan.needsClarification) return false;
  return plan.toolPlan.length > 0 || plan.comparison !== null;
}

// Re-export the catalog-id mapping helper for downstream executors.
export { semanticToolToCatalogId, getSemanticTool };
