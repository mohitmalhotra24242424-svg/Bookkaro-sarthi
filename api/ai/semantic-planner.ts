/**
 * SEMANTIC AI TOOL PLANNER — the multi-model fallback chain.
 *
 *   PRIMARY  (openai/gpt-oss-20b)
 *   └─ on timeout / network error / server error / invalid JSON / unusable plan
 *   SECONDARY (nvidia/nemotron-3.5-lightning-30b-a3b)
 *   └─ on failure of primary / invalid output / unusable plan
 *   DETERMINISTIC NLU (offline, rule-based, always available)
 *
 * Both NVIDIA models receive the SAME tool definitions and the SAME plan schema.
 * The planner only UNDERSTANDS; it never executes. It never receives provider
 * keys or railway URLs. On success it returns a validated SemanticPlan plus the
 * model used (source = ai_primary | ai_secondary | nlu) for diagnostics.
 */

import type { ConversationContext } from '../../shared/index.js';
import type { AIUnderstandingResult } from '../../shared/index.js';
import { isKnownIntent } from '../../shared/index.js';
import type { AISlotExtraction } from '../../shared/index.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import type { Intent } from '../../shared/index.js';
import {
  buildSemanticPlanSystemPrompt,
  buildSemanticPlanUserPrompt,
  parseSemanticPlan,
} from './semantic-plan.js';
import type { SemanticPlan, SemanticPlannerResult, SemanticToolCall } from './semantic-plan.js';

/** The only thing the planner needs from a model: one chat-completions round-trip. */
export interface SemanticModelClient {
  readonly model: string;
  readonly baseUrl: string;
  /** Returns the raw assistant text. Throws on transport/timeout/key failure. */
  complete(messages: Array<{ role: string; content: string }>, temperature?: number): Promise<unknown>;
}

export interface SemanticPlannerConfig {
  primary: SemanticModelClient;
  secondary: SemanticModelClient | null;
  /** Per-model timeout (ms) for the entire understand step. */
  timeoutMs?: number;
  /** Deterministic NLU path must ALWAYS be available. */
  nlu?: SemanticNlu;
}

/** Deterministic NLU contract (the existing provider already implements it). */
export interface SemanticNlu {
  understand(input: { userMessage: string; conversation: ConversationContext }): Promise<AIUnderstandingResult>;
}

export function withPlanTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('semantic-plan-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A plan is usable when it parsed AND carries a real action or a clarification. */
function planIsUsable(plan: SemanticPlan | null): plan is SemanticPlan {
  if (!plan) return false;
  return plan.toolPlan.length > 0 || plan.comparison !== null || plan.needsClarification || plan.missingFields.length > 0;
}

export class SemanticPlanner {
  readonly primary: SemanticModelClient;
  readonly secondary: SemanticModelClient | null;
  private readonly timeoutMs: number;
  private readonly nlu: SemanticNlu;

  constructor(config: SemanticPlannerConfig) {
    this.primary = config.primary;
    this.secondary = config.secondary;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.nlu = config.nlu ?? new DeterministicNLUProvider();
  }

  /**
   * Understand a user turn and produce a validated SemanticPlan.
   * Falls back exactly per spec: primary → secondary → deterministic NLU.
   * Never calls both models at once; a valid primary result is returned at once.
   */
  async plan(message: string, conversation: ConversationContext): Promise<SemanticPlannerResult> {
    const system = buildSemanticPlanSystemPrompt();
    const user = buildSemanticPlanUserPrompt(message, conversation);
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    // PRIMARY (gpt-oss-20b)
    try {
      const raw = await withPlanTimeout(this.primary.complete(messages, 0.0), this.timeoutMs);
      const plan = parseSemanticPlan(raw);
      if (planIsUsable(plan)) {
        return { plan, source: 'ai_primary', modelUsed: this.primary.model, fallbackReason: null, raw: typeof raw === 'string' ? raw : null, usedNlu: false };
      }
    } catch {
      // timeout / network / server / malformed → fall through to secondary
    }

    // SECONDARY (nemotron) — never called if primary succeeded
    if (this.secondary) {
      try {
        const raw = await withPlanTimeout(this.secondary.complete(messages, 0.0), this.timeoutMs);
        const plan = parseSemanticPlan(raw);
        if (planIsUsable(plan)) {
          return { plan, source: 'ai_secondary', modelUsed: this.secondary.model, fallbackReason: 'primary-invalid-or-failed', raw: typeof raw === 'string' ? raw : null, usedNlu: false };
        }
      } catch {
        // fall through to deterministic
      }
    }

    // DETERMINISTIC NLU — always available, offline, safe.
    const nluResult = await this.nlu.understand({ userMessage: message, conversation });
    const plan = nluToSemanticPlan(nluResult, message);
    return {
      plan,
      source: 'nlu',
      modelUsed: null,
      fallbackReason: this.secondary ? 'ai_models-failed' : 'ai_unconfigured',
      raw: null,
      usedNlu: true,
    };
  }
}

// ── deterministic NLU → SemanticPlan ─────────────────────────────────────────

const INTENT_TO_SEMANTIC: Partial<Record<Intent, string>> = {
  SEARCH_TRAIN: 'SEARCH_TRAINS',
  GET_TRAIN_INFO: 'GET_TRAIN_INFO',
  GET_TIMETABLE: 'GET_TIMETABLE',
  LIVE_TRAIN_STATUS: 'TRACK_TRAIN',
  GET_AVAILABILITY: 'CHECK_AVAILABILITY',
  GET_FARE: 'GET_FARE',
  CHECK_PNR: 'CHECK_PNR',
  GET_CANCELLED_TRAINS: 'GET_CANCELLED_TRAINS',
  COMPARE_TRAINS: 'COMPARE_TRAINS',
  GENERAL_RAILWAY_QUERY: 'GENERAL_RAILWAY_ANSWER',
  BOOK_TRAIN: 'SEARCH_TRAINS',
};

const TRAIN_TYPE = 'trainNumber';

function argsForTool(tool: string, slots: AISlotExtraction): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  switch (tool) {
    case 'SEARCH_TRAINS':
      if (slots.originQuery) args.originCode = slots.originQuery;
      if (slots.destinationQuery) args.destinationCode = slots.destinationQuery;
      if (slots.journeyDate) args.journeyDate = slots.journeyDate;
      else if (slots.dateText) args.journeyDate = slots.dateText;
      break;
    case 'GET_TRAIN_INFO':
    case 'GET_TIMETABLE':
    case 'TRACK_TRAIN':
      if (slots.trainNumber) args.trainNumber = slots.trainNumber;
      if (slots.journeyDate) args.journeyDate = slots.journeyDate;
      break;
    case 'CHECK_AVAILABILITY':
      if (slots.trainNumber) args.trainNumber = slots.trainNumber;
      if (slots.journeyDate) args.journeyDate = slots.journeyDate;
      if (slots.travelClass) args.travelClass = slots.travelClass;
      break;
    case 'GET_FARE':
      if (slots.trainNumber) args.trainNumber = slots.trainNumber;
      if (slots.journeyDate) args.journeyDate = slots.journeyDate;
      if (slots.travelClass) args.travelClass = slots.travelClass;
      if (slots.originQuery) args.fromStationCode = slots.originQuery;
      if (slots.destinationQuery) args.toStationCode = slots.destinationQuery;
      break;
    case 'CHECK_PNR':
      if (slots.pnr) args.pnr = slots.pnr;
      break;
    case 'GET_CANCELLED_TRAINS':
      if (slots.journeyDate) args.journeyDate = slots.journeyDate;
      break;
    case 'GENERAL_RAILWAY_ANSWER':
      if (slots.glossaryTerm) args.query = slots.glossaryTerm;
      break;
    default:
      break;
  }
  void TRAIN_TYPE;
  return args;
}

/** Convert the deterministic NLU understanding into a SemanticPlan (safe, rule-based). */
export function nluToSemanticPlan(result: AIUnderstandingResult, message: string): SemanticPlan {
  const slots = result.slots;
  const intent = result.intent;
  const semanticTool = INTENT_TO_SEMANTIC[intent] ?? null;

  const toolPlan: SemanticToolCall[] = [];
  if (semanticTool && semanticTool !== 'COMPARE_TRAINS') {
    const args = argsForTool(semanticTool, slots);
    const toolId = semanticTool as SemanticToolCall['tool'];
    toolPlan.push({ tool: toolId, args });
  }

  let comparison: SemanticPlan['comparison'] = null;
  if (intent === 'COMPARE_TRAINS') {
    // Two train numbers → comparison; the backend fetches real data.
    comparison = slots.secondTrainNumber ? 'EARLIEST_ARRIVAL' : 'SHORTEST_DURATION';
    const trainNumbers = [slots.trainNumber, slots.secondTrainNumber].filter((value): value is string => typeof value === 'string');
    for (const number of trainNumbers) {
      toolPlan.push({ tool: 'GET_TIMETABLE', args: { trainNumber: number } });
    }
  }

  // Missing-field detection (informational; the orchestrator asks/validates).
  const missingFields: string[] = [];
  if ((intent === 'SEARCH_TRAIN' || intent === 'BOOK_TRAIN') && !slots.originQuery) missingFields.push('origin');
  if ((intent === 'SEARCH_TRAIN' || intent === 'BOOK_TRAIN') && !slots.destinationQuery) missingFields.push('destination');
  if ((intent === 'SEARCH_TRAIN' || intent === 'BOOK_TRAIN') && !slots.dateText && !slots.journeyDate) missingFields.push('journeyDate');
  if (intent === 'LIVE_TRAIN_STATUS' && !slots.trainNumber) missingFields.push('trainNumber');
  if (intent === 'CHECK_PNR' && !slots.pnr) missingFields.push('pnr');

  return {
    intent: isKnownIntent(intent) ? intent : 'UNKNOWN',
    confidence: result.confidence,
    entities: {
      origin: slots.originQuery,
      destination: slots.destinationQuery,
      trainNumbers: [slots.trainNumber, slots.secondTrainNumber].filter((value): value is string => typeof value === 'string'),
      trainName: null,
      date: slots.dateText ?? slots.journeyDate,
      travelClass: slots.travelClass,
      passengers: slots.passengerCount,
      pnr: slots.pnr,
    },
    toolPlan,
    comparison,
    needsClarification: false, // the conversational orchestrator asks via its own path when needed
    missingFields,
    clarificationQuestion: null,
  };
}
