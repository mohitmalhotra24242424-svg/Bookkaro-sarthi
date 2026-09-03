/**
 * CONVERSATION ORCHESTRATOR (Step 3 core).
 *
 * Architecture: user message → AI understand() → STRICT validated structured
 * output → deterministic server-side slot resolution & tool selection →
 * ToolRegistry (server-side validation + execution) → normalized ToolResults
 * → safe natural-language reply.
 *
 * Safety properties (test-enforced):
 *  - every tool execution goes through the ToolRegistry validation boundary
 *    (requestedBy 'AI'), never directly from AI output;
 *  - confirmBooking / any protected or unregistered tool request is rejected
 *    and RECORDED as a safety event — never executed;
 *  - station codes come only from the lookupStation tool or the user's own
 *    input — never guessed;
 *  - dates are resolved only from explicit user words (aaj/kal/parso/exact);
 *  - when data is unavailable the reply is the honest unavailable template —
 *    AI prose is overridden (hallucination guard);
 *  - AI failures/timeouts fall back to the deterministic NLU, never to a
 *    fabricated answer;
 *  - a bounded AI timeout keeps the request from hanging.
 */

import {
  addConversationMessage,
  canTransitionTo,
  INTENTS,
  containsUrl,
  newId,
  restorePausedBooking,
  savePausedBooking,
  setContextSlots,
  setSearchResults,
  updateConversationMeta,
} from '../shared/index.js';
import type {
  AIUnderstandingResult,
  Availability,
  BookingDraft,
  CancelledTrain,
  ConversationContext,
  ContextSlotField,
  Fare,
  Intent,
  LiveStatus,
  PNRStatus,
  SearchFilterHint,
  Station,
  Timetable,
  TrainStop,
  ToolCall,
  ToolName,
  ToolResult,
  Train,
  TrainSearchResult,
  TravelClassCode,
} from '../shared/index.js';
import { composeKnowledgeAnswer, findGlossaryAnswer } from '../shared/railwayKnowledge.js';
import {
  classifyUniversalQuerySource,
  detectComparisonRequest,
  filterByDayPart,
  pickBestByMetric,
  summarizeSearchIntelligence,
  durationDifferenceBetween,
  isBestAmbiguous,
  clockToMinutes,
  dayPartOfHour,
  formatDuration,
  formatClock,
  applySearchFilter,
  reconcileSearchFilter,
  searchFilterAck,
} from './query-intelligence.js';
import type { ComparisonRequest } from './query-intelligence.js';
import { HONEST_UNAVAILABLE_MESSAGE, RULE_SENSITIVE_QUERY } from '../tools/executors/knowledgeTools.js';
import { APPLICATION_SERVICE_FEE_MINOR, totalPayableMinor } from '../shared/serviceFee.js';
import type { ToolExecutionContext, ToolRegistry } from '../tools/index.js';
import { canAiRequestTool } from '../tools/permissions.js';
import type { AIProvider } from './AIProvider.js';
import { DeterministicNLUProvider } from './providers/DeterministicNLUProvider.js';
import { splitCompoundRequest } from './providers/DeterministicNLUProvider.js';
import {
  availabilityLineReply,
  availabilityReply,
  askForClass,
  askForField,
  greetingReply,
  isGreetingMessage,
  bookingReviewReply,
  bookingsReply,
  cannotDoThatReply,
  cancelledListUnfilteredReply,
  cancelledReply,
  cancelledSpecificReply,
  comparisonReply,
  confirmationDeclinedReply,
  confirmationRecordedReply,
  draftReply,
  fareLinesForReview,
  buildBookingSummary,
  finalReviewReply,
  mockBookingFailureReply,
  mockBookingSuccessReply,
  passengerQuestion,
  berthsForClass,
  waitlistConsentQuestion,
  fareReply,
  liveStatusReply,
  multiClassFareReply,
  notAwaitingConfirmationReply,
  pnrReply,
  railwayUnavailableReply,
  railwayFetchSlowReply,
  rephraseReply,
  searchResultsReply,
  selectionReply,
  stationChoiceReply,
  stationResolveFailedReply,
  stationsReply,
  timetableReply,
  trainInfoReply,
  trainDoesNotServeSegmentReply,
  walletReply,
} from './replyTemplates.js';
import {
  mergeCorrection,
  resolveDateText,
  resolveResultReference,
  resolveStationChoice,
  canonicalLookupQuery,
  stationForCandidate,
  stationFromDirectInput,
  stationFromLookup,
} from './slotResolution.js';
import { collapseEquivalentStations, commercialHaltIndex, stationCodesMatch } from '../shared/trainHalt.js';
import { validateAIUnderstanding } from './structuredOutput.js';
import { TimeoutError, withTimeout } from './timeout.js';
// Step 10 — automatic station-lookup resolution (provider-backed, all-India).
import { toCandidate, matchPendingCandidate, isFieldResolved } from './station-resolution.js';
import type { StationResolutionCandidate, PendingStationResolution } from './station-resolution.js';

export interface OrchestratorDependencies {
  /** Primary AI (real provider when configured; deterministic by default). */
  ai: AIProvider;
  /** Deterministic fallback NLU — always present. */
  fallbackNlu?: AIProvider;
  toolRegistry: ToolRegistry;
  aiTimeoutMs?: number;
  now?: () => Date;
}

/**
 * Step 9 §4 + UNIVERSAL RAILWAY QUESTION ENGINE: intelligent source-selection
 * classes. This is the 8-class taxonomy the product uses to label a turn, so the
 * UI (and any downstream analytics) knows where the answer CAME FROM. The two
 * legacy value names below ('COMPARISON', 'CONTEXTUAL_FOLLOWUP') are kept for
 * backwards compatibility with the frontend; they are the TRAIN_COMPARISON and
 * CONTEXTUAL_RAILWAY_QUERY buckets respectively (see query-intelligence.ts).
 */
export type SourceClass =
  | 'LIVE_RAILWAY_DATA'
  | 'TRAIN_SEARCH'
  | 'COMPARISON'
  | 'TRAIN_CALCULATION'
  | 'GENERAL_RAILWAY_KNOWLEDGE'
  | 'CONTEXTUAL_FOLLOWUP'
  | 'MULTI_CAPABILITY_QUERY'
  | 'NORMAL_CHAT';

/** Deterministic source-class derivation from the executed intent/tool. */
function classifySource(intent: Intent, executedTools: readonly string[], wasFollowUp: boolean): SourceClass {
  if (wasFollowUp && intent !== 'COMPARE_TRAINS' && intent !== 'GENERAL_RAILWAY_QUERY') return 'CONTEXTUAL_FOLLOWUP';
  if (intent === 'COMPARE_TRAINS') return 'COMPARISON';
  if (intent === 'GENERAL_RAILWAY_QUERY') return 'GENERAL_RAILWAY_KNOWLEDGE';
  if (intent === 'NORMAL_CHAT' || intent === 'HELP' || intent === 'UNKNOWN') return 'NORMAL_CHAT';
  if (intent === 'BOOK_TRAIN' || intent === 'SEARCH_TRAIN') return 'TRAIN_SEARCH';
  return 'LIVE_RAILWAY_DATA';
}

/** Structured train cards for the chat UI (§8) — never a wall of text. */
export interface TrainCard {
  number: string;
  name: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  durationMinutes: number | null;
  classes: string[];
  fromCode: string | null;
  fromName: string | null;
  toCode: string | null;
  toName: string | null;
  originCode: string | null;
  originName: string | null;
  destCode: string | null;
  destName: string | null;
}

/** Structured chat panels: fare summary / final review / passenger progress (§20). */
export type ChatPanel =
  | { kind: 'fare'; railwayFareMinor: number; serviceFeeMinor: number; totalPayableMinor: number; travelClass: string | null }
  | { kind: 'review'; summary: import('./replyTemplates.js').BookingSummaryData; draftId: string }
  | { kind: 'passengers'; current: number; total: number; label: string };

export interface OrchestratorTurn {
  reply: string;
  context: ConversationContext;
  intent: Intent;
  usedFallbackNlu: boolean;
  executedTools: string[];
  safetyRejections: string[];
  cards: TrainCard[] | null;
  panel: ChatPanel | null;
  chips: string[] | null;
  sourceClass: SourceClass;
}

interface TurnState {
  deps: OrchestratorDependencies;
  now: Date;
  message: string;
  context: ConversationContext;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  safetyRejections: string[];
  cards: TrainCard[] | null;
  panel: ChatPanel | null;
  chips: string[] | null;
  wasFollowUp: boolean;
  /** Time-of-day/window filter the AI read from the CURRENT turn (reconciled against the user's literal words; null when none). */
  filterHint: SearchFilterHint | null;
  /** True when the primary AI understand() hit TimeoutError — never invent facts to fill the gap. */
  aiTimedOut: boolean;
}

// ── AI understanding with timeout + fallback ─────────────────────────────────

async function understand(deps: OrchestratorDependencies, context: ConversationContext, message: string) {
  const fallback = deps.fallbackNlu ?? new DeterministicNLUProvider();
  const timeoutMs = deps.aiTimeoutMs ?? 6_000;

  let aiTimedOut = false;
  if (deps.ai.providerId !== 'deterministic-nlu') {
    try {
      const raw = await withTimeout(deps.ai.understand(buildUnderstandingInput(context, message, aiToolCatalogue(deps))), timeoutMs);
      const validated = validateUnderstanding(deps, raw);
      if (validated.ok && validated.result) {
        return { understanding: validated.result, usedFallbackNlu: false, safetyRejections: validated.toolErrors, aiTimedOut: false };
      }
      // invalid structured output → deterministic fallback (never trust AI JSON blindly)
    } catch (error) {
      aiTimedOut = error instanceof TimeoutError;
      // AI provider failed (timeout / 401 / 429 / unusable) — fall through.
    }
    const rawFallback = await fallback.understand(buildUnderstandingInput(context, message, aiToolCatalogue(deps)));
    const validatedFallback = validateUnderstanding(deps, rawFallback);
    return {
      understanding: validatedFallback?.result ?? null,
      usedFallbackNlu: true,
      safetyRejections: validatedFallback?.toolErrors ?? [],
      aiTimedOut,
    };
  }

  const raw = await deps.ai.understand(buildUnderstandingInput(context, message, aiToolCatalogue(deps)));
  const validated = validateUnderstanding(deps, raw);
  return { understanding: validated?.result ?? null, usedFallbackNlu: false, safetyRejections: validated?.toolErrors ?? [], aiTimedOut: false };
}

/** Real tool catalogue the AI may request (READ/DRAFT, money-safe tools only). */
function aiToolCatalogue(deps: OrchestratorDependencies): ToolName[] {
  return deps.toolRegistry.list().map((definition) => definition.name);
}

function buildUnderstandingInput(context: ConversationContext, message: string, tools: readonly ToolName[] = []) {
  return {
    userMessage: message,
    conversation: context,
    availableIntents: INTENTS, // real vocabulary so model prompts list every legal intent
    availableTools: tools, // the real, requestable tool catalogue — AI may now choose one
  };
}

function validateUnderstanding(deps: OrchestratorDependencies, raw: unknown) {
  const registry = deps.toolRegistry;
  return validateAIUnderstanding({
    raw,
    availableTools: registry.list().map((definition) => definition.name),
    isToolAiRequestable: (tool: ToolName) => canAiRequestTool(tool, registry.get(tool)?.aiRequestable ?? false),
  });
}

// ── tool execution (always through the registry boundary) ───────────────────

const MAX_TOOLS_PER_TURN = 5;

async function executeTool(
  state: TurnState,
  tool: ToolName,
  input: Record<string, unknown>,
  requestedBy: 'AI' | 'SERVER' = 'AI',
): Promise<ToolResult> {
  if (state.toolCalls.length >= MAX_TOOLS_PER_TURN) {
    const refused: ToolResult = {
      callId: null,
      tool,
      ok: false,
      data: null,
      unavailableReason: null,
      error: { code: 'TOOL_BUDGET_EXCEEDED', message: `tool-call limit reached (max ${MAX_TOOLS_PER_TURN} per turn)` },
      executedBy: 'SERVER',
    };
    return refused;
  }
  const call: ToolCall = {
    id: newId('tc'),
    tool,
    input,
    requestedBy,
    conversationId: state.context.id,
    createdAt: new Date().toISOString(),
  };
  const context: ToolExecutionContext = {
    actor: requestedBy,
    userId: state.context.userId,
    conversationId: state.context.id,
    call,
  };
  const result = await state.deps.toolRegistry.execute(call, context);
  state.toolCalls.push(call);
  state.toolResults.push(result);
  state.context = {
    ...state.context,
    lastToolResult: {
      success: result.ok,
      tool: call.tool,
      provider: result.provider ?? null,
      error: result.ok ? null : (result.error?.code ?? null),
      timestamp: nowIso(state),
    },
    updatedAt: nowIso(state),
  };
  return result;
}

function dataOf<T>(result: ToolResult): T | null {
  return result.ok && result.data !== null && result.data !== undefined ? (result.data as T) : null;
}

/** All railway-fact replies below are templates fed by tool data; when the required tool returned no usable data we NEVER let AI prose fill the gap. */
async function finish(
  state: TurnState,
  intent: Intent,
  templateReply: string,
  options: { factsFromTools?: boolean; usedFallbackNlu: boolean; sourceClass?: SourceClass; allowAiNarration?: boolean } = { usedFallbackNlu: false },
): Promise<OrchestratorTurn> {
  let reply = templateReply;

  // Primary = railway API. If it timed out / went unavailable (not an honest
  // empty result), try allowlisted official web once. Never invent.
  const lastBeforeWeb = state.toolResults[state.toolResults.length - 1];
  const providerDown =
    lastBeforeWeb?.error?.code === 'RAILWAY_TIMEOUT' || lastBeforeWeb?.error?.code === 'RAILWAY_DATA_UNAVAILABLE';
  const alreadyWeb = state.toolCalls.some((call) => call.tool === 'getOfficialWebFallback');
  const skipWebForBooking =
    isCollectingBookingSlot(state.context) ||
    state.context.bookingStage === 'WAITING_CONFIRMATION' ||
    state.context.bookingStage === 'PASSENGER_DETAILS_REQUIRED';
  if (providerDown && !alreadyWeb && !skipWebForBooking && state.toolCalls.length < MAX_TOOLS_PER_TURN) {
    const web = await executeTool(
      state,
      'getOfficialWebFallback',
      { query: state.message.slice(0, 180), reason: lastBeforeWeb?.error?.code ?? 'UNAVAILABLE' },
      'SERVER',
    );
    const webData = dataOf<{ retrievedText: string; sourceTitle?: string | null }>(web);
    if (webData?.retrievedText && webData.retrievedText.length >= 40) {
      const title = webData.sourceTitle ? ` (${webData.sourceTitle})` : '';
      reply =
        `${webData.retrievedText.slice(0, 700)}\n` +
        `(Primary railway API se data nahi aaya. Verified official web${title} se — seats/fare/time invent nahi kiye.)`;
    }
  }

  const anyUsableData = state.toolResults.some((result) => result.ok && result.data !== null);
  const toolsFailedHonestly = state.toolResults.length > 0 && !anyUsableData;
  const lastTool = state.toolResults[state.toolResults.length - 1];
  const railwayFetchFailed = Boolean(
    lastTool &&
      (lastTool.unavailableReason === 'NO_RESULTS' ||
        lastTool.unavailableReason === 'NOT_FOUND' ||
        lastTool.error?.code === 'RAILWAY_DATA_UNAVAILABLE' ||
        lastTool.error?.code === 'RAILWAY_TIMEOUT' ||
        lastTool.error?.code === 'RAILWAY_CAPABILITY_UNSUPPORTED' ||
        lastTool.error?.code === 'INVALID_RAILWAY_QUERY'),
  );
  // No verified railway payload → never let NLU/template/AI invent trains/seats/times.
  if (toolsFailedHonestly && (options.factsFromTools === true || railwayFetchFailed || state.aiTimedOut)) {
    if (state.aiTimedOut || lastBeforeWeb?.error?.code === 'RAILWAY_TIMEOUT' || lastTool?.error?.code === 'RAILWAY_TIMEOUT') {
      reply = railwayFetchSlowReply();
    } else {
      reply = railwayUnavailableReply(lastTool!);
    }
  } else if (state.aiTimedOut && !anyUsableData && state.toolResults.length === 0 && intent === 'UNKNOWN') {
    reply = railwayFetchSlowReply();
  }

  // NVIDIA phrases every user-facing reply. Skip only when tools returned no
  // usable data (the model must not invent live status / trains / seats) or
  // when the provider is deterministic-nlu. usedFallbackNlu does NOT block
  // phrasing: NLU may classify; NVIDIA still speaks. Cards/chips/panels stay UI.
  const skipAi = toolsFailedHonestly || state.deps.ai.providerId === 'deterministic-nlu';
  if (!skipAi) {
    const narrated = await maybeAiReply(state, reply);
    if (narrated && aiReplySafeForFacts(narrated, state, reply) && aiReplyKeepsPendingAsk(narrated, state)) {
      reply = narrated;
      const winnerFromCard = state.cards?.length === 1 ? state.cards[0]!.number : null;
      const winnerFromDraft = templateReply.match(/WINNER:\s*(\d{4,5})/i)?.[1] ?? null;
      const winner = winnerFromCard ?? winnerFromDraft;
      if (winner && !new RegExp(`WINNER:\\s*${winner}\\b`, 'i').test(reply)) {
        reply = `${reply}\nWINNER: ${winner}`;
      }
    }
  }

  const resumeSuffix =
    state.context.pausedBooking && !['BOOK_TRAIN', 'SEARCH_TRAIN', 'UNKNOWN', 'HELP'].includes(intent)
      ? resumePromptSuffix(state.context)
      : '';
  reply = `${reply}${resumeSuffix}`;

  if (state.safetyRejections.length > 0) {
    reply = `${cannotDoThatReply()}\n${reply}`;
  }

  let context = updateConversationMeta(state.context, { lastIntent: intent, lastTool: state.toolCalls.at(-1)?.tool ?? null }, nowIso(state));
  context = addConversationMessage(context, { role: 'assistant', content: reply, intent }, nowIso(state));

  return {
    reply: sanitizeReplyText(reply),
    context,
    intent,
    usedFallbackNlu: options.usedFallbackNlu,
    executedTools: state.toolCalls.map((call) => call.tool),
    safetyRejections: state.safetyRejections,
    cards: state.cards,
    panel: state.panel,
    chips: state.chips,
    sourceClass: options.sourceClass ?? classifySource(intent, state.toolCalls.map((call) => call.tool), state.wasFollowUp),
  };
}

function nowIso(state: TurnState): string {
  return state.now.toISOString();
}

/** Invented 5-digit train numbers (not on the verified list) reject the AI prose. */
function aiReplySafeForList(text: string, results: readonly TrainSearchResult[], extraAllowed: readonly string[] = []): boolean {
  const listed = new Set<string>();
  const add = (raw: string) => {
    listed.add(raw);
    listed.add(raw.replace(/^0+/, '') || raw);
  };
  for (const entry of results) add(entry.train.number);
  for (const blob of extraAllowed) {
    for (const match of blob.matchAll(/\b(\d{5})\b/g)) add(match[1]!);
  }
  for (const match of text.matchAll(/\b(\d{5})\b/g)) {
    const n = match[1]!.replace(/^0+/, '') || match[1]!;
    if (!listed.has(n) && !listed.has(match[1]!)) return false;
  }
  return true;
}

/** Reject invented 5-digit trains; never turn a "does not halt" draft into seats. */
function aiReplySafeForFacts(text: string, state: TurnState, draft: string): boolean {
  if (!aiReplySafeForList(text, state.context.lastSearchResults ?? [], [state.message, draft])) {
    return false;
  }
  if (
    /does not (commercially )?halt|is station par rukti nahi|NAHI rukti|nahi rukti|does not stop/i.test(draft) &&
    /\b(WL|RAC|CNF|AVAILABLE|seats? available|seat available)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

function isCollectingBookingSlot(context: ConversationContext): boolean {
  const field = context.lastAskedField;
  return (
    field === 'passengerCount' ||
    field === 'waitlistConsent' ||
    field === 'selectedClass' ||
    field === 'journeyDate' ||
    isPassengerField(field)
  );
}

/** While we are collecting a booking slot, fare must not leak into the model's prompt. */
function toolResultsForNarration(state: TurnState): readonly ToolResult[] {
  if (!isCollectingBookingSlot(state.context) && !(state.context.passengerCount !== null && state.context.passengers.length < state.context.passengerCount)) {
    return state.toolResults;
  }
  return state.toolResults.filter((result) => result.tool !== 'getFare' && result.tool !== 'createBookingDraft');
}

/** NVIDIA must not jump to fare/review while a passenger/class question is pending. */
function aiReplyKeepsPendingAsk(text: string, state: TurnState): boolean {
  const asked = state.context.lastAskedField;
  if (!asked) return true;
  const fareDump = /₹\s*\d|Railway fare|Total:\s*₹|BOOKING REVIEW|total payable/i.test(text);
  if ((asked === 'passengerCount' || isPassengerField(asked) || asked === 'selectedClass' || asked === 'waitlistConsent') && fareDump) {
    return false;
  }
  if (isPassengerField(asked) && !/(naam|age|umar|gender|berth|\?|bataiye|batao)/i.test(text)) {
    return false;
  }
  if (asked === 'passengerCount' && !/(passenger|log|kitne|\?|1 se 6)/i.test(text)) {
    return false;
  }
  return true;
}

function parsePassengerCountAnswer(message: string): number | null {
  const trimmed = message.trim().toLowerCase().replace(/[?.!]+$/, '');
  if (/^[1-6]$/.test(trimmed)) return Number(trimmed);
  const words: Record<string, number> = {
    ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3,
    char: 4, chaar: 4, four: 4, panch: 5, paanch: 5, five: 5, chhe: 6, che: 6, six: 6,
  };
  if (words[trimmed] !== undefined) return words[trimmed]!;
  const tagged = trimmed.match(/^([1-6])\s*(passenger|passengers|log|ticket|tickets)?$/);
  if (tagged) return Number(tagged[1]);
  return null;
}

function parseCombinedPassenger(text: string): { name: string; age: number; gender: 'M' | 'F' | 'T' } | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(
    /^([A-Za-z][A-Za-z .]{1,39}?)[, ]+(\d{1,3})[, ]+(M|F|T|male|female|man|woman|ladka|ladki|purush|stree|trans)$/i,
  );
  if (!match) return null;
  const age = Number(match[2]);
  if (!Number.isInteger(age) || age < 1 || age > 120) return null;
  const token = match[3]!.toLowerCase();
  const gender: 'M' | 'F' | 'T' = /^(m|male|man|ladka|purush)$/.test(token)
    ? 'M'
    : /^(f|female|woman|ladki|stree)$/.test(token)
      ? 'F'
      : 'T';
  const name = match[1]!.replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z][A-Za-z .]{1,39}$/.test(name)) return null;
  return { name, age, gender };
}

/** Optional AI phrasing of a DATA-BACKED reply. Falls back to the template on any failure. */
async function maybeAiReply(state: TurnState, _templateReply: string): Promise<string | null> {
  try {
    const result = await withTimeout(
      state.deps.ai.generateResponse({ conversation: state.context, toolResults: toolResultsForNarration(state), tone: 'FRIENDLY', userMessage: state.message, draftReply: _templateReply }),
      state.deps.aiTimeoutMs ?? 6_000,
    );
    if (typeof result.message !== 'string' || result.message.trim().length < 5) return null;
    if (containsUrl(result.message)) return null; // AI prose may never hand out URLs
    if (/\|[-:\s|]+\|/.test(result.message) || /\|\s*Train/i.test(result.message)) return null;
    // Language gate: the product answers in Hinglish/Hindi (§18). Pure-English model
    // prose is replaced by the deterministic Hinglish template carrying the same facts.
    const hinglishOrHindi = /[\u0900-\u097F]/.test(result.message) || /\b(hai|hain|hain\?|nahi|nahin|kya|kaunsi|konsi|se|ke|ki|ko|chal|chahiye|batao|bataye|mili|milega|milegi|padega|padenge|lagenge|karun|karein|karo|yaar|bhai|matlab|train\s+mili|available\s+hai)\b/i.test(result.message);
    if (!hinglishOrHindi) return null;
    return result.message.slice(0, 1_000);
  } catch {
    return null; // template reply wins — no fabricated facts
  }
}

function sanitizeReplyText(text: string): string {
  // No URLs in replies (AI can never hand the user an endpoint), sane length.
  return containsUrl(text) ? text.replace(/https?:\/\/\S+/g, '[link removed]') : text.slice(0, 1_200);
}

// ── station resolution (names → codes only via the lookup tool) ─────────────

interface StationResolutionOutcome {
  station: Station | null;
  choiceNeeded: Station[] | null;
  error: string | null;
}

function userMentionedToken(message: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(message);
}

/** Drop model-invented codes the user never typed (DLI for "delhi") in favour of the literal city name. */
/** A bare junction/… suffix ("jn", "junction") is not a station — using it as a
 *  lookup query returns every "JN" station (the user's amritsar jn se ldh jn bug). */
const BARE_STATION_SUFFIX_QUERY = /^(jn\.?|jnc|junction|cantt\.?|cant|cantonment|terminus|terminal|cst|central|city)$/i;

function preferUserStationQuery(modelQuery: string | null, detQuery: string | null, userMessage: string): string | null {
  // User-typed station codes (ASR, LDH, NDLS) always beat a model-expanded city name.
  if (detQuery) {
    const typed = stationFromDirectInput(detQuery)?.station;
    if (typed && userMentionedToken(userMessage, typed.code)) {
      return typed.code;
    }
    // "amritsar jn" is more specific than a model-expanded "Amritsar".
    if (/\b(jn|junction|cantt|cant)\b/i.test(detQuery) && (!modelQuery || !/\b(jn|junction|cantt|cant)\b/i.test(modelQuery))) {
      return detQuery;
    }
  }
  if (modelQuery) {
    const inventedCode = stationFromDirectInput(modelQuery)?.station?.code;
    if (inventedCode && !userMentionedToken(userMessage, inventedCode)) {
      return detQuery;
    }
    // A bare station-type suffix is never a real station — trust the
    // deterministic read (which glues "amritsar jn"/"ldh jn" together).
    if (BARE_STATION_SUFFIX_QUERY.test(modelQuery.trim())) return detQuery;
    return modelQuery;
  }
  return detQuery;
}

async function resolveStation(state: TurnState, candidate: string | null): Promise<StationResolutionOutcome> {
  if (!candidate) return { station: null, choiceNeeded: null, error: null };
  const direct = stationFromDirectInput(candidate);
  // A code is only "user-typed" when it actually appears in THIS message (NDLS, ASR).
  // Model-invented DLI for "delhi" must go through real lookup so we can ask NDLS/DLI/NZM.
  if (direct?.station && userMentionedToken(state.message, direct.station.code)) {
    return { station: direct.station, choiceNeeded: null, error: null };
  }
  const lookupQuery = canonicalLookupQuery(candidate);
  const result = await executeTool(state, 'lookupStation', { query: lookupQuery });
  const stations = dataOf<Station[]>(result);
  if (stations && stations.length > 0) {
    // Classify against the USER's original phrase ("amritsar jn") so a JN/CANTT
    // suffix auto-picks that station. The provider query is still the stripped
    // canonical form (so we never look up a bare "jn").
    const lookup = stationFromLookup(candidate, stations);
    if (lookup.station) return { station: lookup.station, choiceNeeded: null, error: null };
    if (lookup.choiceNeeded) return { station: null, choiceNeeded: lookup.choiceNeeded, error: null };
  }
  return { station: null, choiceNeeded: null, error: stationResolveFailedReply(candidate) };
}

/** Ask the user WHICH station (§6) — never silently pick the first. */
async function askStationChoice(
  state: TurnState,
  field: 'origin' | 'destination',
  options: Station[],
  usedFallback: boolean,
  intent: Intent,
  originalInput?: string,
): Promise<OrchestratorTurn> {
  const unique: Station[] = [];
  const seen = new Set<string>();
  for (const station of collapseEquivalentStations(options)) {
    const code = station.code.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    unique.push(station);
  }
  // Step 10 — persist the VERIFIED candidates so the interrupted railway request
  // survives the clarification and can resume WITHOUT re-asking known slots.
  const original = originalInput ?? state.context[field === 'origin' ? 'origin' : 'destination']?.name ?? field;
  const pending: PendingStationResolution = {
    field,
    originalInput: original,
    candidates: unique.map((station) => toCandidate(station)),
    askedAt: nowIso(state),
  };
  state.context = {
    ...state.context,
    stationChoices: { field, options: unique, askedAt: nowIso(state) },
    pendingStationResolution: pending,
    lastAskedField: field,
    pendingQuestion: stationChoiceReply(field, unique),
    updatedAt: nowIso(state),
  };
  state.chips = unique.map((station) => (station.name ? `${station.code} — ${station.name}` : station.code));
  return finish(state, intent, stationChoiceReply(field, unique), { usedFallbackNlu: usedFallback });
}

/** §2: stage changes must be allowed by the deterministic machine — no AI jumps. */
function transitionStage(state: TurnState, to: ConversationContext['bookingStage']): void {
  const from = state.context.bookingStage;
  if (from === to || canTransitionTo(from, to)) {
    state.context = updateConversationMeta(state.context, { bookingStage: to }, nowIso(state));
  }
  // Not allowed → stay put (deterministic refusal, never an arbitrary jump).
}

/** STALE-RESULT INVALIDATION (§24): a changed route/date must not reuse old trains. */
function invalidateStaleResults(state: TurnState): void {
  const context = state.context;
  if (context.lastSearchResults && context.lastSearchResults.length > 0) {
    state.context = {
      ...context,
      lastSearchResults: [],
      selectedTrain: null,
      selectedClass: null,
      passengers: [],
      passengerDraft: null,
      lastAvailability: null,
      lastFareQuote: null,
      waitlistAccepted: false,
      bookingStage: 'COLLECT_JOURNEY',
      updatedAt: nowIso(state),
    };
  }
}

/** §12: a train/class change invalidates ONLY the dependent selections. */
function invalidateTrainSelection(state: TurnState): void {
  state.context = {
    ...state.context,
    selectedTrain: null,
    selectedClass: null,
    passengers: [],
    passengerDraft: null,
    lastAvailability: null,
    lastFareQuote: null,
    waitlistAccepted: false,
    updatedAt: nowIso(state),
  };
}

function invalidateClassSelection(state: TurnState): void {
  state.context = {
    ...state.context,
    selectedClass: null,
    passengers: [],
    passengerDraft: null,
    lastAvailability: null,
    lastFareQuote: null,
    waitlistAccepted: false,
    updatedAt: nowIso(state),
  };
}

// ── main entry ────────────────────────────────────────────────────────────────

export async function orchestrateTurn(
  deps: OrchestratorDependencies,
  incoming: ConversationContext,
  userMessage: string,
): Promise<OrchestratorTurn> {
  // ── MULTI-INTENT (§3): deterministic conservative split; informational parts
  // first, booking last, context threads through so nothing is lost. ──
  const segments = splitCompoundRequest(userMessage);
  if (segments && segments.length > 1) {
    let context = incoming;
    let combined = '';
    let cards: TrainCard[] | null = null;
    let panel: ChatPanel | null = null;
    let wasFollowUp = false;
    const executedTools: string[] = [];
    const safetyRejections: string[] = [];
    let usedFallbackNlu = false;
    let lastIntent: Intent = 'UNKNOWN';
    for (const segment of segments.slice(0, 3)) {
      const turn = await orchestrateTurn(deps, context, segment);
      context = turn.context;
      combined = combined.length > 0 ? `${combined}\n\n${turn.reply}` : turn.reply;
      cards = cards ?? turn.cards;
      panel = panel ?? turn.panel;
      wasFollowUp = wasFollowUp || turn.sourceClass === 'CONTEXTUAL_FOLLOWUP';
      executedTools.push(...turn.executedTools);
      safetyRejections.push(...turn.safetyRejections);
      usedFallbackNlu = usedFallbackNlu || turn.usedFallbackNlu;
      lastIntent = turn.intent;
    }
    void 0;
    return {
      reply: combined,
      context,
      intent: lastIntent,
      usedFallbackNlu,
      executedTools,
      safetyRejections,
      cards,
      panel,
      chips: null,
      // Compound questions that exercised multiple approved capabilities are
      // labelled MULTI_CAPABILITY_QUERY (the canonical UNIVERSAL class).
      sourceClass: wasFollowUp ? 'CONTEXTUAL_FOLLOWUP' : 'MULTI_CAPABILITY_QUERY',
    };
  }

  return orchestrateSingleTurn(deps, incoming, userMessage);
}

async function orchestrateSingleTurn(
  deps: OrchestratorDependencies,
  incoming: ConversationContext,
  userMessage: string,
): Promise<OrchestratorTurn> {
  const state: TurnState = {
    deps,
    now: (deps.now ? deps.now() : new Date()),
    message: userMessage,
    context: incoming,
    toolCalls: [],
    toolResults: [],
    safetyRejections: [],
    cards: null,
    panel: null,
    chips: null,
    wasFollowUp: false,
    filterHint: null,
    aiTimedOut: false,
  };
  state.context = addConversationMessage(state.context, { role: 'user', content: userMessage }, nowIso(state));

  let understood = await understand(deps, state.context, userMessage);
  // Hybrid robustness: a model sometimes returns UNKNOWN for corrections/fillers
  // during an active booking ("Nahi, Ludhiana se jaana hai"). The deterministic
  // NLU gets one shot at extracting structure before we give up. No fabrication:
  // it only extracts what the user literally said.
  // A model choice is "unactionable" when it needs a train but none is resolvable
  // from the message or context (e.g. GET_AVAILABILITY for "Kal ... 2 ticket chahiye").
  const dataIntentsNeedingTrain: readonly Intent[] = ['GET_AVAILABILITY', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'LIVE_TRAIN_STATUS'];
  const trainResolvable =
    understood.understanding?.slots.trainNumber !== null ||
    state.context.selectedTrain !== null ||
    state.context.lastReferencedTrain !== null;
  const hasJourneyWords = /\b(jaana|jana|jaaye|jaye|ticket|book|chahiye)\b/i.test(userMessage);
  const modelChoiceUnactionable =
    understood.understanding !== null &&
    dataIntentsNeedingTrain.includes(understood.understanding.intent) &&
    !trainResolvable &&
    hasJourneyWords;

  // A GENERAL answer is only trusted when the message is actually a concept
  // question ("CC kya hota hai?") — otherwise the model is guessing vocabulary.
  const messageLooksLikeConceptQuestion = /\b(kya hota|kya hai|matlab|meaning|what is|kaunsi class)\b/i.test(userMessage);
  // A LOOKUP_STATION choice for an explicit journey message ("Aaj ASR se LDH jaana
  // hai") is a misread — the deterministic extractor routes it as a booking journey.
  const modelMisreadJourney = understood.understanding?.intent === 'LOOKUP_STATION' && hasJourneyWords;

  const modelGaveStructureless =
    understood.understanding?.intent === 'UNKNOWN' ||
    (understood.understanding?.intent === 'GENERAL_RAILWAY_QUERY' && !messageLooksLikeConceptQuestion) ||
    modelChoiceUnactionable ||
    modelMisreadJourney;
  if (modelGaveStructureless && deps.fallbackNlu && deps.fallbackNlu.providerId !== deps.ai.providerId) {
    const deterministic = await deps.fallbackNlu.understand(buildUnderstandingInput(state.context, userMessage, aiToolCatalogue(deps)));
    const detValidated = validateUnderstanding(deps, deterministic);
    if (detValidated?.ok && detValidated.result) {
      const det = detValidated.result;
      const hasStructure =
        (det.intent !== 'UNKNOWN' && det.intent !== 'GENERAL_RAILWAY_QUERY') ||
        det.slots.originQuery !== null ||
        det.slots.destinationQuery !== null ||
        det.slots.dateText !== null ||
        det.slots.passengerCount !== null ||
        det.slots.trainNumber !== null ||
        det.slots.resultReference !== null ||
        det.slots.travelClass !== null ||
        det.slots.pnr !== null;
      if (hasStructure) {
        understood = { understanding: det, usedFallbackNlu: true, safetyRejections: understood.safetyRejections, aiTimedOut: understood.aiTimedOut };
      }
    }
  }
  state.safetyRejections.push(...understood.safetyRejections);
  state.aiTimedOut = understood.aiTimedOut === true;
  const understanding = understood.understanding;

  if (!understanding) {
    return finish(
      state,
      'UNKNOWN',
      state.aiTimedOut ? railwayFetchSlowReply() : rephraseReply(),
      { usedFallbackNlu: understood.usedFallbackNlu },
    );
  }

  const u = understanding;

  // ── Time-of-day filter: the AI (when a real model is running) reads it into a
  // structured hint on `understanding.searchFilter`. Reconcile that with what the
  // user literally said so the AI visibly participates in understanding the
  // filter but can never invent one it wasn't asked for. Deterministic
  // enforcement (applySearchFilter) still decides the actual list.
  state.filterHint = reconcileSearchFilter(userMessage, u.searchFilter ?? null);

  // ── Model-safety hardening (any remote model) ─────────────────────────────
  if (!understood.usedFallbackNlu && u && deps.fallbackNlu && deps.fallbackNlu.providerId !== deps.ai.providerId) {
    // (a) ANTI-HALLUCINATION: identifiers the model "found" must literally appear in
    //     the user's message (or come from known context) — invented ones are dropped.
    if (u.slots.pnr && !userMessage.includes(u.slots.pnr)) u.slots.pnr = null;
    const contextTrain = state.context.selectedTrain?.number ?? state.context.lastReferencedTrain?.number ?? null;
    if (u.slots.trainNumber && !userMessage.includes(u.slots.trainNumber) && u.slots.trainNumber !== contextTrain) {
      u.slots.trainNumber = null;
      u.slots.secondTrainNumber = null;
    }
    if (u.slots.dateText && !userMessage.toLowerCase().includes(String(u.slots.dateText).toLowerCase())) {
      u.slots.dateText = null; // the user never wrote this date expression (model translation/typo) — deterministic merge refills
    }

    // (a2) KEYWORD-INTENT GUARD: an explicit timetable / arrival-time keyword in
    //      the message wins over a sibling train-info choice. This is what routes
    //      "12014 kitne baje pahunchti hai?" to the timetable (the verified
    //      scheduled arrival) even when the model labels it GET_TRAIN_INFO.
    const STOPPAGE_TT = /\b(rukti hai|ruk(ta|ti|te|a)|rukte|kaha kaha rukti|stop(s|ped|s)?\s+(at|on|par)\b)\b/i;
    const ARRIVAL_TT = /\b(timetable|time\s*table|schedule|kitn[ei]?\s*(baje|bje|time|bajay)|kab\s+(pahunch|pahunchti|pahuch)|pahunch\s*(time|kab)|(pahunchi|pahunchti|pahuchi|pahuchti)\s*(thi|thae|gayi)?)/i;
    if (u.intent === 'GET_TRAIN_INFO' && (ARRIVAL_TT.test(userMessage) || STOPPAGE_TT.test(userMessage))) {
      u.intent = 'GET_TIMETABLE';
    } else if (
      u.intent === 'UNKNOWN' &&
      STOPPAGE_TT.test(userMessage) &&
      (u.slots.trainNumber || state.context.selectedTrain?.number || state.context.lastReferencedTrain?.number)
    ) {
      // "12053 Ludhiana rukti hai?" — the AI couldn't commit, but a train is named
      // and the language is clearly a stoppage check → route to the timetable.
      u.intent = 'GET_TIMETABLE';
    }

    // (b) LITERAL-SLOT MERGE: deterministic extraction fills ONLY slots the model
    //     left empty, strictly from what the user typed — it can never invent values.
    const det = await deps.fallbackNlu.understand(buildUnderstandingInput(state.context, userMessage, aiToolCatalogue(deps)));
    const detV = validateUnderstanding(deps, det);
    if (detV?.ok && detV.result) {
      const ds = detV.result.slots;
      if (u.slots.dateText === null && ds.dateText !== null) u.slots.dateText = ds.dateText;
      if (u.slots.passengerCount === null && ds.passengerCount !== null) u.slots.passengerCount = ds.passengerCount;
      if (u.slots.travelClass === null && ds.travelClass !== null) u.slots.travelClass = ds.travelClass;
      if (u.slots.pnr === null && ds.pnr !== null) u.slots.pnr = ds.pnr;
      if (u.slots.trainNumber === null && ds.trainNumber !== null) u.slots.trainNumber = ds.trainNumber;
      if (u.slots.secondTrainNumber === null && ds.secondTrainNumber !== null) u.slots.secondTrainNumber = ds.secondTrainNumber;
      if (u.slots.glossaryTerm === null && ds.glossaryTerm !== null) u.slots.glossaryTerm = ds.glossaryTerm;
      u.slots.originQuery = preferUserStationQuery(u.slots.originQuery, ds.originQuery, userMessage);
      u.slots.destinationQuery = preferUserStationQuery(u.slots.destinationQuery, ds.destinationQuery, userMessage);
    }
  }

    // §20 CONFIRMATION GATE at turn level: bare yes/no only counts with a pending review.
  const rawTrimmed = userMessage.trim();

  // Waitlist/RAC consent must beat the confirmation gate ("haan" is NOT a booking confirm).
  // Paused READ data-intent (availability/fare) — a route follow-up ("A se B")
  // must complete that SAME request, not become "samajh nahi paaya". Runs before
  // booking-change logic (which is booking-only) so it's authoritative here.
  {
    const dataRouteTurn = await handlePendingDataRoute(state, u, understood.usedFallbackNlu);
    if (dataRouteTurn) return dataRouteTurn;
  }

  if (state.context.lastAskedField === 'waitlistConsent') {
    const yes = /^(haan( ji)?|yes|y|ok(ay)?|confirm|book|kar do|kardo)[.!]?$/i.test(rawTrimmed);
    const no = /^(nahi(n)?|no|cancel|mat karo|rehne do)[.!]?$/i.test(rawTrimmed);
    if (yes) {
      state.context = { ...state.context, waitlistAccepted: true, updatedAt: nowIso(state) };
      state.context = updateConversationMeta(state.context, { lastAskedField: null, pendingQuestion: null }, nowIso(state));
      return continueBookingFlow(state, understood.usedFallbackNlu);
    }
    if (no) {
      const question = askClassNow(state);
      return finish(
        state,
        'BOOK_TRAIN',
        `Theek hai, waitlist/RAC pe book nahi karte. ${question}`,
        { usedFallbackNlu: understood.usedFallbackNlu },
      );
    }
  }

  // Pending passenger-count chips ("1"–"6") always fill the count — even if NVIDIA
  // labelled the tap as GET_FARE / UNKNOWN. Then we collect name/age/gender.
  if (state.context.lastAskedField === 'passengerCount') {
    const count = parsePassengerCountAnswer(userMessage) ?? u.slots.passengerCount;
    if (count !== null && count >= 1 && count <= 6) {
      return handleSlotFiller(
        state,
        u,
        { kind: 'passengerCount', value: count },
        understood.usedFallbackNlu,
        userMessage,
      );
    }
  }

  // Chips didn't render — re-offer the train's real classes instead of "samajh nahi".
  if (state.context.lastAskedField === 'selectedClass' && !u.slots.travelClass) {
    const chipComplaint = /chip|card pe|show nahi|nhi show|nahi show|dikha nahi|dikhai nahi|class nahi dikh|class nhi dikh/i.test(userMessage);
    if (chipComplaint) {
      const trainNumber =
        state.context.selectedTrain?.number ??
        state.context.lastReferencedTrain?.number ??
        state.context.pendingDataRoute?.trainNumber ??
        null;
      if (trainNumber) await ensureTrainClasses(state, trainNumber);
      const intent = state.context.lastIntent ?? state.context.pendingDataRoute?.intent ?? 'GET_AVAILABILITY';
      return finish(state, intent, askClassNow(state), { usedFallbackNlu: understood.usedFallbackNlu });
    }
  }

  // Mid-flow change ("2 nahi 3 passengers", "CC nahi SL") beats passenger-field capture.
  if (state.context.bookingStage !== 'IDLE') {
    const changeEarly = detectBookingChange(userMessage, state.context);
    if (changeEarly) {
      return applyBookingChange(state, changeEarly, understood.usedFallbackNlu);
    }
  }

  // Passenger chips ("M", "28", "lower") must never become NORMAL_CHAT / train-info.
  if (isPassengerField(state.context.lastAskedField)) {
    const words = rawTrimmed.split(/\s+/).filter(Boolean).length;
    const field = state.context.lastAskedField;
    const shortEnough = field === 'passengerName' ? words <= 8 : words <= 4;
    const looksLikeInterrupt = /\b(fare|price|live|status|change|badal|pnr|wallet|timetable)\b/i.test(userMessage);
    if (shortEnough && !looksLikeInterrupt) {
      return collectPassengerField(state, field, userMessage, understood.usedFallbackNlu);
    }
  }

  if (state.context.stationChoices) {
    const choice = resolveStationChoice(rawTrimmed, state.context.stationChoices.options);
    if (choice) {
      const filler: SlotFiller = { kind: 'station', value: choice.code };
      return handleSlotFiller(state, u, filler, understood.usedFallbackNlu, userMessage);
    }
  }

  const awaitingNow = isAwaitingBookingConfirmation(state.context);
  const bareYesTurn = awaitingNow
    ? (/^(haan|yes|y|ok|okay|confirm|confirmed|book)\b[^.?!]*$/.test(rawTrimmed) && !/\bnahi\b|^no\b/i.test(rawTrimmed))
    : /^(haan( ji)?|yes|y|ok(ay)?|confirm(ed)?|kar do|kardo|ho jaye|kar dijiye)[.!]?$/i.test(rawTrimmed);
  const bareNoTurn = /^(nahi(n)?|no|cancel|mat karo|rehne do)[.!]?$/i.test(rawTrimmed);
  if (bareYesTurn || bareNoTurn) {
    if (isAwaitingBookingConfirmation(state.context)) {
      return handleBookingConfirmation(state, userMessage, bareYesTurn, understood.usedFallbackNlu);
    }
    if (bareYesTurn) {
      return finish(state, 'UNKNOWN', notAwaitingConfirmationReply(), { usedFallbackNlu: understood.usedFallbackNlu });
    }
  }

  // While a search list is on screen, a train number / class is a BOOKING pick —
  // never GET_TRAIN_INFO / rephrase. ("14662", "14662 ka SL class", chip tap.)
  {
    const pick = await maybeHandleSearchSelection(state, u, understood.usedFallbackNlu, userMessage);
    if (pick) return pick;
  }

  // §X time-of-day REFINEMENT: a search list is on screen and the user narrows it
  // ("sirf morning", "4am se 6am ke beech"). Refine the SAME verified list — no new
  // search, no re-asking stations, the full list is never re-fetched. Runs before
  // the slot-filler/UNKNOWN early-return so a refinement is never misread.
  {
    const refinement = await maybeRefineSearchResults(state, u, understood.usedFallbackNlu);
    if (refinement) return refinement;
  }

  // §2/§11: natural follow-ups — "uska fare", "aur availability?", "CC mein?", "isme CC hai?"
  const followUp = resolveFollowUp(userMessage, state.context);
  if (followUp) {
    return routeFollowUp(state, followUp, understood.usedFallbackNlu);
  }

  if (
    (state.context.lastSearchResults?.length ?? 0) > 0 &&
    isVagueSeatRequest(userMessage) &&
    !u.slots.travelClass &&
    !u.slots.resultReference &&
    !(u.slots.trainNumber && userMessage.includes(u.slots.trainNumber)) &&
    (state.context.lastAskedField === 'selectedTrain' ||
      state.context.lastAskedField === 'selectedClass' ||
      state.context.bookingStage === 'SEARCH_RESULTS')
  ) {
    const hasTrain = state.context.selectedTrain !== null;
    if (hasTrain) {
      return finish(state, 'BOOK_TRAIN', askClassNow(state), { usedFallbackNlu: understood.usedFallbackNlu });
    }
    const question = 'Kaunsi train aur class chahiye? Train card pe class (jaise 3A, SL, CC) tap karein, ya "12014 mein 3A" type karein.';
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'selectedTrain', pendingQuestion: question },
      nowIso(state),
    );
    return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: understood.usedFallbackNlu });
  }

  // §13: a result-reference turn ("doosri wali") is a contextual follow-up, whichever
  // internal path resolves it.
  if (u?.slots.resultReference && (state.context.lastSearchResults?.length ?? 0) > 0) {
    state.wasFollowUp = true;
  }

  // Real-model robustness: an UNKNOWN intent that still carries journey entities
  // ("Ludhiana se jaana hai" without explicit intent) continues the booking flow.
  if (u.intent === 'UNKNOWN' && state.context.bookingStage !== 'IDLE' && (u.slots.originQuery || u.slots.destinationQuery)) {
    return handleJourney(state, { ...u, intent: 'BOOK_TRAIN' }, understood.usedFallbackNlu);
  }

  // Deterministic current-date answer — never a tool call, never a booking change.
  if (/\b(aaj ki date|aaj ki tareekh|aaj ki tarikh|today'?s date|what'?s (the )?date|what is the date|date kya hai)\b/i.test(userMessage)) {
    const today = state.now.toISOString().slice(0, 10);
    return finish(state, 'UNKNOWN', `Aaj ki date ${today} hai.`, { usedFallbackNlu: understood.usedFallbackNlu });
  }

  // UNIVERSAL ENGINE §7: deterministic duration "difference" question — "doosri
  // wali fastest se kitni slow hai?" — computed from the CURRENT verified list,
  // never estimated (missing durations → honest "can't say").
  const calculation = resolveTrainCalculation(state, userMessage);
  if (calculation) {
    if (calculation.trainNumber) rememberTrain(state, calculation.trainNumber);
    return finish(state, 'GET_TIMETABLE', calculation.reply, {
      usedFallbackNlu: understood.usedFallbackNlu,
      sourceClass: 'TRAIN_CALCULATION',
    });
  }

  // §9/§2: result-detail questions — "doosri wali kitni fast hai?" answered from the CURRENT list
  const resultDetail = resolveResultDetailQuestion(userMessage, state.context);
  if (resultDetail) {
    if (resultDetail.trainNumber) rememberTrain(state, resultDetail.trainNumber);
    return finish(state, resultDetail.intent, resultDetail.reply, { usedFallbackNlu: understood.usedFallbackNlu });
  }

  // Superlative / list-intelligence: NVIDIA phrases the answer; regex only gates
  // so GET_TIMETABLE / SEARCH_TRAIN misreads cannot dump the timetable or re-search.
  {
    const listIntel = await maybeAnswerListIntelligence(state, u, understood.usedFallbackNlu);
    if (listIntel) return listIntel;
  }

  // §15: "rukko" — hold the flow, change nothing
  if (/^(rukko|ruko|ruk jao|wait|hold|ruko zara)[.!]?$/i.test(userMessage.trim())) {
    const pending = state.context.pendingQuestion;
    return finish(state, 'UNKNOWN', `Theek hai, main yahin hoon.${pending ? ` Jab bolein: ${pending}` : ''}`, {
      usedFallbackNlu: understood.usedFallbackNlu,
    });
  }

  // §12/§22: mid-flow change requests ("train change karni hai", "12014 nahi 14542", "CC nahi SL")
  // run BEFORE any intent dispatch — the deterministic machine stays authoritative.
  if (state.context.bookingStage !== 'IDLE') {
    const change = detectBookingChange(userMessage, state.context);
    if (change) {
      return applyBookingChange(state, change, understood.usedFallbackNlu);
    }
  }

  // Correction continuation ("Delhi nahi, Chandigarh") while a journey flow is active.
  // (Date corrections like "nahi actually kal nahi parso" are handled at turn level below.)
  if (u.intent === 'UNKNOWN' && !u.slots.dateText && u.slots.isCorrection && u.slots.mentionedStations.length > 0 && state.context.bookingStage !== 'IDLE') {
    let context = state.context;
    if (context.pausedBooking) context = restorePausedBooking(context);
    const merged = mergeCorrection(context, u.slots.mentionedStations, u.slots.originQuery, u.slots.destinationQuery);
    state.context = merged.context;
    if (merged.changedFields.length > 0) {
      invalidateStaleResults(state); // §12/§22/§36: route change wipes train/class/passengers/fare
    }
    const askedStations = await resolvePlaceholderStations(state, 'BOOK_TRAIN', understood.usedFallbackNlu);
    if (askedStations) return askedStations;
    return finishJourney(state, 'BOOK_TRAIN', understood.usedFallbackNlu);
  }

    // FIX (user complaint): a SHORT message that directly answers the PENDING asked
    // field continues the booking flow EVEN IF the model labelled it as a data intent
    // (e.g. bare "CC" answered as GET_AVAILABILITY). The deterministic state machine
    // stays authoritative; extraction is literal-only, so nothing is invented.
    const askedNow = state.context.lastAskedField;
    const wordCount = userMessage.trim().split(/\s+/).filter(Boolean).length;
    const shortAnswer = isPassengerField(askedNow) ? wordCount <= 8 : wordCount <= 8;
    const answersAskedField =
      (askedNow === 'journeyDate' && u.slots.dateText !== null) ||
      (askedNow === 'passengerCount' && u.slots.passengerCount !== null) ||
      (askedNow === 'selectedClass' && u.slots.travelClass !== null) ||
      (askedNow === 'selectedTrain' && (u.slots.trainNumber !== null || u.slots.resultReference !== null || u.slots.travelClass !== null)) ||
      (askedNow !== null && isPassengerField(askedNow));
    const looksLikeDataQuery = /\b(live|status|fare|price|timetable|pnr|cancel|wallet|kaha|kahan|abhi)\b/i.test(userMessage);
    const looksLikeCompare = Boolean(u.slots.secondTrainNumber) || /\b(better|compare|vs|versus|fastest|tez)\b/i.test(userMessage);
    const looksLikeConcept = /\b(kya hota|kya hai|matlab|meaning|what is|kaunsi class|difference|antar|fark)\b/i.test(userMessage);
    if (shortAnswer && answersAskedField && !looksLikeDataQuery && !looksLikeCompare && !looksLikeConcept) {
      const filler = asSlotFiller(u, state.context, userMessage);
      if (filler) {
        return handleSlotFiller(state, u, filler, understood.usedFallbackNlu, userMessage);
      }
    }

  // UNIVERSAL ENGINE §9: "kaunsi best hai?" with no criteria → ask a short
  // clarification, never silently pick a winner. Explicit-basis queries
  // ("kaunsi tez hai") fall through to COMPARE_TRAINS below.
  if (bestClarificationNeeded(state, userMessage) && u.intent !== 'COMPARE_TRAINS') {
    return finish(
      state,
      'COMPARE_TRAINS',
      'Kis criteria par "best" chahiye — sabse tez, sabse pehle pahunch, ya sabse sasta fare? Bataiye, main current list se nikal doonga.',
      {
        usedFallbackNlu: understood.usedFallbackNlu,
        sourceClass: 'COMPARISON',
      },
    );
  }

  // Slot-filler turn (bare "kal" / "2" / "CC" / "pehli wali" / bare station)?
  if (u.intent === 'UNKNOWN' || (u.intent === 'BOOK_TRAIN' && isSelectionOrFiller(u, userMessage))) {
    // §24 DATE CORRECTION at turn level: "nahi actually kal nahi parso".
    if (u.slots.isCorrection && u.slots.dateText && state.context.journeyDate && state.context.bookingStage !== 'IDLE') {
      const corrected = resolveDateText(u.slots.dateText, state.now);
      if (corrected && corrected !== state.context.journeyDate) {
        state.context = setContextSlots(state.context, { journeyDate: corrected }, 'CORRECT', nowIso(state));
        invalidateStaleResults(state);
        if (state.context.pausedBooking) state.context = restorePausedBooking(state.context);
        return finishJourney(state, 'BOOK_TRAIN', understood.usedFallbackNlu);
      }
    }

    // Pending station disambiguation resolves ANY short reply ("New Delhi", "doosra", "NZM").
    if (state.context.stationChoices) {
      const fillerForChoice = asSlotFiller(u, state.context, userMessage);
      return handleSlotFiller(state, u, fillerForChoice ?? { kind: 'station', value: rawTrimmed }, understood.usedFallbackNlu, userMessage);
    }

    // A model/deterministic UNKNOWN that names a CONCEPT QUESTION ("CC kya hota hai?")
    // → knowledge path. A bare class ("CC") answering a pending class question is NOT this.
    const dispatchIsConceptQuestion = /\b(kya hot[ai]|kya hai|matlab|meaning|what is|difference|antar|fark|kya hote hain)\b/i.test(userMessage);
    if (u.slots.glossaryTerm && dispatchIsConceptQuestion) {
      return handleGlossary(state, { ...u, intent: 'GENERAL_RAILWAY_QUERY' }, understood.usedFallbackNlu);
    }
    const filler = asSlotFiller(u, state.context, userMessage);
    if (filler) {
      return handleSlotFiller(state, u, filler, understood.usedFallbackNlu, userMessage);
    }
    if (u.intent === 'UNKNOWN') {
      return finish(state, 'UNKNOWN', rephraseReply(), { usedFallbackNlu: understood.usedFallbackNlu });
    }
  }

  // Class/train pick from current results must not fall through to GET_AVAILABILITY.
  {
    const pickingFromResults =
      (state.context.lastSearchResults?.length ?? 0) > 0 &&
      Boolean(u.slots.travelClass || u.slots.resultReference || (u.slots.trainNumber && userMessage.includes(u.slots.trainNumber))) &&
      !u.slots.originQuery &&
      !u.slots.destinationQuery &&
      !u.slots.secondTrainNumber &&
      ([...userMessage.matchAll(/\b(\d{4,5})\b/g)].length < 2);
    const explicitAvail =
      (/\b(available|availability|milegi|milega|waitlist|\bwl\b)\b/i.test(userMessage) ||
        (/\b(seat|seats)\b/i.test(userMessage) && /\b(hai|hain|kya)\b/i.test(userMessage))) &&
      !/\bchahiye\b/i.test(userMessage);
    if (pickingFromResults && !explicitAvail && !isExplicitTrainDataQuery(userMessage) && !looksLikeConcept && (u.intent === 'GET_AVAILABILITY' || u.intent === 'BOOK_TRAIN' || u.intent === 'SEARCH_TRAIN' || u.intent === 'GET_TRAIN_INFO' || u.intent === 'GET_FARE' || u.intent === 'GET_TIMETABLE' || u.intent === 'LIVE_TRAIN_STATUS')) {
      const filler = asSlotFiller(u, state.context, userMessage);
      if (filler) {
        return handleSlotFiller(state, u, filler, understood.usedFallbackNlu, userMessage);
      }
    }
  }

  // ── AI TOOL AGENT (primary autonomous path) ────────────────────────────────
  // The model (when a real LLM is running and NOT using fallback) may request a
  // concrete railway tool/API. If it did, honour it: execute through the safe
  // ToolGate/ToolExecutor/ProviderRouter and render from the VERIFIED result.
  // Deterministic routing is only reached when the AI gave no tool request
  // (or the turn needs booking flow, which stays deterministic for station
  // resolution + money safety).
  if (!understood.usedFallbackNlu) {
    const aiToolTurn = await maybeHandleAiToolRequest(state, u, understood.usedFallbackNlu);
    if (aiToolTurn) return aiToolTurn;
  }

  switch (u.intent) {
    case 'HELP':
      return finish(state, 'HELP', isGreetingMessage(state.message) ? greetingReply() : helpReply(), { usedFallbackNlu: understood.usedFallbackNlu });
    case 'GENERAL_RAILWAY_QUERY':
      return handleGlossary(state, u, understood.usedFallbackNlu);
    case 'NORMAL_CHAT':
      await maybePauseForInterruption(state, 'NORMAL_CHAT');
      return finish(
        state,
        'NORMAL_CHAT',
        'Main BookKaro hoon — railway assistant 🚆 Weather, cricket ya general topics mere scope mein nahi. Trains, live status, fare, availability, PNR, booking — bataiye kya chahiye?',
        { usedFallbackNlu: understood.usedFallbackNlu },
      );
    case 'BOOK_TRAIN':
    case 'SEARCH_TRAIN':
      return handleJourney(state, u, understood.usedFallbackNlu);
    case 'LIVE_TRAIN_STATUS':
      return handleLiveStatus(state, u, understood.usedFallbackNlu);
    case 'GET_AVAILABILITY':
      return handleAvailability(state, u, understood.usedFallbackNlu);
    case 'GET_FARE':
      return handleFare(state, u, understood.usedFallbackNlu);
    case 'GET_TIMETABLE':
      return handleSimpleTrainTool(state, u, 'getTimetable', 'timetableReplyKey', understood.usedFallbackNlu);
    case 'GET_TRAIN_INFO':
      return handleSimpleTrainTool(state, u, 'getTrainInfo', 'trainInfoReplyKey', understood.usedFallbackNlu);
    case 'CHECK_PNR':
      return handlePnr(state, u, understood.usedFallbackNlu);
    case 'VIEW_BOOKINGS':
      return handleBookings(state, u, understood.usedFallbackNlu);
    case 'VIEW_WALLET':
      return handleWallet(state, u, understood.usedFallbackNlu);
    case 'GET_CANCELLED_TRAINS':
      return handleCancelled(state, u, understood.usedFallbackNlu);
    case 'COMPARE_TRAINS':
      return handleComparison(state, u, understood.usedFallbackNlu);
    case 'LOOKUP_STATION':
      return handleStationLookup(state, u, understood.usedFallbackNlu);
    default:
      return finish(state, 'UNKNOWN', rephraseReply(), { usedFallbackNlu: understood.usedFallbackNlu });
  }
}

function helpReply(): string {
  return [
    'Main BookKaro hoon 🚆 — ye sab kar sakta hoon:',
    '• "Mujhe Amritsar se Ludhiana jaana hai" — journey planning (date ke liye poochunga)',
    '• "12014 ka live status batao" — live running status',
    '• "12014 mein CC mein seat hai?" — availability',
    '• "Fare kitna hai?" — fare (provider se hi)',
    '• "PNR check karo" — PNR status',
    '• "12014 ka timetable / info" — schedule & details',
    '• "CC kya hota hai?" — railway concepts',
    'Railway facts sirf real provider data se deta hoon — andaza nahi.',
  ].join('\n');
}

/**
 * AI TOOL AGENT (primary autonomous). When a real model returns a valid
 * `toolRequest` for a single-call READ railway tool, we execute it through the
 * safe ToolGate/ToolExecutor/ProviderRouter and render from the VERIFIED result.
 *
 * Guardrails retained:
 *  - only single-call READ/fetch tools (no multi-step booking, no money writes);
 *  - the tool is re-validated against the registry (unregistered/protected are
 *    rejected earlier by validateAIUnderstanding);
 *  - we never invent data — we render only the provider-verified fields, and say
 *    "unavailable" when the provider returned nothing usable.
 *
 * Returns an OrchestratorTurn when the AI's tool request was honoured; null when
 * the turn should fall through to deterministic routing (no request, or a booking
 * journey that needs station resolution).
 */
async function maybeHandleAiToolRequest(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn | null> {
  const toolRequest = u.toolRequest;
  if (!toolRequest) return null;
  // A pending passenger/class/count answer is NOT a fare/availability fetch.
  // NVIDIA must not steal "1" / "Rahul" into getFare.
  const explicitFareOrAvail = /\b(fare|price|kiraya|available|availability|milegi|waitlist)\b/i.test(state.message);
  if (
    isCollectingBookingSlot(state.context) &&
    !explicitFareOrAvail &&
    (toolRequest.tool === 'getFare' || toolRequest.tool === 'getAvailability' || toolRequest.tool === 'searchTrains')
  ) {
    return null;
  }
  // Booking flows need origin/destination/date resolution + multi-turn safety —
  // those stay on the deterministic journey path (the AI still supplies slots).
  // Multi-step comparison also stays deterministic (uses stored results).
  if (u.intent === 'BOOK_TRAIN' || u.intent === 'SEARCH_TRAIN' || u.intent === 'COMPARE_TRAINS') return null;
  // Only single-call READ tools are allowed here (money-safe by construction).
  const READ_TOOL_INTENT: Record<string, Intent> = {
    getLiveStatus: 'LIVE_TRAIN_STATUS',
    getAvailability: 'GET_AVAILABILITY',
    getFare: 'GET_FARE',
    getTimetable: 'GET_TIMETABLE',
    getTrainInfo: 'GET_TRAIN_INFO',
    checkPNR: 'CHECK_PNR',
    getCancelledTrains: 'GET_CANCELLED_TRAINS',
    getBookings: 'VIEW_BOOKINGS',
    getWallet: 'VIEW_WALLET',
    lookupStation: 'LOOKUP_STATION',
    getRailwayKnowledge: 'GENERAL_RAILWAY_QUERY',
    searchTrains: 'BOOK_TRAIN',
  };
  const intent = READ_TOOL_INTENT[toolRequest.tool];
  if (!intent || intent === 'BOOK_TRAIN') return null; // booking stays deterministic

  // Availability/fare need a route (origin+destination). If it's missing, ask for
  // it AND persist the snapshot so the follow-up ("A se B") completes the SAME
  // request — instead of executing with empty endpoints and falling to UNKNOWN.
  if ((toolRequest.tool === 'getAvailability' || toolRequest.tool === 'getFare') && (!state.context.origin?.code || !state.context.destination?.code)) {
    const trainNumber = resolveTurnTrainNumber(u, state.context);
    if (trainNumber) {
      const dataIntent = toolRequest.tool === 'getAvailability' ? 'GET_AVAILABILITY' : 'GET_FARE';
      const resolved = await snapshotAndMaybeResolveDataRoute(state, u, usedFallback, dataIntent, trainNumber);
      if (resolved) return resolved;
      return finish(state, intent as Intent, toolRequest.tool === 'getAvailability'
        ? 'Kis route ke liye availability chahiye? (jaise: Amritsar se Ludhiana)'
        : 'Kis route ka fare chahiye? (jaise: Amritsar se Ludhiana)', { usedFallbackNlu: usedFallback });
    }
  }

  if ((toolRequest.tool === 'getAvailability' || toolRequest.tool === 'getFare') && state.context.origin?.code && state.context.destination?.code) {
    const trainNumber = resolveTurnTrainNumber(u, state.context);
    if (trainNumber) {
      const blocked = await refuseIfTrainSkipsSegment(
        state,
        trainNumber,
        state.context.origin.code,
        state.context.destination.code,
        intent as Intent,
        usedFallback,
      );
      if (blocked) return blocked;
    }
  }

  // Never execute availability without a class — offer the train's API classes as chips.
  if (toolRequest.tool === 'getAvailability') {
    const trainNumber = resolveTurnTrainNumber(u, state.context);
    const travelClass = u.slots.travelClass ?? state.context.selectedClass;
    if (trainNumber && !travelClass && state.context.origin?.code && state.context.destination?.code) {
      const journeyDate = (u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null) ?? state.context.journeyDate;
      if (!journeyDate) {
        snapshotPendingDataRoute(state, u, 'GET_AVAILABILITY', trainNumber);
        state.context = updateConversationMeta(
          state.context,
          { lastAskedField: 'journeyDate', pendingQuestion: 'Kis date ke liye availability chahiye? (aaj/kal/parso ya date)' },
          nowIso(state),
        );
        return finish(state, 'GET_AVAILABILITY', 'Kis date ke liye availability chahiye? (aaj/kal/parso ya date)', { usedFallbackNlu: usedFallback });
      }
      snapshotPendingDataRoute(state, u, 'GET_AVAILABILITY', trainNumber);
      await ensureTrainClasses(state, trainNumber);
      return finish(state, 'GET_AVAILABILITY', askClassNow(state), { usedFallbackNlu: usedFallback });
    }
  }

  const input = buildAiToolInput(toolRequest.tool, toolRequest.input ?? {}, u, state);
  const result = await executeTool(state, toolRequest.tool, input);
  const intentNow = intent as Intent;
  let reply = renderAiToolReply(toolRequest.tool, result, intentNow);
  // Stoppage ("does train X stop at Y?") answered from the REAL stops — works on
  // the AI-requested-tool path too, not only the deterministic routing path.
  // This deterministic answer is the FALLBACK; when the AI is primary it may
  // phrase the reply itself from the verified data (guarded, never invented).
  if (toolRequest.tool === 'getTimetable' && isStoppageQuestion(state.message)) {
    const timetable = dataOf<Timetable>(result);
    if (timetable) {
      reply = stoppageReply(u, state.message, timetable, timetable.trainNumber ?? String(input.trainNumber ?? ''));
    }
  }
  // AI-reasoning autonomy on the AI-requested-tool path: for "reasoning" reads
  // the AI phrases the verified-data answer (guarded); precise-list reads
  // (wallet, bookings, station lookup, knowledge) keep the deterministic
  // template. Either way the template below is the safe fallback.
  const AI_NARRATABLE_READ = new Set<string>([
    'getTimetable', 'getTrainInfo', 'getLiveStatus', 'getAvailability', 'getFare', 'checkPNR', 'getCancelledTrains',
  ]);
  const factsFromTools = AI_NARRATABLE_READ.has(toolRequest.tool);
  return finish(state, intentNow, reply, { factsFromTools, usedFallbackNlu: usedFallback });
}

/** Normalize the AI's tool input (user-literal or model keys) to the executor's canonical arg names. */
function buildAiToolInput(
  tool: ToolName,
  aiInput: Record<string, unknown>,
  u: AIUnderstandingResult,
  state: TurnState,
): Record<string, unknown> {
  const s = (key: string): string | null => {
    const v = aiInput[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };
  const ctx = state.context;
  const dateText =
    s('journeyDate') ?? s('date') ?? (u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null) ?? ctx.journeyDate ?? null;
  const trainNumber = s('trainNumber') ?? s('train') ?? ctx.selectedTrain?.number ?? ctx.lastReferencedTrain?.number ?? null;
  const originCode = s('originCode') ?? s('from') ?? s('origin') ?? ctx.origin?.code ?? null;
  const destinationCode = s('destinationCode') ?? s('to') ?? s('destination') ?? ctx.destination?.code ?? null;
  const travelClass = (s('travelClass') ?? s('class') ?? u.slots.travelClass ?? ctx.selectedClass ?? null)?.toUpperCase() ?? null;
  const generic: Record<string, unknown> = {};
  for (const key of Object.keys(aiInput)) {
    if (['from', 'to', 'origin', 'destination', 'date', 'train'].includes(key)) continue; // alias keys already mapped
    generic[key] = aiInput[key];
  }
  void generic;
  switch (tool) {
    case 'getLiveStatus':
      return { trainNumber: trainNumber ?? '', ...(dateText ? { journeyDate: dateText } : {}) };
    case 'getAvailability':
      return {
        trainNumber: trainNumber ?? '',
        journeyDate: dateText ?? '',
        travelClass: travelClass ?? undefined,
        fromStationCode: originCode?.toUpperCase() ?? undefined,
        toStationCode: destinationCode?.toUpperCase() ?? undefined,
      };
    case 'getFare':
      return {
        trainNumber: trainNumber ?? '',
        fromStationCode: originCode?.toUpperCase() ?? undefined,
        toStationCode: destinationCode?.toUpperCase() ?? undefined,
        ...(dateText ? { journeyDate: dateText } : {}),
        ...(travelClass ? { travelClass } : {}),
      };
    case 'getTimetable':
    case 'getTrainInfo':
      return { trainNumber: trainNumber ?? '' };
    case 'checkPNR':
      return { pnr: s('pnr') ?? '' };
    case 'getCancelledTrains':
      return { journeyDate: dateText ?? '' };
    case 'getBookings':
    case 'getWallet':
      return {};
    case 'lookupStation':
      return { query: s('query') ?? s('station') ?? s('name') ?? originCode ?? '' };
    case 'getRailwayKnowledge':
      return { query: state.message.slice(0, 120) };
    default:
      return inputArg(tool, aiInput);
  }
}

/** Last-resort: pass through the AI's own keys (the executor's validateToolArguments still runs). */
function inputArg(_tool: ToolName, aiInput: Record<string, unknown>): Record<string, unknown> {
  return { ...aiInput };
}

/** Render an AI-executed tool result from VERIFIED provider fields (never invented). */
function renderAiToolReply(tool: ToolName, result: ToolResult, intent: Intent): string {
  const unavailable = railwayUnavailableReply(result);
  switch (tool) {
    case 'getLiveStatus':
      return dataOf<LiveStatus>(result) ? liveStatusReply(dataOf<LiveStatus>(result)!) : unavailable;
    case 'getAvailability':
      return dataOf<Availability>(result) ? availabilityReply(dataOf<Availability>(result)!) : unavailable;
    case 'getFare':
      return dataOf<Fare>(result) ? fareReply(dataOf<Fare>(result)!) : unavailable;
    case 'getTimetable':
      return dataOf<Timetable>(result) ? timetableReply(dataOf<Timetable>(result)!) : unavailable;
    case 'getTrainInfo':
      return dataOf<Train>(result) ? trainInfoReply(dataOf<Train>(result)!) : unavailable;
    case 'checkPNR':
      return dataOf<PNRStatus>(result) ? pnrReply(dataOf<PNRStatus>(result)!) : unavailable;
    case 'getCancelledTrains':
      return dataOf<CancelledTrain[]>(result) ? cancelledReply(dataOf<CancelledTrain[]>(result)!) : unavailable;
    case 'getBookings':
      return dataOf<unknown[]>(result) ? bookingsReply(dataOf<unknown[]>(result)!) : unavailable;
    case 'getWallet':
      return dataOf(result) ? walletReply(result) : unavailable;
    case 'lookupStation':
      return dataOf<Station[]>(result) ? stationsReply(dataOf<Station[]>(result)!) : unavailable;
    case 'getRailwayKnowledge':
      return dataOf<{ retrievedText: string }>(result)
        ? `${dataOf<{ retrievedText: string }>(result)!.retrievedText.slice(0, 700)}\\n(Generic concept — live data ke liye train ke saath poochhiye.)`
        : unavailable;
    default:
      return intent === 'GET_TIMETABLE' || intent === 'GET_TRAIN_INFO' ? unavailable : unavailable;
  }
}

// ── glossary (GENERAL knowledge, never live data) ────────────────────────────

async function handleGlossary(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'GENERAL_RAILWAY_QUERY'); // §4: general Q during booking → answer, then resume
  // Step 9 official-source config: RULE-SENSITIVE topics (tatkal timings, refund rules,
  // quota codes, railway rules) are answered ONLY from official retrieval — the static
  // glossary is never used for them (policy can change; no model-memory answers).
  if (RULE_SENSITIVE_QUERY.test(state.message)) {
    const officialResult = await executeTool(state, 'getRailwayKnowledge', { query: state.message.slice(0, 120) });
    const official = dataOf<{ source: string; sourceTitle: string | null; sourceUrl: string | null; retrievedText: string }>(officialResult);
    if (official) {
      const reply = `${official.retrievedText.slice(0, 700)}\n(Source: ${official.sourceTitle ?? 'official railway source'})\n(Generic concept — live data ke liye train ke saath poochhiye.)`;
      return finish(state, 'GENERAL_RAILWAY_QUERY', reply, { usedFallbackNlu: usedFallback });
    }
    return finish(state, 'GENERAL_RAILWAY_QUERY', HONEST_UNAVAILABLE_MESSAGE, { usedFallbackNlu: usedFallback });
  }
  // Step 9 §10: deterministic approved knowledge FIRST (single term, "X aur Y" difference, coach types…)
  const composed = composeKnowledgeAnswer(state.message) ?? composeKnowledgeAnswer(u.slots.glossaryTerm);
  if (composed) {
    const reply = `${composed.answer}\n(Generic concept — live fare/availability ke liye train ke saath poochhiye.)`;
    return finish(state, 'GENERAL_RAILWAY_QUERY', reply, { usedFallbackNlu: usedFallback });
  }
  // Glossary miss → restricted railway_knowledge capability (allowlisted official web only).
  const knowledgeResult = await executeTool(state, 'getRailwayKnowledge', { query: state.message.slice(0, 120) });
  const knowledge = dataOf<{ source: string; title: string | null; url: string | null; retrievedText: string }>(knowledgeResult);
  if (knowledge) {
    const reply = `${knowledge.retrievedText.slice(0, 700)}${knowledge.source === 'web' ? `\n(Source: approved railway knowledge)` : ''}\n(Generic concept — live data ke liye train ke saath poochhiye.)`;
    return finish(state, 'GENERAL_RAILWAY_QUERY', reply, { usedFallbackNlu: usedFallback });
  }
  return finish(
    state,
    'GENERAL_RAILWAY_QUERY',
    'Ye concept abhi approved railway knowledge se available nahi hai — main guess nahi karunga. Live cheezein (fare/seat/status) toh main providers se hi laata hoon.',
    { usedFallbackNlu: usedFallback },
  );
}

// ── journey flow (BOOK_TRAIN / SEARCH_TRAIN) ────────────────────────────────

async function handleJourney(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  // Belt-and-suspenders: a SEARCH_TRAIN/BOOK_TRAIN misread of "sabse fast" must not re-search.
  if ((state.context.lastSearchResults?.length ?? 0) >= 2 && detectComparisonRequest(state.message) && !namesNewRouteThisTurn(state.message)) {
    const typed = [...state.message.matchAll(/\b(\d{4,5})\b/g)].map((match) => match[1]!);
    if (typed.length < 2) return answerListSuperlative(state, usedFallback);
  }

  let context = state.context;

  // Time-of-day/window filter ("subah/morning", "4-6am"). The search often runs
  // only AFTER station + date disambiguation, so we persist the filter from the
  // ORIGINAL journey message; finishJourney applies it to the cards. The hint was
  // already reconciled from the AI's reading by orchestrateSingleTurn.
  const journeyFilter = state.filterHint;
  if (journeyFilter) {
    context = { ...context, pendingSearchFilter: journeyFilter, updatedAt: nowIso(state) };
  }

  // Interruption bookkeeping: if a DIFFERENT flow is running and this is a fresh journey, pause nothing (journey replaces). If we were paused and user resumes with journey words, restore first.
  if (context.pausedBooking && (u.slots.originQuery || u.slots.destinationQuery || u.slots.dateText)) {
    context = restorePausedBooking(context);
  }

  if (context.bookingStage === 'IDLE') {
    context = updateConversationMeta(context, { bookingStage: 'COLLECT_JOURNEY' }, nowIso(state));
  }

  // corrections first
  if (u.slots.isCorrection && u.slots.mentionedStations.length > 0) {
    const merged = mergeCorrection(context, u.slots.mentionedStations, u.slots.originQuery, u.slots.destinationQuery);
    if (merged.changedFields.length > 0) {
      state.context = merged.context;
      invalidateStaleResults(state);
      context = state.context;
    } else {
      context = merged.context;
    }
  }

  // DATE / extras BEFORE any station-choice early-return so "kal" is never dropped.
  if (u.slots.isCorrection && u.slots.dateText && context.journeyDate) {
    const corrected = resolveDateText(u.slots.dateText, state.now);
    if (corrected && corrected !== context.journeyDate) {
      context = setContextSlots(context, { journeyDate: corrected }, 'CORRECT', nowIso(state));
      state.context = context;
      invalidateStaleResults(state);
      context = state.context;
    }
  }
  if (u.slots.dateText && !context.journeyDate) {
    const resolvedDate = resolveDateText(u.slots.dateText, state.now);
    if (resolvedDate) context = setContextSlots(context, { journeyDate: resolvedDate }, 'FILL_MISSING', nowIso(state));
  }
  if (u.slots.passengerCount && !context.passengerCount) {
    context = setContextSlots(context, { passengerCount: u.slots.passengerCount }, 'FILL_MISSING', nowIso(state));
  }
  if (u.slots.travelClass && !context.selectedClass) {
    context = setContextSlots(context, { selectedClass: u.slots.travelClass }, 'FILL_MISSING', nowIso(state));
  }

  if (!(u.slots.isCorrection && u.slots.mentionedStations.length > 0)) {
    // fill origin/destination (resolve names → codes via the lookup tool);
    // a RE-STATED different station is a correction (§24) — update + invalidate stale results
    if (u.slots.originQuery) {
      const resolved = await resolveStation(state, u.slots.originQuery);
      if (resolved.choiceNeeded) {
        if (!context.destination && u.slots.destinationQuery) {
          context = setContextSlots(context, { destination: stationForCandidate(u.slots.destinationQuery) }, 'FILL_MISSING', nowIso(state));
        }
        state.context = context;
        return askStationChoice(state, 'origin', resolved.choiceNeeded, usedFallback, u.intent, u.slots.originQuery);
      }
      if (resolved.station) {
        const existing = context.origin?.code ?? null;
        const differs = existing !== null && existing !== resolved.station.code;
        context = setContextSlots(context, { origin: resolved.station }, differs ? 'CORRECT' : 'FILL_MISSING', nowIso(state));
        state.context = context;
        if (differs) invalidateStaleResults(state);
        context = state.context;
      } else if (!context.origin) {
        state.context = context;
        return finish(state, u.intent, resolved.error ?? stationResolveFailedReply(u.slots.originQuery), { usedFallbackNlu: usedFallback });
      }
    }
    if (u.slots.destinationQuery) {
      const resolved = await resolveStation(state, u.slots.destinationQuery);
      if (resolved.choiceNeeded) {
        if (!context.origin && u.slots.originQuery) {
          context = setContextSlots(context, { origin: stationForCandidate(u.slots.originQuery) }, 'FILL_MISSING', nowIso(state));
        }
        state.context = context;
        return askStationChoice(state, 'destination', resolved.choiceNeeded, usedFallback, u.intent, u.slots.destinationQuery);
      }
      if (resolved.station) {
        const existing = context.destination?.code ?? null;
        const differs = existing !== null && existing !== resolved.station.code;
        context = setContextSlots(context, { destination: resolved.station }, differs ? 'CORRECT' : 'FILL_MISSING', nowIso(state));
        state.context = context;
        if (differs) invalidateStaleResults(state);
        context = state.context;
      } else if (!context.destination) {
        state.context = context;
        return finish(state, u.intent, resolved.error ?? stationResolveFailedReply(u.slots.destinationQuery), { usedFallbackNlu: usedFallback });
      }
    }
    context = { ...context, stationChoices: null, pendingStationResolution: null };
  }

  state.context = context;
  const askedStations = await resolvePlaceholderStations(state, u.intent, usedFallback);
  if (askedStations) return askedStations;
  return finishJourney(state, u.intent, usedFallback);
}

/** Names captured from corrections/placeholders get their codes from the lookup tool before any search. */
async function resolvePlaceholderStations(state: TurnState, intent: Intent, usedFallback: boolean): Promise<OrchestratorTurn | null> {
  const origin = state.context.origin;
  if (origin && !origin.code && origin.name) {
    const resolved = await resolveStation(state, origin.name);
    if (resolved.choiceNeeded) return askStationChoice(state, 'origin', resolved.choiceNeeded, usedFallback, intent, origin.name);
    if (resolved.station) {
      state.context = setContextSlots(state.context, { origin: resolved.station }, 'CORRECT', nowIso(state));
    } else {
      return finish(state, intent, resolved.error ?? stationResolveFailedReply(origin.name), { usedFallbackNlu: usedFallback });
    }
  }
  const destination = state.context.destination;
  if (destination && !destination.code && destination.name) {
    const resolved = await resolveStation(state, destination.name);
    if (resolved.choiceNeeded) return askStationChoice(state, 'destination', resolved.choiceNeeded, usedFallback, intent, destination.name);
    if (resolved.station) {
      state.context = setContextSlots(state.context, { destination: resolved.station }, 'CORRECT', nowIso(state));
    } else {
      return finish(state, intent, resolved.error ?? stationResolveFailedReply(destination.name), { usedFallbackNlu: usedFallback });
    }
  }
  return null;
}

/** Shared journey tail: ask the NEXT missing field only, or run the search. */
async function finishJourney(state: TurnState, intent: Intent, usedFallback: boolean): Promise<OrchestratorTurn> {
  const context = state.context;
  const missing = missingJourneyFields(context);
  if (missing.length > 0) {
    const askField: ContextSlotField = missing[0]!;
    state.context = updateConversationMeta(
      context,
      { lastAskedField: askField, pendingQuestion: askForField(askField) },
      nowIso(state),
    );
    if (/(fastest|sabse tez|jaldi pahunch|kaunsi (better|best|tez))/.test(state.message.toLowerCase())) {
      state.context = { ...state.context, pendingFastestHint: true, updatedAt: nowIso(state) }; // answer after the date arrives
    }
    return finish(state, intent, askForField(askField), { usedFallbackNlu: usedFallback });
  }

  const searchResult = await executeTool(state, 'searchTrains', {
    originCode: context.origin!.code,
    destinationCode: context.destination!.code,
    journeyDate: context.journeyDate!,
    ...(context.passengerCount ? { passengerCount: context.passengerCount } : {}),
  });

  let results = dataOf<TrainSearchResult[]>(searchResult);
  if (results) {
    // Time-of-day filter: the user asked for "subah/morning" or "4-6am" trains.
    // The hint may be in THIS message (reconciled from the AI's reading by
    // orchestrateSingleTurn) or (more commonly) in the ORIGINAL journey message,
    // because the search often runs several turns after station/date
    // disambiguation. We persist it on context (handleJourney) and apply it here
    // so the cards genuinely show only the requested window — not the whole list.
    // The reply visibly acknowledges the AI's understanding ("Samajh gaya …").
    const filterHint: SearchFilterHint | null = state.filterHint ?? state.context.pendingSearchFilter;
    state.context = { ...state.context, pendingSearchFilter: null, updatedAt: nowIso(state) };
    let filterAck: string | null = null;
    if (filterHint) {
      const filtered = applySearchFilter(results, filterHint);
      if (filtered.length > 0) {
        results = filtered; // show ONLY trains in the requested window
      }
      // Acknowledge what the assistant understood. When nothing matched, show the
      // honest empty note (filtered=[]) rather than listing the full list.
      filterAck = searchFilterAck(filterHint, filtered.length > 0 ? results : filtered);
    }

    state.context = setSearchResults(state.context, results, nowIso(state));
    state.cards = results.slice(0, 40).map(toTrainCard);

    const appendNote = (reply: string): string => (filterAck ? `${reply}\n\n${filterAck}` : reply);

    // Single result → auto-select it (user complaint fix): asking "kaunsi leni hai?"
    // for the ONLY train confuses users into answering the class instead.
    if (results.length === 1 && !filterHint) {
      const only = results[0]!;
      state.context = setContextSlots(state.context, { selectedTrain: only.train }, 'FILL_MISSING', nowIso(state));
      state.context = updateConversationMeta(state.context, { bookingStage: 'TRAIN_SELECTED' }, nowIso(state));
      const question = askClassNow(state);
      const reply = `${searchResultsReply(results, state.context.origin, state.context.destination)} Select kar li. ${question}`;
      return finish(state, intent, appendNote(maybeAppendFastestNote(state, reply)), {
        factsFromTools: true,
        usedFallbackNlu: usedFallback,
      });
    }

    state.context = updateConversationMeta(
      state.context,
      { bookingStage: 'SEARCH_RESULTS', lastAskedField: 'selectedTrain', pendingQuestion: 'Kaunsi train leni hai?' },
      nowIso(state),
    );
    const baseReply = searchResultsReply(results, state.context.origin, state.context.destination);
    return finish(state, intent, appendNote(maybeAppendFastestNote(state, baseReply)), {
      factsFromTools: true,
      usedFallbackNlu: usedFallback,
    });
  }
  return finish(state, intent, railwayUnavailableReply(searchResult), { usedFallbackNlu: usedFallback });
}

/**
 * Narrow the CURRENT search results by a time-of-day/window the user just named
 * (\"sirf morning\", \"4am se 6am ke beech\"). Reuses the already-listed verified
 * trains — no new provider search, no re-asking route/station. Returns null when
 * the turn isn't a refinement (fresh route, passenger/confirmation answer, etc.).
 */
async function maybeRefineSearchResults(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn | null> {
  const results = state.context.lastSearchResults ?? [];
  if (results.length === 0) return null;
  // A NEW journey is NOT a refinement: reject when the message names a genuine
  // station pair, OR an explicit \"<A> se <B> (tak/jaana)\" route phrase. A single
  // hallucinated token (the NLU sometimes reads \"sirf\" as a station) is ignored —
  // the time-filter is the dominant signal for a refinement.
  const realRoutePair = u.slots.originQuery !== null && u.slots.destinationQuery !== null;
  const explicitRoutePhrase = /\b\S+\s+se\s+\S+\s+(tak|jaana|jana|jaaye|jaye)\b/i.test(state.message);
  if (realRoutePair || explicitRoutePhrase) return null;
  // Never steal passenger-detail or booking-confirmation answers.
  if (isPassengerField(state.context.lastAskedField)) return null;
  if (isAwaitingBookingConfirmation(state.context)) return null;
  // A date-only turn (\"kal\") is a date/normal flow, not a time refinement.
  if (u.slots.dateText) return null;
  const hint = state.filterHint;
  if (!hint) return null;
  if (state.message.split(/\s+/).filter(Boolean).length > 12) return null;

  const filtered = applySearchFilter(results, hint);
  const ack = searchFilterAck(hint, filtered);
  state.context = setSearchResults(state.context, filtered, nowIso(state));
  state.cards = filtered.slice(0, 40).map(toTrainCard);
  state.context = updateConversationMeta(
    state.context,
    { bookingStage: 'SEARCH_RESULTS', lastAskedField: 'selectedTrain', pendingQuestion: 'Kaunsi train leni hai?' },
    nowIso(state),
  );
  const base = searchResultsReply(filtered, state.context.origin, state.context.destination);
  return finish(state, 'BOOK_TRAIN', `${base}\n\n${ack}`, { usedFallbackNlu: usedFallback, sourceClass: 'TRAIN_SEARCH' });
}

function stationCardFields(station: Station | null | undefined): { code: string | null; name: string | null } {
  const code = station?.code && station.code.trim() !== '' ? station.code : null;
  return { code, name: station?.name ?? null };
}

function toTrainCard(entry: TrainSearchResult): TrainCard {
  const from = stationCardFields(entry.fromStation);
  const to = stationCardFields(entry.toStation);
  const origin = stationCardFields(entry.train.originStation);
  const dest = stationCardFields(entry.train.destinationStation);
  return {
    number: entry.train.number,
    name: entry.train.name,
    departureTime: entry.departureTime,
    arrivalTime: entry.arrivalTime,
    durationMinutes: entry.durationMinutes,
    classes: [...(entry.train.travelClasses ?? [])],
    fromCode: from.code,
    fromName: from.name,
    toCode: to.code,
    toName: to.name,
    originCode: origin.code,
    originName: origin.name,
    destCode: dest.code,
    destName: dest.name,
  };
}

function missingJourneyFields(context: ConversationContext): ContextSlotField[] {
  const missing: ContextSlotField[] = [];
  if (!context.origin || !context.origin.code) missing.push('origin');
  if (!context.destination || !context.destination.code) missing.push('destination');
  if (!context.journeyDate) missing.push('journeyDate');
  return missing;
}

const PASSENGER_COUNT_CHIPS = ['1', '2', '3', '4', '5', '6'] as const;

function offeredClassCodes(context: ConversationContext): string[] {
  const fromSelected = [...(context.selectedTrain?.travelClasses ?? [])].map((code) => code.toUpperCase()).filter(Boolean);
  if (fromSelected.length > 0) return fromSelected;
  return [...(context.lastReferencedTrain?.travelClasses ?? [])].map((code) => code.toUpperCase()).filter(Boolean);
}

function asTravelClassCodes(raw: readonly string[] | null | undefined): TravelClassCode[] {
  const out: TravelClassCode[] = [];
  for (const code of raw ?? []) {
    const upper = code.toUpperCase();
    const ok =
      upper === '1A' || upper === '2A' || upper === '3A' || upper === '3E' ||
      upper === 'CC' || upper === 'EC' || upper === 'SL' || upper === '2S';
    if (ok && !out.includes(upper as TravelClassCode)) out.push(upper as TravelClassCode);
  }
  return out;
}

function stampTrainClasses(state: TurnState, trainNumber: string, classes: TravelClassCode[], train: Train | null): string[] {
  const stamped: Train = train && (!train.number || train.number === trainNumber)
    ? { ...train, number: trainNumber, travelClasses: classes }
    : {
        number: trainNumber,
        name: train?.name ?? state.context.selectedTrain?.name ?? state.context.lastReferencedTrain?.name ?? null,
        originStation: train?.originStation ?? state.context.selectedTrain?.originStation ?? null,
        destinationStation: train?.destinationStation ?? state.context.selectedTrain?.destinationStation ?? null,
        departureTime: train?.departureTime ?? null,
        arrivalTime: train?.arrivalTime ?? null,
        runsOn: train?.runsOn ?? null,
        travelClasses: classes,
        pantryCar: train?.pantryCar ?? null,
      };
  if (!state.context.selectedTrain || state.context.selectedTrain.number === trainNumber) {
    state.context = setContextSlots(state.context, { selectedTrain: stamped }, 'FILL_MISSING', nowIso(state));
  }
  state.context = { ...state.context, lastReferencedTrain: stamped, updatedAt: nowIso(state) };
  return classes;
}

function timetableFromThisTurn(state: TurnState, trainNumber: string): Timetable | null {
  for (let i = state.toolResults.length - 1; i >= 0; i -= 1) {
    const result = state.toolResults[i]!;
    if (result.tool !== 'getTimetable') continue;
    const timetable = dataOf<Timetable>(result);
    if (timetable && (!timetable.trainNumber || timetable.trainNumber === trainNumber)) return timetable;
  }
  return null;
}

async function loadTimetable(state: TurnState, trainNumber: string): Promise<Timetable | null> {
  const cached = timetableFromThisTurn(state, trainNumber);
  if (cached) return cached;
  const result = await executeTool(state, 'getTimetable', { trainNumber });
  return dataOf<Timetable>(result);
}

function haltIndex(stops: readonly TrainStop[], code: string): number {
  return commercialHaltIndex(stops, code);
}

function stationHaltLabel(station: Station | null | undefined, code: string): string {
  return station?.name && station.code.toUpperCase() === code.toUpperCase() ? station.name : code;
}

/**
 * Commercial-stop check from getTimetable (include_intermediate=false).
 * Pass-through points like 12054@LDH are NOT stops — never treat as a bookable segment.
 */
async function refuseIfTrainSkipsSegment(
  state: TurnState,
  trainNumber: string,
  fromCode: string,
  toCode: string,
  intent: Intent,
  usedFallback: boolean,
): Promise<OrchestratorTurn | null> {
  const timetable = await loadTimetable(state, trainNumber);
  if (!timetable) {
    return finish(
      state,
      intent,
      `${trainNumber} ka schedule/stoppage abhi provider se confirm nahi ho paaya — isliye seat/fare andaza nahi lagaunga.`,
      { usedFallbackNlu: usedFallback, factsFromTools: true },
    );
  }
  const stops = Array.isArray(timetable.stops) ? timetable.stops : [];
  if (stops.length === 0) {
    return finish(
      state,
      intent,
      `${trainNumber} ka schedule/stoppage abhi provider se confirm nahi ho paaya — isliye seat/fare andaza nahi lagaunga.`,
      { usedFallbackNlu: usedFallback },
    );
  }
  const fromIdx = haltIndex(stops, fromCode);
  const toIdx =
    fromIdx < 0
      ? haltIndex(stops, toCode)
      : stops.findIndex((stop, index) => index > fromIdx && stationCodesMatch(stop.stationCode ?? '', toCode));
  let missing: 'from' | 'to' | 'both' | 'order' | null = null;
  if (fromIdx < 0 && haltIndex(stops, toCode) < 0) missing = 'both';
  else if (fromIdx < 0) missing = 'from';
  else if (toIdx < 0) missing = haltIndex(stops, toCode) < 0 ? 'to' : 'order';
  if (!missing) {
    const classes = asTravelClassCodes(timetable.travelClasses);
    if (classes.length > 0 && offeredClassCodes(state.context).length === 0) {
      stampTrainClasses(state, trainNumber, classes, state.context.selectedTrain);
    }
    return null;
  }
  rememberTrain(state, trainNumber);
  const reply = trainDoesNotServeSegmentReply({
    trainNumber,
    trainName: timetable.trainName ?? state.context.selectedTrain?.name ?? state.context.lastReferencedTrain?.name ?? null,
    fromCode: fromCode.toUpperCase(),
    toCode: toCode.toUpperCase(),
    fromLabel: stationHaltLabel(state.context.origin, fromCode),
    toLabel: stationHaltLabel(state.context.destination, toCode),
    missing,
    stopCodes: stops.map((stop) => stop.stationCode),
  });
  return finish(state, intent, reply, { usedFallbackNlu: usedFallback });
}

/**
 * Real provider classes only. RailCore /trains/{n} often omits `classes`;
 * the schedule endpoint publishes them (e.g. 12054 → 2S, CC). Never invent SL/3A.
 */
async function ensureTrainClasses(state: TurnState, trainNumber: string): Promise<string[]> {
  const existing = offeredClassCodes(state.context);
  if (existing.length > 0) return existing;

  const infoResult = await executeTool(state, 'getTrainInfo', { trainNumber });
  const train = dataOf<Train>(infoResult);
  const fromInfo = asTravelClassCodes(train?.travelClasses);
  if (fromInfo.length > 0) return stampTrainClasses(state, trainNumber, fromInfo, train);

  const timetable = await loadTimetable(state, trainNumber);
  const fromSchedule = asTravelClassCodes(timetable?.travelClasses);
  if (fromSchedule.length > 0) {
    return stampTrainClasses(state, trainNumber, fromSchedule, train ? { ...train, name: train.name ?? timetable?.trainName ?? null } : {
      number: trainNumber,
      name: timetable?.trainName ?? null,
      originStation: null,
      destinationStation: null,
      departureTime: null,
      arrivalTime: null,
      runsOn: null,
      travelClasses: fromSchedule,
      pantryCar: null,
    });
  }

  rememberTrain(state, trainNumber);
  return [];
}

/** Class prompt + chips from the train's verified API classes — never a generic menu. */
function askClassNow(state: TurnState): string {
  const offered = offeredClassCodes(state.context);
  state.chips = offered.length > 0 ? offered : null;
  const question = askForClass(offered.length > 0 ? offered : null);
  state.context = updateConversationMeta(
    state.context,
    { lastAskedField: 'selectedClass', pendingQuestion: question },
    nowIso(state),
  );
  return question;
}

// ── slot fillers (answers to pending questions + result references) ─────────

interface SlotFiller {
  kind: 'date' | 'passengerCount' | 'travelClass' | 'station' | 'reference' | 'passengerDetail';
  value: string | number | null;
}

/** Match a typed train number against CURRENT search results (padding-tolerant). */
function listedTrain(
  results: readonly TrainSearchResult[] | null | undefined,
  number: string | null | undefined,
): TrainSearchResult | undefined {
  if (!number || !results || results.length === 0) return undefined;
  const norm = number.replace(/^0+/, '') || number;
  return results.find((entry) => {
    const n = entry.train.number.replace(/^0+/, '') || entry.train.number;
    return entry.train.number === number || n === norm;
  });
}

function isExplicitTrainDataQuery(message: string): boolean {
  return (
    /\b(live|status|fare|price|timetable|pnr|cancel|wallet|kaha|kahan|kitni late|baare|bare|about|info|information|details)\b/i.test(
      message,
    ) && !/\b(chahiye|class|seat)\b/i.test(message)
  );
}

function isSelectionOrFiller(u: AIUnderstandingResult, message: string): boolean {
  if (u.slots.originQuery || u.slots.destinationQuery) return false;
  if (u.slots.secondTrainNumber) return false;
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (words > 10) return false;
  const typedTrain = Boolean(u.slots.trainNumber && message.includes(u.slots.trainNumber));
  return u.slots.resultReference !== null || typedTrain || u.slots.travelClass !== null;
}

async function maybeHandleSearchSelection(
  state: TurnState,
  u: AIUnderstandingResult,
  usedFallback: boolean,
  rawMessage: string,
): Promise<OrchestratorTurn | null> {
  const results = state.context.lastSearchResults ?? [];
  if (results.length === 0) return null;
  if (isPassengerField(state.context.lastAskedField)) return null;
  const asked = state.context.lastAskedField;
  const stage = state.context.bookingStage;
  const picking =
    asked === 'selectedTrain' ||
    asked === 'selectedClass' ||
    stage === 'SEARCH_RESULTS' ||
    stage === 'TRAIN_SELECTED';
  if (!picking) return null;
  if (isExplicitTrainDataQuery(rawMessage)) return null;
  if (/\b(kya hota|kya hai|matlab|meaning|what is|difference|antar|fark)\b/i.test(rawMessage)) return null;
  if (resolveResultDetailQuestion(rawMessage, state.context)) return null;
  if (u.slots.secondTrainNumber) return null;

  const typedNumbers = [...rawMessage.matchAll(/\b(\d{4,5})\b/g)].map((match) => match[1]!);
  // Two train numbers → comparison, not a booking pick.
  if (typedNumbers.length >= 2) return null;
  const journeyWords = /\b(se|from|to|jaana|jana|jaaye|jaye|ticket|book)\b/i.test(rawMessage);
  // Hallucinated stations on a typed train number must not start a new search.
  if ((u.slots.originQuery || u.slots.destinationQuery) && (journeyWords || typedNumbers.length === 0)) return null;
  const typedTrain = typedNumbers.length > 0;
  const listed =
    listedTrain(results, u.slots.trainNumber) ??
    typedNumbers.map((n) => listedTrain(results, n)).find((entry) => entry !== undefined);
  const classCode = u.slots.travelClass;
  const shownNumber = listed?.train.number ?? u.slots.trainNumber ?? typedNumbers[0] ?? 'yeh train';

  if (typedTrain && !listed) {
    return finish(
      state,
      'BOOK_TRAIN',
      `${shownNumber} current result list mein nahi hai — upar wali train cards mein se number ya class (3A/SL/CC) tap karein.`,
      { usedFallbackNlu: usedFallback },
    );
  }

  if (typedTrain || u.slots.resultReference || classCode) {
    const filler: SlotFiller | null = typedTrain || u.slots.resultReference
      ? { kind: 'reference', value: listed?.train.number ?? u.slots.resultReference ?? shownNumber }
      : classCode
        ? { kind: 'travelClass', value: classCode }
        : asSlotFiller(u, state.context, rawMessage);
    if (filler) {
      if (u.slots.resultReference) state.wasFollowUp = true;
      return handleSlotFiller(state, u, filler, usedFallback, rawMessage);
    }
  }
  return null;
}

function asSlotFiller(u: AIUnderstandingResult, context: ConversationContext, rawMessage?: string): SlotFiller | null {
  // §9: while a passenger field is being asked, any short plain reply is the answer.
  if (isPassengerField(context.lastAskedField)) {
    return { kind: 'passengerDetail', value: null };
  }
  if (u.slots.dateText) return { kind: 'date', value: u.slots.dateText };
  if (u.slots.passengerCount !== null) return { kind: 'passengerCount', value: u.slots.passengerCount };
  // Bare train number from the CURRENT list — only if the user actually typed it (not injected context).
  if (u.slots.trainNumber && (context.lastSearchResults?.length ?? 0) > 0) {
    const typed = !rawMessage || rawMessage.includes(u.slots.trainNumber);
    const hit = typed ? listedTrain(context.lastSearchResults, u.slots.trainNumber) : undefined;
    if (hit) return { kind: 'reference', value: hit.train.number };
  }
  if (u.slots.travelClass) return { kind: 'travelClass', value: u.slots.travelClass };
  if (u.slots.resultReference) return { kind: 'reference', value: u.slots.resultReference };
  if (u.slots.originQuery || u.slots.destinationQuery || u.slots.mentionedStations.length === 1) {
    if (context.lastAskedField === 'origin' || context.lastAskedField === 'destination') {
      return { kind: 'station', value: u.slots.originQuery ?? u.slots.destinationQuery ?? u.slots.mentionedStations[0] ?? null };
    }
  }
  return null;
}

/**
 * Persist the paused READ data-intent snapshot (train/class/date + route queries),
 * and — if THIS turn already carries a route ("asr jn se ndls") — resolve it
 * immediately so we never ask for a route the user already provided.
 *
 * Returns the turn when it resolved / needs a station choice; null when the
 * caller should ask for the route (no route supplied this turn).
 */
/** Persist the paused READ data-intent snapshot (train/class/date + route queries). */
function snapshotPendingDataRoute(
  state: TurnState,
  u: AIUnderstandingResult,
  intent: 'GET_AVAILABILITY' | 'GET_FARE',
  trainNumber: string,
): void {
  state.context = {
    ...state.context,
    pendingDataRoute: {
      intent,
      trainNumber,
      travelClass: u.slots.travelClass ?? state.context.selectedClass ?? null,
      journeyDate: state.context.journeyDate,
      missingOrigin: !state.context.origin?.code,
      missingDestination: !state.context.destination?.code,
      originQuery: (u.slots.originQuery ?? state.context.origin?.name)?.trim() || null,
      destinationQuery: (u.slots.destinationQuery ?? state.context.destination?.name)?.trim() || null,
    },
    updatedAt: nowIso(state),
  };
}

/**
 * Resume a paused READ data-intent (availability/fare) now that its
 * route/date/class are filled, and re-run the SAME intent (not a journey).
 */
async function resumePausedDataRoute(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn | null> {
  const pending = state.context.pendingDataRoute;
  if (!pending) return null;
  if (state.context.stationChoices) return null; // defer to active station-choice
  if (!state.context.origin?.code || !state.context.destination?.code) return null; // route still incomplete
  state.context = { ...state.context, pendingDataRoute: null, updatedAt: nowIso(state) };
  const restored: AIUnderstandingResult = {
    ...u,
    slots: {
      ...u.slots,
      trainNumber: pending.trainNumber,
      travelClass: u.slots.travelClass ?? pending.travelClass,
    },
  };
  return pending.intent === 'GET_AVAILABILITY' ? handleAvailability(state, restored, usedFallback) : handleFare(state, restored, usedFallback);
}

async function snapshotAndMaybeResolveDataRoute(
  state: TurnState,
  u: AIUnderstandingResult,
  usedFallback: boolean,
  intent: 'GET_AVAILABILITY' | 'GET_FARE',
  trainNumber: string,
): Promise<OrchestratorTurn | null> {
  snapshotPendingDataRoute(state, u, intent, trainNumber);
  // Only auto-resolve a route when the NLU structurally identified one
  // (origin/destination queries), NOT on bare word mentions (e.g. the verb
  // "krna" in "availability check krna" is wrongly surfaced as a station).
  const hasStructuralRoute = Boolean(u.slots.originQuery || u.slots.destinationQuery);
  if (hasStructuralRoute) {
    const resolved = await handlePendingDataRoute(state, u, usedFallback);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Complete a paused READ data-intent's route from the follow-up turn.
 *
 * When availability/fare paused to ask the route (context.pendingDataRoute), the
 * user's next turn may supply a full route ("Amritsar se Saharanpur"). This
 * resolves BOTH endpoints (station lookup, honouring disambiguation) and then
 * re-runs the data-intent handler with the SAME snapshot (train/class/date), so
 * the request completes instead of returning "samajh nahi paaya".
 *
 * Returns a turn when it handled the route; null when nothing is pending or the
 * follow-up did not provide a complete route.
 */
async function handlePendingDataRoute(
  state: TurnState,
  u: AIUnderstandingResult,
  usedFallback: boolean,
): Promise<OrchestratorTurn | null> {
  let pending = state.context.pendingDataRoute;
  if (!pending) return null;
  const intent = pending.intent;

  // An active station-choice is pending → defer to its resolution (handleSlotFiller
  // picks the code and resumes us); don't re-ask the same city this turn.
  if (state.context.stationChoices) return null;

  // Which endpoints are still unresolved (derived from context, so a disambiguation
  // that already filled one side is honoured).
  const needOrigin = !state.context.origin?.code;
  const needDestination = !state.context.destination?.code;

  // Persist the endpoint queries now (before any station-choice), so a
  // disambiguation of ONE side keeps the other endpoint (e.g. after picking ASR
  // from "Amritsar se Ludhiana" the destination "ludhiana" is still known).
  const originQuery = (u.slots.originQuery ?? u.slots.mentionedStations[0] ?? pending.originQuery)?.trim() || null;
  const destinationQuery = (u.slots.destinationQuery ?? u.slots.mentionedStations[1] ?? pending.destinationQuery)?.trim() || null;
  if (originQuery && originQuery !== pending.originQuery) pending = { ...pending, originQuery };
  if (destinationQuery && destinationQuery !== pending.destinationQuery) pending = { ...pending, destinationQuery };
  if (pending !== state.context.pendingDataRoute) state.context = { ...state.context, pendingDataRoute: pending, updatedAt: nowIso(state) };

  // Resolve the still-missing endpoint from the follow-up. Station lookup only —
  // never guess, and never auto-pick when multiple stations match.
  if (needOrigin) {
    const q = originQuery;
    if (!q) return null; // route not yet supplied
    const resolved = await resolveStation(state, q);
    if (resolved.choiceNeeded) return askStationChoice(state, 'origin', resolved.choiceNeeded, usedFallback, intent, q);
    if (!resolved.station) {
      clearPendingDataRoute(state);
      return finish(state, intent, resolved.error ?? stationResolveFailedReply(q), { usedFallbackNlu: usedFallback });
    }
    state.context = setContextSlots(state.context, { origin: resolved.station }, 'FILL_MISSING', nowIso(state));
  }
  if (needDestination) {
    const q = destinationQuery;
    if (!q) return null; // route not yet supplied
    const resolved = await resolveStation(state, q);
    if (resolved.choiceNeeded) return askStationChoice(state, 'destination', resolved.choiceNeeded, usedFallback, intent, q);
    if (!resolved.station) {
      clearPendingDataRoute(state);
      return finish(state, intent, resolved.error ?? stationResolveFailedReply(q), { usedFallbackNlu: usedFallback });
    }
    state.context = setContextSlots(state.context, { destination: resolved.station }, 'FILL_MISSING', nowIso(state));
  }

  if (!state.context.origin?.code || !state.context.destination?.code) return null; // still missing an endpoint

  // Restore the snapshot; then re-run the SAME intent.
  invalidateStaleResults(state);
  state.context = { ...state.context, pendingDataRoute: null, updatedAt: nowIso(state) };

  const restoredAIAsU: AIUnderstandingResult = {
    ...u,
    slots: {
      ...u.slots,
      // The train/class the user already named — needed because the follow-up
      // may only contain the route. journeyDate is recovered from context.
      trainNumber: pending.trainNumber,
      travelClass: u.slots.travelClass ?? pending.travelClass ?? state.context.selectedClass,
    },
  };
  return intent === 'GET_AVAILABILITY' ? handleAvailability(state, restoredAIAsU, usedFallback) : handleFare(state, restoredAIAsU, usedFallback);
}

/** Clear the paused data-route snapshot after a dead end (e.g. station not found). */
function clearPendingDataRoute(state: TurnState): void {
  state.context = { ...state.context, pendingDataRoute: null, updatedAt: nowIso(state) };
}

function inferAskedField(question: string | null): ContextSlotField | null {
  if (!question) return null;
  if (/date/i.test(question)) return 'journeyDate';
  if (/passenger/i.test(question)) return 'passengerCount';
  if (/class/i.test(question)) return 'selectedClass';
  if (/kahan se|boarding/i.test(question)) return 'origin';
  if (/kahan tak|destination/i.test(question)) return 'destination';
  if (/kaunsi train/i.test(question)) return 'selectedTrain';
  return null;
}

async function handleSlotFiller(
  state: TurnState,
  u: AIUnderstandingResult,
  filler: SlotFiller,
  usedFallback: boolean,
  rawMessage: string,
): Promise<OrchestratorTurn> {
  let context = state.context;

  // Resume a paused booking when the user comes back to it ("kal jaana hai").
  if (context.pausedBooking) {
    context = restorePausedBooking(context);
  }

  // One-tap / one-line train+class from current results ("12014 mein 3A chahiye").
  // Only when the USER mentioned the train this turn — never from injected context trainNumber.
  {
    const results = context.lastSearchResults ?? [];
    const typedNumbers = [...rawMessage.matchAll(/\b(\d{4,5})\b/g)].map((match) => match[1]!);
    const userMentionedTrain = typedNumbers.length > 0 || Boolean(u.slots.resultReference);
    const classCode = (u.slots.travelClass ?? (filler.kind === 'travelClass' ? String(filler.value).toUpperCase() : null)) as ConversationContext['selectedClass'];
    const referenced = userMentionedTrain
      ? listedTrain(results, u.slots.trainNumber) ??
        typedNumbers.map((n) => listedTrain(results, n)).find((entry) => entry !== undefined) ??
        (u.slots.resultReference || filler.kind === 'reference' ? resolveResultReference(String(u.slots.resultReference ?? filler.value), results) : null)
      : null;
    if (results.length > 0 && referenced) {
      context = setContextSlots(context, { selectedTrain: referenced.train }, 'FILL_MISSING', nowIso(state));
      if (classCode) {
        context = setContextSlots(context, { selectedClass: classCode }, 'FILL_MISSING', nowIso(state));
        state.context = context;
        transitionStage(state, 'TRAIN_SELECTED');
        transitionStage(state, 'CLASS_SELECTED');
        return continueBookingFlow(state, usedFallback);
      }
      context = updateConversationMeta(context, { bookingStage: 'TRAIN_SELECTED' }, nowIso(state));
      state.context = context;
      askClassNow(state);
      return finish(state, 'BOOK_TRAIN', selectionReply(referenced), { usedFallbackNlu: usedFallback });
    }
  }

  // Pending station disambiguation ("Delhi" → NDLS/DLI/NZM): resolve the user's choice.
  if (context.stationChoices) {
    const choice = resolveStationChoice(rawMessage, context.stationChoices.options);
    if (choice) {
      const field = context.stationChoices.field === 'origin' ? 'origin' : 'destination';
      context = setContextSlots(context, { [field]: choice } as never, 'FILL_MISSING', nowIso(state));
      context = { ...context, stationChoices: null, pendingStationResolution: null, lastAskedField: null, pendingQuestion: null, updatedAt: nowIso(state) };
      state.context = context;
      // A data-intent (availability/fare) pause resolves back to that SAME request,
      // not into a booking journey.
      if (state.context.pendingDataRoute) {
        const resumed = await handlePendingDataRoute(state, u, usedFallback);
        if (resumed) return resumed;
      }
      const askedStations = await resolvePlaceholderStations(state, 'BOOK_TRAIN', usedFallback);
      if (askedStations) return askedStations;
      return finishJourney(state, 'BOOK_TRAIN', usedFallback);
    }
    const question = stationChoiceReply(context.stationChoices.field as 'origin' | 'destination', context.stationChoices.options);
    state.context = context;
    return finish(state, 'BOOK_TRAIN', `Samajh nahi aaya — ${question}`, { usedFallbackNlu: usedFallback });
  }

  let askedField: ContextSlotField | null =
    context.lastAskedField ?? inferAskedField(context.pendingQuestion);

  // A result reference while results are showing = train selection.
  if (filler.kind === 'reference' && context.lastSearchResults && context.lastSearchResults.length > 0) {
    askedField = 'selectedTrain';
  }

  if (filler.kind === 'reference' && (!context.lastSearchResults || context.lastSearchResults.length === 0)) {
    // §9: reference with NO current list → ask which train (never guess).
    return finish(
      state,
      'BOOK_TRAIN',
      'Abhi koi search result list nahi hai — pehle route+date search karein (jaise "Amritsar se Ludhiana kal"), phir "pehli wali" ya train number/naam se chun sakte hain.',
      { usedFallbackNlu: usedFallback },
    );
  }

  if (!askedField) {
    return finish(state, 'UNKNOWN', rephraseReply(), { usedFallbackNlu: usedFallback });
  }

  // §9: passenger detail collection — one field at a time, one passenger at a time.
  if (isPassengerField(askedField)) {
    return collectPassengerField(state, askedField, rawMessage, usedFallback);
  }

  // ── resolve the value for the asked field ──
  if (askedField === 'journeyDate' && filler.kind === 'date') {
    const resolved = resolveDateText(String(filler.value), state.now);
    if (!resolved) {
      return finish(state, 'BOOK_TRAIN', 'Date samajh nahi aayi — "aaj", "kal", "parso" ya exact date (2026-08-27) bataiye.', {
        usedFallbackNlu: usedFallback,
      });
    }
    const previous = context.journeyDate;
    const isDateCorrection = previous !== null && previous !== resolved;
    context = setContextSlots(context, { journeyDate: resolved }, isDateCorrection ? 'CORRECT' : 'FILL_MISSING', nowIso(state));
    state.context = context;
    if (isDateCorrection) invalidateStaleResults(state); // §12/§22: never reuse stale trains/fare
    context = state.context;
  } else if (askedField === 'passengerCount' && filler.kind === 'passengerCount') {
    context = setContextSlots(context, { passengerCount: Number(filler.value) }, 'FILL_MISSING', nowIso(state));
  } else if (askedField === 'selectedClass' && filler.kind === 'travelClass') {
    context = setContextSlots(context, { selectedClass: String(filler.value).toUpperCase() as never, journeyDate: context.journeyDate }, 'FILL_MISSING', nowIso(state));
  } else if ((askedField === 'origin' || askedField === 'destination') && filler.kind === 'station') {
    const resolved = await resolveStation(state, String(filler.value ?? ''));
    if (!resolved.station) {
      state.context = context;
      return finish(state, 'BOOK_TRAIN', resolved.error ?? stationResolveFailedReply(String(filler.value)), {
        usedFallbackNlu: usedFallback,
      });
    }
    context = setContextSlots(context, askedField === 'origin' ? { origin: resolved.station } : { destination: resolved.station }, 'FILL_MISSING', nowIso(state));
  } else if (askedField === 'selectedTrain' && (filler.kind === 'travelClass' || filler.kind === 'passengerCount')) {
    // User answered class/passengers while we asked which train.
    // One result, or only one train that offers that class → auto-select; else re-ask.
    const results = context.lastSearchResults ?? [];
    const wantedClass = filler.kind === 'travelClass' ? (String(filler.value).toUpperCase() as never) : null;
    const classMatches = wantedClass
      ? results.filter((entry) => (entry.train.travelClasses ?? []).includes(wantedClass))
      : [];
    const only = results.length === 1 ? results[0] : classMatches.length === 1 ? classMatches[0] : null;
    if (only) {
      context = setContextSlots(context, { selectedTrain: only.train }, 'FILL_MISSING', nowIso(state));
      if (filler.kind === 'travelClass') {
        context = setContextSlots(context, { selectedClass: wantedClass }, 'FILL_MISSING', nowIso(state));
      } else {
        context = setContextSlots(context, { passengerCount: Number(filler.value) }, 'FILL_MISSING', nowIso(state));
      }
      state.context = context;
      transitionStage(state, 'TRAIN_SELECTED');
      if (filler.kind === 'travelClass') transitionStage(state, 'CLASS_SELECTED');
      return continueBookingFlow(state, usedFallback);
    }
    state.context = context;
    const classHint = wantedClass && classMatches.length > 1
      ? ` ${wantedClass} in ${classMatches.map((entry) => entry.train.number).join(', ')} hai.`
      : '';
    return finish(
      state,
      'BOOK_TRAIN',
      `Pehle train select karein — ${results.length} trains mili hain.${classHint} Train number bataiye, "pehli wali / doosri wali" bolein, ya card pe class tap karein.`,
      { usedFallbackNlu: usedFallback },
    );
  } else if (askedField === 'selectedTrain' && (filler.kind === 'reference' || u.slots.trainNumber)) {
    state.wasFollowUp = true; // §13: reference resolution is a contextual follow-up
    const results = context.lastSearchResults ?? [];
    const selected =
      listedTrain(results, u.slots.trainNumber) ??
      (filler.kind === 'reference' ? resolveResultReference(String(filler.value), results) : null);
    if (!selected) {
      state.context = context;
      return finish(
        state,
        'BOOK_TRAIN',
        'Ye train current result list mein nahi hai — list mein se number ya "pehli wali / doosri wali" bataiye.',
        { usedFallbackNlu: usedFallback },
      );
    }
    context = setContextSlots(context, { selectedTrain: selected.train }, 'FILL_MISSING', nowIso(state));
    context = updateConversationMeta(context, { bookingStage: 'TRAIN_SELECTED' }, nowIso(state));
    state.context = context;
    askClassNow(state);
    return finish(state, 'BOOK_TRAIN', selectionReply(selected), { usedFallbackNlu: usedFallback });
  } else {
    return finish(state, 'UNKNOWN', rephraseReply(), { usedFallbackNlu: usedFallback });
  }

  context = updateConversationMeta(context, { lastAskedField: null, pendingQuestion: null }, nowIso(state));
  state.context = context;

  // A paused READ data-intent (availability/fare) that was collecting a date/class
  // resumes that SAME intent, not a booking journey — even if selectedTrain was
  // filled so we could offer class chips.
  if (state.context.pendingDataRoute) {
    const resumed = await resumePausedDataRoute(state, u, usedFallback);
    if (resumed) return resumed;
  }

  // ── continue the booking flow ──
  if (askedField === 'selectedClass' && context.selectedTrain && context.selectedClass) {
    transitionStage(state, 'CLASS_SELECTED');
    return continueBookingFlow(state, usedFallback);
  }

  if (askedField === 'passengerCount' && context.selectedTrain && context.selectedClass) {
    transitionStage(state, 'CLASS_SELECTED');
    return continueBookingFlow(state, usedFallback);
  }

  // journey fields → continue the journey flow
  const askedStations = await resolvePlaceholderStations(state, 'BOOK_TRAIN', usedFallback);
  if (askedStations) return askedStations;
  return finishJourney(state, 'BOOK_TRAIN', usedFallback);
}

/**
 * §7/§8/§9: after train + class are chosen, deterministically check availability,
 * then fare, then collect passengers, then present the FINAL review. Fresh tool
 * calls only — stale availability/fare are never reused (cleared on any change).
 */
async function continueBookingFlow(state: TurnState, usedFallback: boolean): Promise<OrchestratorTurn> {
  const context = state.context;
  const trainNumber = context.selectedTrain?.number;
  const from = context.origin?.code;
  const to = context.destination?.code;
  const journeyDate = context.journeyDate;
  const travelClass = context.selectedClass;
  if (!trainNumber || !from || !to || !journeyDate || !travelClass) {
    return finishJourney(state, 'BOOK_TRAIN', usedFallback);
  }

  // FIX (user complaint): the chosen class must be one the train VERIFIABLY offers.
  // Otherwise say so honestly and re-ask — never fake availability for a wrong class.
  const offered = context.selectedTrain?.travelClasses ?? null;
  if (offered && offered.length > 0 && !offered.includes(travelClass)) {
    state.context = setContextSlots({ ...context, selectedClass: null }, { selectedClass: null }, 'FILL_MISSING', nowIso(state));
    const question = `${trainNumber} mein ${travelClass} class available nahi hai — is train mein ${offered.join('/')} classes hain. ${askClassNow(state)}`;
    return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
  }

  {
    const blocked = await refuseIfTrainSkipsSegment(state, trainNumber, from, to, 'BOOK_TRAIN', usedFallback);
    if (blocked) return blocked;
  }

  const replyParts: string[] = [];

  // 1. AVAILABILITY (fresh, through the router — RailCore primary / RailKit fallback)
  const availabilityResult = await executeTool(state, 'getAvailability', {
    trainNumber,
    journeyDate,
    travelClass,
    fromStationCode: from,
    toStationCode: to,
  });
  const availability = dataOf<Availability>(availabilityResult);
  if (availability) {
    state.context = { ...state.context, lastAvailability: availability, updatedAt: nowIso(state) };
    replyParts.push(availabilityLineReply(availability));
    transitionStage(state, 'AVAILABILITY_CHECKED');
    if (availability.status === 'REGRET') {
      state.context = { ...state.context, selectedClass: null, updatedAt: nowIso(state) };
      const question = askClassNow(state);
      return finish(state, 'BOOK_TRAIN', [...replyParts, '', question].join('\n'), { usedFallbackNlu: usedFallback });
    }
    if ((availability.status === 'WAITLIST' || availability.status === 'RAC') && !state.context.waitlistAccepted) {
      const question = waitlistConsentQuestion(availability);
      state.context = updateConversationMeta(
        state.context,
        { lastAskedField: 'waitlistConsent', pendingQuestion: question },
        nowIso(state),
      );
      state.chips = ['haan', 'nahi'];
      return finish(state, 'BOOK_TRAIN', [...replyParts, '', question].join('\n'), { usedFallbackNlu: usedFallback });
    }
  } else {
    replyParts.push(`Availability abhi available nahi hai — ${railwayUnavailableReply(availabilityResult)}`);
  }

  // 2. FARE — fetched quietly for the draft/review, but NOT shown mid-flow
  // (user request: fare sirf END mein — final review mein — dikhana hai).
  const fareResult = await executeTool(state, 'getFare', {
    trainNumber,
    fromStationCode: from,
    toStationCode: to,
    journeyDate,
    travelClass,
  });
  const fare = dataOf<Fare>(fareResult);
  if (fare && fare.breakdown.totalMinor !== null) {
    state.context = { ...state.context, lastFareQuote: fare, updatedAt: nowIso(state) };
    transitionStage(state, 'FARE_REVIEW');
  }
  // Fare summary deliberately omitted here — it appears in the final booking review.

  // 3. PASSENGERS — count first (if missing), then details one at a time.
  if (!state.context.passengerCount) {
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'passengerCount', pendingQuestion: askForField('passengerCount') },
      nowIso(state),
    );
    state.chips = [...PASSENGER_COUNT_CHIPS];
    return finish(state, 'BOOK_TRAIN', [...replyParts, '', askForField('passengerCount')].join('\n'), {
      usedFallbackNlu: usedFallback,
    });
  }

  if (state.context.passengers.length < state.context.passengerCount) {
    transitionStage(state, 'PASSENGER_DETAILS_REQUIRED');
    const question = passengerQuestion('passengerName', state.context.passengers.length + 1, state.context.passengerCount);
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'passengerName', pendingQuestion: question },
      nowIso(state),
    );
    state.panel = {
      kind: 'passengers',
      current: state.context.passengers.length + 1,
      total: state.context.passengerCount ?? state.context.passengers.length + 1,
      label: 'Passenger details',
    };
    return finish(state, 'BOOK_TRAIN', [...replyParts, '', question].join('\n'), { usedFallbackNlu: usedFallback });
  }

  // 4. All details known → FINAL REVIEW.
  return presentFinalReview(state, usedFallback, replyParts);
}

function isPassengerField(field: ContextSlotField | null): field is 'passengerName' | 'passengerAge' | 'passengerGender' | 'passengerBerth' {
  return field === 'passengerName' || field === 'passengerAge' || field === 'passengerGender' || field === 'passengerBerth';
}

function chipsForPassengerField(field: ContextSlotField | null, travelClass: string | null | undefined): string[] | null {
  if (field === 'passengerGender') return ['M', 'F', 'T'];
  if (field === 'passengerAge') return ['28', '30', '35', '45', '60'];
  if (field === 'passengerBerth') {
    const berths = berthsForClass(travelClass);
    return berths ? [...berths, 'koi nahi'] : null;
  }
  return null;
}

/** §9: collect one passenger field per turn; progress "Passenger 2 of 2". */
async function collectPassengerField(
  state: TurnState,
  field: 'passengerName' | 'passengerAge' | 'passengerGender' | 'passengerBerth',
  rawMessage: string,
  usedFallback: boolean,
): Promise<OrchestratorTurn> {
  const context = state.context;
  const total = context.passengerCount ?? context.passengers.length + 1;
  const currentIndex = context.passengers.length + 1;
  const text = rawMessage.trim();
  const draft = context.passengerDraft ?? { name: '', age: null, gender: null, berthPreference: null };

  // Intelligent one-shot: "Rahul, 30, M" fills name+age+gender together.
  if (field === 'passengerName') {
    const combined = parseCombinedPassenger(text);
    if (combined) {
      const updatedDraft = {
        name: combined.name,
        age: combined.age,
        gender: combined.gender,
        berthPreference: null as string | null,
      };
      state.context = { ...context, passengerDraft: updatedDraft, updatedAt: nowIso(state) };
      let nextField: ContextSlotField | null = berthsForClass(state.context.selectedClass) ? 'passengerBerth' : null;
      if (nextField) {
        const berthOpts = berthsForClass(state.context.selectedClass);
        const question = passengerQuestion(nextField, currentIndex, total, berthOpts);
        state.context = updateConversationMeta(state.context, { lastAskedField: nextField, pendingQuestion: question }, nowIso(state));
        state.panel = { kind: 'passengers', current: currentIndex, total, label: `Passenger ${currentIndex}` };
        state.chips = chipsForPassengerField(nextField, state.context.selectedClass);
        return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
      }
      const passengers = [...state.context.passengers, updatedDraft];
      state.context = { ...state.context, passengers, passengerDraft: null, updatedAt: nowIso(state) };
      if (passengers.length < (state.context.passengerCount ?? passengers.length)) {
        transitionStage(state, 'PASSENGER_DETAILS_REQUIRED');
        const question = passengerQuestion('passengerName', passengers.length + 1, state.context.passengerCount ?? passengers.length);
        state.context = updateConversationMeta(state.context, { lastAskedField: 'passengerName', pendingQuestion: question }, nowIso(state));
        state.panel = { kind: 'passengers', current: passengers.length + 1, total: state.context.passengerCount ?? passengers.length, label: 'Passenger details' };
        return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
      }
      return presentFinalReview(state, usedFallback, []);
    }
  }

  let value: string | number | null = null;
  if (field === 'passengerName' && /^[A-Za-z][A-Za-z .]{1,39}$/.test(text)) value = text.replace(/\s+/g, ' ');
  if (field === 'passengerAge') {
    const age = Number(text.match(/^\d{1,3}$/)?.[0] ?? NaN);
    value = Number.isInteger(age) && age >= 1 && age <= 120 ? age : null;
  }
  if (field === 'passengerGender') {
    const normalized = text.toLowerCase().replace(/[?.!]+$/, '');
    const mapped = /^(m|male|man|mr|boy|ladka|purush|aadmi|mard)$/.test(normalized)
      ? 'M'
      : /^(f|female|woman|ms|mrs|girl|ladki|stree|aurat|mahila)$/.test(normalized)
        ? 'F'
        : /^(t|trans|transgender|other|other gender)$/.test(normalized)
          ? 'T'
          : null;
    value = mapped;
  }
  if (field === 'passengerBerth') {
    const normalized = text.toLowerCase().replace(/[?.!]+$/, '');
    const allowed = berthsForClass(context.selectedClass) ?? [];
    value = /^(koi nahi|no|none|nahi|nahi chahiye|koi preference nahi)$/.test(normalized)
      ? ''
      : allowed.find((option) => normalized === option || normalized.startsWith(option)) ?? null;
  }

  if (value === null) {
    const berthOpts = field === 'passengerBerth' ? berthsForClass(context.selectedClass) : null;
    const question = passengerQuestion(field, currentIndex, total, berthOpts);
    state.context = updateConversationMeta(state.context, { pendingQuestion: question }, nowIso(state));
    state.chips = chipsForPassengerField(field, context.selectedClass);
    return finish(state, 'BOOK_TRAIN', `Samajh nahi aaya — ${question}`, { usedFallbackNlu: usedFallback });
  }

  // Store the field on the in-progress passenger.
  const updatedDraft =
    field === 'passengerName'
      ? { ...draft, name: String(value) }
      : field === 'passengerAge'
        ? { ...draft, age: Number(value) }
        : field === 'passengerGender'
          ? { ...draft, gender: value as 'M' | 'F' | 'T' }
          : { ...draft, berthPreference: value === '' ? null : String(value) };
  state.context = { ...context, passengerDraft: updatedDraft, updatedAt: nowIso(state) };

  // Next field: name → age → gender → berth (skip berth when the class has no berths).
  let nextField: ContextSlotField | null =
    field === 'passengerName' ? 'passengerAge'
    : field === 'passengerAge' ? 'passengerGender'
    : field === 'passengerGender' ? 'passengerBerth'
    : null;
  if (nextField === 'passengerBerth' && !berthsForClass(state.context.selectedClass)) {
    nextField = null;
  }

  if (nextField) {
    const berthOpts = nextField === 'passengerBerth' ? berthsForClass(state.context.selectedClass) : null;
    const question = passengerQuestion(nextField, currentIndex, total, berthOpts);
    state.context = updateConversationMeta(state.context, { lastAskedField: nextField, pendingQuestion: question }, nowIso(state));
    state.panel = { kind: 'passengers', current: currentIndex, total, label: `Passenger ${currentIndex}` };
    state.chips = chipsForPassengerField(nextField, state.context.selectedClass);
    return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
  }

  // Passenger complete → start the next one or move to the final review.
  const passengers = [...state.context.passengers, updatedDraft];
  state.context = { ...state.context, passengers, passengerDraft: null, updatedAt: nowIso(state) };

  if (passengers.length < (state.context.passengerCount ?? passengers.length)) {
    transitionStage(state, 'PASSENGER_DETAILS_REQUIRED');
    const question = passengerQuestion('passengerName', passengers.length + 1, state.context.passengerCount ?? passengers.length);
    state.context = updateConversationMeta(state.context, { lastAskedField: 'passengerName', pendingQuestion: question }, nowIso(state));
    state.panel = { kind: 'passengers', current: passengers.length + 1, total: state.context.passengerCount ?? passengers.length, label: 'Passenger details' };
    return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
  }

  return presentFinalReview(state, usedFallback, []);
}

/**
 * §17 + UNIVERSAL ENGINE: after a fresh search, intelligence clauses in the
 * SAME message ("kaunsi tez", "subah wali", "sabse pehle pahunch") produce a
 * factual mini-note from the VERIFIED current list via query-intelligence.ts.
 * Never estimates: if the winning value's field is missing for any candidate,
 * summarizeSearchIntelligence returns null and we keep the base search reply.
 */
function maybeAppendFastestNote(state: TurnState, reply: string): string {
  const lower = state.message.toLowerCase();
  const wantedNow =
    /(fastest|sabse tez|jaldi pahunch|kaunsi (better|best|tez)|subah|dopahar|shaam|raat|morning|afternoon|evening|night|earliest|sabse pehle|sabse late|longest|shortest)/.test(lower);
  const wantedEarlier = state.context.pendingFastestHint;
  if (!wantedNow && !wantedEarlier) return reply;
  const results = state.context.lastSearchResults ?? [];
  if (results.length === 0) return reply;

  // "best" with no stated criteria is ambiguous → ask, never guess.
  if (bestClarificationNeeded(state, lower)) {
    return `${reply}\n\n(Kis criteria par best chahiye — sabse tez, sabse pehle pahunch, ya sabse sasta fare? Yeh bataiye, main current list se nikal doonga.)`;
  }

  // Deferred "fastest" hint: the search ran on a LATER turn (date was answered),
  // so the current message has no comparison words — compute the fastest from the
  // VERIFIED results directly (same framing the original engine produced).
  if (wantedEarlier) {
    state.context = { ...state.context, pendingFastestHint: false, updatedAt: nowIso(state) };
    const best = pickBestByMetric(results, { metric: 'duration', direction: 'min', label: 'fastest' });
    if (best) {
      const name = best.name ? ` — ${best.name}` : '';
      return `${reply}\n\n(Sabse tez: ${best.number}${name}, duration ${formatDuration(best.value)} — current results se.)`;
    }
    return reply; // missing duration → honest: no fastest claim
  }

  // Same-turn intelligence clause (day-part / fastest / earliest in THIS message).
  const note = summarizeSearchIntelligence(results, state.message, false);
  if (!note) return reply;
  // A time-of-day (day-part) note is already acknowledged above via searchFilterAck
  // ("Samajh gaya …") whenever a filter was applied this turn — don't repeat it.
  // Superlative notes (fastest/earliest/longest) still carry their own meaning.
  if (state.filterHint && note.startsWith('(')) return reply;
  // Day-part/empty-bucket notes already carry their own "(...)" framing; only
  // wrap the bare superlative (fastest/earliest/longest) notes.
  const wrapped = note.startsWith('(') ? note : `(${note.replace(/\.$/, '')} — current results se.)`;
  return `${reply}\n\n${wrapped}`;
}

/** "best/kaunsi best/better" with no explicit basis and no context preference → clarify. */
function bestClarificationNeeded(state: TurnState, lower: string): boolean {
  if (!/\b(kaunsi|konsi|which|best|better|sabse badiya)\b/.test(lower)) return false;
  if (/\b(fare|price|paisa|available|availability|seat|status|live|ticket|chahiye)\b/.test(lower)) return false;
  if ((state.context.lastSearchResults?.length ?? 0) === 0) return false;
  return isBestAmbiguous(state.message, hasContextBasis(state.context));
}

/** Whether the conversation already indicates an explicit preference basis. */
function hasContextBasis(context: ConversationContext): boolean {
  return Boolean(context.pendingFastestHint) || context.lastToolResult?.tool === 'getFare';
}

/** §13: the complete final review — the ONLY state in which "haan" means confirm. */
async function presentFinalReview(state: TurnState, usedFallback: boolean, prefixParts: string[]): Promise<OrchestratorTurn> {
  const fare = state.context.lastFareQuote;
  if (!fare || fare.breakdown.totalMinor === null) {
    // No verified fare → no review, no confirmation. Honest stop.
    state.context = updateConversationMeta(state.context, { lastAskedField: null, pendingQuestion: null }, nowIso(state));
    return finish(
      state,
      'BOOK_TRAIN',
      [...prefixParts, '', 'Fare abhi verified nahi hai — review/confirm nahi kar sakta. Thodi der baad phir try karein.'].join('\n'),
      { usedFallbackNlu: usedFallback },
    );
  }

  const draftResult = await executeTool(state, 'createBookingDraft', {
    originCode: state.context.origin?.code ?? '',
    destinationCode: state.context.destination?.code ?? '',
    journeyDate: state.context.journeyDate,
    trainNumber: state.context.selectedTrain?.number ?? '',
    travelClass: state.context.selectedClass ?? '',
    passengerCount: state.context.passengerCount ?? state.context.passengers.length,
  });
  const draft = dataOf<BookingDraft>(draftResult);
  if (!draft) {
    return finish(state, 'BOOK_TRAIN', railwayUnavailableReply(draftResult), { usedFallbackNlu: usedFallback });
  }

  transitionStage(state, 'FARE_REVIEW');
  transitionStage(state, 'WAITING_CONFIRMATION');
  const railwayTotal = fare.breakdown.totalMinor;
  const summary = buildBookingSummary({ context: state.context, railwayFareMinor: railwayTotal, availabilityStatus: state.context.lastAvailability?.status ?? null });
  const review = finalReviewReply({ summary, draftId: draft.id });
  state.panel = { kind: 'review', summary, draftId: draft.id };
  state.context = updateConversationMeta(
    state.context,
    { lastAskedField: null, pendingQuestion: 'Sab details sahi hain? Kya main booking confirm karun? (haan / nahi)' },
    nowIso(state),
  );
  return finish(
    state,
    'BOOK_TRAIN',
    [...prefixParts, '', review, '(Confirm karne par bhi ye sirf DEMO booking hogi — real ticket/PNR/paisa nahi.)'].join('\n'),
    { usedFallbackNlu: usedFallback },
  );
}

async function createDraftAndReply(state: TurnState, usedFallback: boolean): Promise<OrchestratorTurn> {
  const draftResult = await executeTool(state, 'createBookingDraft', {
    originCode: state.context.origin?.code ?? '',
    destinationCode: state.context.destination?.code ?? '',
    journeyDate: state.context.journeyDate,
    trainNumber: state.context.selectedTrain?.number ?? '',
    travelClass: state.context.selectedClass ?? '',
    passengerCount: state.context.passengerCount ?? 1,
  });
  const draft = dataOf<BookingDraft>(draftResult);
  if (!draft) {
    return finish(state, 'BOOK_TRAIN', railwayUnavailableReply(draftResult), { usedFallbackNlu: usedFallback });
  }
  if (draft.fareQuote && draft.fareQuote.breakdown.totalMinor !== null) {
    // Full review presented → only NOW is a confirmation meaningful (§20).
    state.context = updateConversationMeta(state.context, { bookingStage: 'FARE_REVIEW' }, nowIso(state));
    state.context = updateConversationMeta(
      state.context,
      {
        bookingStage: 'WAITING_CONFIRMATION',
        lastAskedField: null,
        pendingQuestion: 'Confirm karein? (haan / nahi)',
      },
      nowIso(state),
    );
    const reply = bookingReviewReply({
      draftId: draft.id,
      trainNumber: draft.trainNumber ?? '?',
      trainName: state.context.selectedTrain?.name ?? null,
      travelClass: draft.travelClass ?? '?',
      journeyDate: draft.journeyDate ?? '?',
      originCode: draft.originCode ?? '?',
      destinationCode: draft.destinationCode ?? '?',
      passengerCount: draft.passengerCount ?? 1,
      fareLines: fareLinesForReview(draft.fareQuote),
    });
    return finish(state, 'BOOK_TRAIN', `${reply}\n(Final booking execution abhi enabled nahi hai — haan bolne par bhi abhi paise nahi katenge.)`, {
      usedFallbackNlu: usedFallback,
    });
  }
  const reply = draftReply(draft.id, draft.trainNumber, draft.travelClass, draft.passengerCount);
  return finish(state, 'BOOK_TRAIN', `${reply}\n(Fare abhi available nahi hai, isliye review/confirm baad mein hoga.)`, {
    usedFallbackNlu: usedFallback,
  });
}

function isVagueSeatRequest(message: string): boolean {
  const trimmed = message.trim();
  return (
    /\b(yeh|ye|this|wo|woh|usi|particular)\s+((wali|wala|particular)\s+)?(seat|class|berth)\b/i.test(trimmed) ||
    /^(usi?|yeh?|wo)\s+(seat|class)\s*(chahiye)?[.!?]?$/i.test(trimmed)
  );
}

interface FollowUpRequest {
  intent: Intent;
  travelClass: string | null;
}

/**
 * §2/§11 follow-up understanding. A short message that ONLY carries a data
 * noun (or a pronoun + noun, or a bare class refinement) reuses the selected
 * train/class from context — the customer never repeats the train number.
 */
function resolveFollowUp(message: string, context: ConversationContext): FollowUpRequest | null {
  const trimmed = message.trim().toLowerCase();
  const words = trimmed.split(/\s+/);
  if (words.length > 5) return null;              // follow-ups are SHORT turns
  // "3A seat chahiye" / "yeh particular seat" is a booking pick, not a data follow-up.
  if (/\bchahiye\b/i.test(trimmed) || isVagueSeatRequest(message)) return null;
  // While PASSENGER DETAILS are being collected, a short reply IS the passenger's
  // answer (even if it looks like a class like "SL" — passenger may say "sleeper chahiye"
  // as berth preference). Never divert the flow to fare/availability here.
  if (isPassengerField(context.lastAskedField)) return null;
  if (/\b\d{4,6}\b/.test(trimmed)) return null;     // explicit train number → normal dispatch
  if (/\d{10}\b/.test(trimmed)) return null;         // PNR → normal dispatch
  if (/\b(se|from|tak|to)\b/.test(trimmed) && words.length > 2) return null; // route phrasing → normal flow

  const trainContext = context.selectedTrain !== null || (context.lastSearchResults?.length ?? 0) > 0;
  if (!trainContext) return null;

  const pronoun = /(\buska|uski|iska|iski|usme|usmen|ismein|isme|yeh|ye |woh|wahi|same|uski|uska)/.test(` ${trimmed} `);
  const asksAvailability = /\bavailability\b|\bavailable\b|\bseats?\b|\bwl\b|waitlist/.test(trimmed)
    || (/\b(cc|ec|sl|1a|2a|3a|3e|2s)\b/.test(trimmed) && /\b(hai|hain|milegi|milega)\b/.test(trimmed) && !/kya hota|matlab|meaning|what is/i.test(trimmed)); // "isme CC hai?" — never glossary questions
  const asksFare = /\bfare\b|\bprice\b|\bpaise|paisa\b|\bpadega|padenge\b/.test(trimmed);
  const asksLive = /\blive\b|\babhi\b|\bkaha|kahan|\blate\b|\bstatus\b/.test(trimmed);
  const asksTimetable = /\btimetable\b|time\s*table|\bschedule\b|\bstops?\b|\brukti|rukti\b/.test(trimmed);
  // "CC mein?" directly after a fare/availability answer = a class refinement of THAT question.
  // (If we are actively ASKING for a class, a bare class is the ANSWER to that question, not a refinement.)
  const bareClass = /^(?:cc|ec|sl|1a|2a|3a|3e|2s)(?:\s+(?:mein|mien|me))?\??$/.test(trimmed)
    && context.lastAskedField !== 'selectedClass';
  if (bareClass) {
    if (context.lastToolResult?.tool === 'getFare') return { intent: 'GET_FARE', travelClass: trimmed.match(/\b(1a|2a|3a|3e|cc|ec|sl|2s)\b/)![0]!.toUpperCase() };
    if (context.lastToolResult?.tool === 'getAvailability') return { intent: 'GET_AVAILABILITY', travelClass: trimmed.match(/\b(1a|2a|3a|3e|cc|ec|sl|2s)\b/)![0]!.toUpperCase() };
    return null;
  }

  const asksAnything = asksAvailability || asksFare || asksLive || asksTimetable;
  if (!asksAnything) return null; // a bare class with no prior fare/availability answer is NOT a follow-up

  // Shape: pronoun+noun ("uska fare"), bare noun ("availability?"), leading "aur" ("aur availability?"),
  // or class+noun ("CC mein availability") — otherwise let the normal dispatch handle it.
  const bareNounQuestion = /^[^\s]*\??$|^(aur|and)\s/.test(trimmed) || (asksAnything && words.length <= 4 && !/[a-z]+\s+(se|tak)\s/.test(trimmed));
  const isFollowUpShape = pronoun || bareNounQuestion || trimmed.includes(' availability') || trimmed.startsWith('availability');
  if (!isFollowUpShape) return null;

  const classToken = trimmed.match(/\b(1a|2a|3a|3e|cc|ec|sl|2s)\b/);
  const travelClass = classToken ? classToken[1]!.toUpperCase() : context.selectedClass;
  const hasClass = travelClass !== null;

  if (asksAvailability && (hasClass || context.selectedClass)) return { intent: 'GET_AVAILABILITY', travelClass: travelClass ?? context.selectedClass };
  if (asksFare) return { intent: 'GET_FARE', travelClass };
  if (asksLive) return { intent: 'LIVE_TRAIN_STATUS', travelClass: null };
  if (asksTimetable) return { intent: 'GET_TIMETABLE', travelClass: null };
  return null;
}

async function routeFollowUp(state: TurnState, followUp: FollowUpRequest, usedFallback: boolean): Promise<OrchestratorTurn> {
  state.wasFollowUp = true;
  // A follow-up interrupts an active booking (paused + resumed afterwards) — context is never replaced.
  await maybePauseForInterruption(state, followUp.intent);

  if (followUp.travelClass) {
    state.context = setContextSlots(state.context, { selectedClass: followUp.travelClass as never }, 'FILL_MISSING', nowIso(state));
  }

  const fakeUnderstanding: AIUnderstandingResult = {
    intent: followUp.intent,
    confidence: 0.85,
    slots: {
      originQuery: null, destinationQuery: null, journeyDate: null, dateText: null,
      passengerCount: null, trainNumber: null, secondTrainNumber: null,
      travelClass: followUp.travelClass as never, pnr: null, resultReference: null,
      isCorrection: false, mentionedStations: [], glossaryTerm: null,
    },
    missingFields: [],
    toolRequest: null,
  };

  switch (followUp.intent) {
    case 'GET_FARE': return handleFare(state, fakeUnderstanding, usedFallback);
    case 'GET_AVAILABILITY': return handleAvailability(state, fakeUnderstanding, usedFallback);
    case 'LIVE_TRAIN_STATUS': return handleLiveStatus(state, fakeUnderstanding, usedFallback);
    case 'GET_TIMETABLE': return handleSimpleTrainTool(state, fakeUnderstanding, 'getTimetable', 'timetable', usedFallback);
    default: return finish(state, 'UNKNOWN', rephraseReply(), { usedFallbackNlu: usedFallback });
  }
}

/**
 * UNIVERSAL ENGINE §7 — deterministic duration DIFFERENCE from the CURRENT
 * verified list. Handles "doosri wali fastest se kitni slow hai?" /
 * "pehli wali slowest se kitni tez hai?". Always uses provider-verified
 * durations; if either train's duration is missing it says so honestly and
 * NEVER estimates a number.
 */
function resolveTrainCalculation(state: TurnState, message: string): { reply: string; trainNumber: string | null } | null {
  const results = state.context.lastSearchResults ?? [];
  if (results.length < 2) return null;
  const trimmed = message.trim().toLowerCase();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words > 12) return null;
  // A DIFFERENCE question compares TWO trains ("doosri wali fastest se kitni
  // slow hai?"). A bare "doosri wali kitni fast hai?" asks one train's own
  // duration — that is a result-detail question, not a difference.
  const isDifference =
    /\b(se|sa)\s+(kitni|kitna|kitne|kita)\b/.test(trimmed) || // "… se kitni/kitna …"
    /\bdifference\b/.test(trimmed) ||
    /\b(ki?ti?ni?|kitna)\s+(slow|dheere|tez|fast|jaldi|der|zyada|kam|minute)\b/.test(trimmed) && /\b(se|vs)\b/.test(trimmed);
  if (!isDifference) return null;

  // The ANCHOR is the named superlative — independent of the relative predicate.
  // "fastest/sabse tez/shortest" → MIN duration; "slowest/longest/sabse dheere"
  // → MAX duration. The predicate ("kitni slow/tez") only changes the phrasing.
  const anchorFast = /(fastest|sabse tez|shortest|sabse kam samay|sabse jaldi pahunch)/.test(trimmed);
  const anchorSlow = /(slowest|longest|sabse dheere|sabse zyada samay)/.test(trimmed);
  const anchorIsFastest = anchorFast && !anchorSlow;
  const request: ComparisonRequest = anchorIsFastest
    ? { metric: 'duration', direction: 'min', label: 'fastest' }
    : { metric: 'duration', direction: 'max', label: 'slowest' };
  const anchor = pickBestByMetric(results, request);
  if (!anchor) return null;

  // The other train: a typed number, or an ordinal ("doosri wali").
  const typed = [...message.matchAll(/\b(\d{5})\b/g)].map((match) => match[1]!);
  const ordinal = trimmed.match(/\b(pehli|first|doosri|dusri|doosra|second|teesri|tisri|third|last|aakhri|upar|neeche)\b/);
  let reference: TrainSearchResult | null = null;
  if (typed.length === 1) {
    reference = results.find((entry) => entry.train.number === typed[0]) ?? null;
  } else if (ordinal) {
    const ref = ordinal[1]!;
    if (ref === 'last' || ref === 'aakhri') reference = results[results.length - 1]!;
    else {
      const idx = ref === 'pehli' || ref === 'first' || ref === 'upar' ? 0 : ref === 'doosri' || ref === 'dusri' || ref === 'doosra' || ref === 'second' ? 1 : ref === 'teesri' || ref === 'tisri' || ref === 'third' ? 2 : 0;
      reference = results[idx] ?? null;
    }
  }
  if (!reference) return null;
  if (reference.train.number === anchor.number) {
    reference = results.find((entry) => entry.train.number !== anchor.number) ?? null;
  }
  if (!reference) return null;

  const anchorDuration = results.find((entry) => entry.train.number === anchor.number)?.durationMinutes ?? null;
  if (anchorDuration === null || reference.durationMinutes === null) {
    return {
      reply: `${reference.train.number} aur ${anchor.number} ka duration provider data mein nahi mila — isliye main difference andaza nahi lagata.`,
      trainNumber: reference.train.number,
    };
  }
  const diff = Math.abs(reference.durationMinutes - anchorDuration);
  const referenceSlower = reference.durationMinutes > anchorDuration;
  const anchorLabel = anchorIsFastest ? 'fastest' : 'slowest';
  const verb = referenceSlower ? 'dheere (slower)' : 'tez (faster)';
  const reply = `${reference.train.number} ${anchorLabel} train (${anchor.number}) se ${diff} minute ${verb} hai.`;
  return { reply, trainNumber: reference.train.number };
}

/** "doosri wali kitni fast hai?" → factual answer from the CURRENT result list (no provider call, no guessing). */
function resolveResultDetailQuestion(message: string, context: ConversationContext): { intent: Intent; reply: string; trainNumber: string | null } | null {
  const results = context.lastSearchResults ?? [];
  if (results.length === 0) return null;
  const trimmed = message.trim().toLowerCase();
  if (trimmed.split(/\s+/).length > 7) return null;
  if (!/(fast|tez|jaldi|late|der|duration|samay|time lagta)/.test(trimmed)) return null;

  const ordinal = trimmed.match(/\b(pehli|first|doosri|dusri|doosra|second|teesri|tisri|third|last|aakhri|neeche|upar)\b/);
  if (!ordinal) return null; // bare "fastest kaunsi hai?" stays a COMPARE question
  let entry = results[0];
  if (ordinal) {
    const reference = ordinal[1] === 'pehli' || ordinal[1] === 'first' || ordinal[1] === 'upar' ? '1'
      : ordinal[1] === 'doosri' || ordinal[1] === 'dusri' || ordinal[1] === 'doosra' || ordinal[1] === 'second' ? '2'
      : ordinal[1] === 'teesri' || ordinal[1] === 'tisri' || ordinal[1] === 'third' ? '3'
      : 'last';
    entry = resolveResultReference(reference, results) ?? results[0]!;
  } else if (/fastest|sabse tez/.test(trimmed)) {
    entry = [...results].sort((a, b) => (a.durationMinutes ?? Infinity) - (b.durationMinutes ?? Infinity))[0]!;
  }
  if (!entry) return null;

  const duration = entry.durationMinutes !== null ? `${Math.floor(entry.durationMinutes / 60)}h ${entry.durationMinutes % 60}m` : '(duration provider se nahi mila)';
  const reply = `${entry.train.number}${entry.train.name ? ` — ${entry.train.name}` : ''}: dep ${entry.departureTime ?? '?'} → arr ${entry.arrivalTime ?? '?'}, duration ${duration}.`;
  return { intent: 'GET_TIMETABLE', reply, trainNumber: entry.train.number };
}

/** §12/§22: deterministic detection of mid-flow change requests. */
type BookingChange =
  | { target: 'train'; trainNumber?: string }
  | { target: 'class'; travelClass?: string }
  | { target: 'date' }
  | { target: 'passenger' }
  | { target: 'passengerCount'; value: number };

function detectBookingChange(message: string, context: ConversationContext): BookingChange | null {
  const lower = message.toLowerCase();
  const active = context.bookingStage !== 'IDLE';
  if (!active) return null;

  // "12014 nahi 14542" — two train numbers + correction marker
  const numbers = [...message.matchAll(/\b(\d{5})\b/g)].map((m) => m[1]!);
  if (numbers.length === 2 && /nahi|badal|change|ki jagah/.test(lower)) {
    return { target: 'train', trainNumber: numbers[1] };
  }
  // "CC nahi SL" — two class tokens + correction marker (take the LAST one)
  const classTokens = [...lower.matchAll(/\b(1a|2a|3a|3e|cc|ec|sl|2s)\b/g)].map((m) => m[1]!);
  if (classTokens.length >= 2 && /nahi|badal|change|ki jagah/.test(lower)) {
    return { target: 'class', travelClass: classTokens[classTokens.length - 1]!.toUpperCase() };
  }
  if (/(train|gaadi)\w*\s*(change|badal)/.test(lower) || /(change|badal)\w*\s*(train|gaadi)/.test(lower)) return { target: 'train' };
  if (/class\s*(change|badal)/.test(lower) || /(change|badal)\s*class/.test(lower)) return { target: 'class' };
  if (/date\s*(change|badal)/.test(lower) || /(change|badal)\s*(date|din)/.test(lower)) return { target: 'date' };
  if (/passenger\w*\s*(change|badal)/.test(lower) || /(change|badal)\s*passenger/.test(lower)) return { target: 'passenger' };
  // "2 nahi 3 passengers" — explicit count correction
  const countCorrection = lower.match(/\b(\d)\s+nahi\s+(\d)\s+passenger/);
  if (countCorrection) {
    const corrected = Number(countCorrection[2]);
    if (corrected >= 1 && corrected <= 6) return { target: 'passengerCount', value: corrected };
  }
  return null;
}

async function applyBookingChange(state: TurnState, change: BookingChange, usedFallback: boolean): Promise<OrchestratorTurn> {
  if (change.target === 'date') {
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'journeyDate', pendingQuestion: 'Bilkul. Kis date ko jaana hai? (aaj / kal / parso ya exact date)' },
      nowIso(state),
    );
    return finish(state, 'BOOK_TRAIN', 'Bilkul. Kis date ko jaana hai? (aaj / kal / parso ya exact date)', { usedFallbackNlu: usedFallback });
  }

  if (change.target === 'train') {
    const results = state.context.lastSearchResults ?? [];
    let question = 'Kaunsi train leni hai? (current list se number ya naam bataiye)';
    invalidateTrainSelection(state);
    state.context = updateConversationMeta(state.context, { bookingStage: 'SEARCH_RESULTS', lastAskedField: 'selectedTrain', pendingQuestion: question }, nowIso(state));
    if (change.trainNumber) {
      const found = results.find((entry) => entry.train.number === change.trainNumber);
      if (found) {
        state.context = setContextSlots(state.context, { selectedTrain: found.train }, 'FILL_MISSING', nowIso(state));
        state.context = updateConversationMeta(state.context, { bookingStage: 'TRAIN_SELECTED' }, nowIso(state));
        const classQ = askClassNow(state);
        question = `Theek hai — ${found.train.number} select ho gayi. ${classQ}`;
      } else {
        question = `${change.trainNumber} current result list mein nahi hai — list se train number/naam bataiye.`;
        state.context = updateConversationMeta(state.context, { pendingQuestion: question }, nowIso(state));
      }
    }
    return finish(state, 'BOOK_TRAIN', question, { usedFallbackNlu: usedFallback });
  }

  if (change.target === 'class') {
    invalidateClassSelection(state);
    if (change.travelClass) {
      state.context = setContextSlots(state.context, { selectedClass: change.travelClass as never }, 'FILL_MISSING', nowIso(state));
      state.context = updateConversationMeta(state.context, { bookingStage: 'CLASS_SELECTED' }, nowIso(state));
      return continueBookingFlow(state, usedFallback);
    }
    state.context = updateConversationMeta(state.context, { bookingStage: 'TRAIN_SELECTED' }, nowIso(state));
    return finish(state, 'BOOK_TRAIN', `Bilkul. ${askClassNow(state)}`, { usedFallbackNlu: usedFallback });
  }

  if (change.target === 'passengerCount') {
    // Only the count changes; collected passenger DETAILS are invalidated (list size changed).
    state.context = setContextSlots(state.context, { passengerCount: change.value }, 'CORRECT', nowIso(state));
    state.context = { ...state.context, passengers: [], passengerDraft: null, updatedAt: nowIso(state) };
    if (state.context.selectedTrain && state.context.selectedClass) {
      return continueBookingFlow(state, usedFallback); // asks passenger 1 of N fresh
    }
    return finish(state, 'BOOK_TRAIN', `Theek hai — ${change.value} passengers. ${askClassNow(state)}`, { usedFallbackNlu: usedFallback });
  }

  // passenger change → restart passenger collection
  state.context = { ...state.context, passengers: [], passengerDraft: null, updatedAt: nowIso(state) };
  state.context = updateConversationMeta(state.context, { bookingStage: 'PASSENGER_DETAILS_REQUIRED' }, nowIso(state));
  const question = passengerQuestion('passengerName', 1, state.context.passengerCount ?? 1);
  state.context = updateConversationMeta(state.context, { lastAskedField: 'passengerName', pendingQuestion: question }, nowIso(state));
  return finish(state, 'BOOK_TRAIN', `Bilkul — passenger details dobara se lete hain.\n${question}`, { usedFallbackNlu: usedFallback });
}

/** §20: a bare YES is a booking confirmation ONLY while a full review is pending. */
function isAwaitingBookingConfirmation(context: ConversationContext): boolean {
  return (
    context.bookingStage === 'WAITING_CONFIRMATION' &&
    typeof context.pendingQuestion === 'string' &&
    /confirm/i.test(context.pendingQuestion)
  );
}

/** Internal deterministic tool call (SERVER actor) — used for confirmation recording. */
async function executeServerTool(state: TurnState, tool: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
  const call: ToolCall = {
    id: newId('tc'),
    tool,
    input,
    requestedBy: 'SERVER',
    conversationId: state.context.id,
    createdAt: new Date().toISOString(),
  };
  const result = await state.deps.toolRegistry.execute(call, {
    actor: 'SERVER',
    userId: state.context.userId,
    conversationId: state.context.id,
    call,
  });
  state.toolCalls.push(call);
  state.toolResults.push(result);
  return result;
}

async function handleBookingConfirmation(
  state: TurnState,
  utterance: string,
  accepted: boolean,
  usedFallback: boolean,
): Promise<OrchestratorTurn> {
  if (accepted) {
    // 1. Deterministically record the explicit YES (only valid with a pending review).
    const draftId = latestDraftId(state);
    const recorded = await executeServerTool(state, 'acknowledgeBookingConfirmation', { draftId, utterance });
    if (!recorded.ok) {
      state.context = updateConversationMeta(state.context, { pendingQuestion: null }, nowIso(state));
      return finish(state, 'BOOK_TRAIN', `Confirmation record nahi ho payi: ${recorded.error?.message ?? 'unknown'}`, {
        usedFallbackNlu: usedFallback,
      });
    }

    // 2. Deterministic MOCK booking handler — DEMO only (no real ticket/PNR/payment).
    const executed = await executeServerTool(state, 'executeMockBooking', { draftId });
    state.context = updateConversationMeta(state.context, { pendingQuestion: null }, nowIso(state));
    if (executed.ok && executed.data) {
      transitionStage(state, 'CONFIRMED');
      const booking = executed.data as { id: string; totalChargedMinor: number | null; isDemo?: boolean };
      return finish(state, 'BOOK_TRAIN', mockBookingSuccessReply(booking), { usedFallbackNlu: usedFallback });
    }
    transitionStage(state, 'FAILED');
    const reason = executed.error?.code === 'INSUFFICIENT_BALANCE'
      ? executed.error.message
      : executed.error?.message ?? 'unknown error';
    return finish(state, 'BOOK_TRAIN', mockBookingFailureReply(reason), { usedFallbackNlu: usedFallback });
  }
  state.context = updateConversationMeta(
    state.context,
    { bookingStage: 'SEARCH_RESULTS', pendingQuestion: null },
    nowIso(state),
  );
  return finish(state, 'BOOK_TRAIN', confirmationDeclinedReply(), { usedFallbackNlu: usedFallback });
}

function latestDraftId(state: TurnState): string {
  // The review reply ends with "(Draft <id>)" — recover it from the transcript.
  const match = [...state.context.messages].reverse().find((message) => message.content.includes('(Draft '));
  return match?.content.match(/\(Draft ([^)]+)\)/)?.[1] ?? '';
}

// ── single-train railway questions ───────────────────────────────────────────

async function maybePauseForInterruption(state: TurnState, intent: Intent): Promise<void> {
  const activeBooking = state.context.bookingStage !== 'IDLE';
  const isBookingTurn = intent === 'BOOK_TRAIN' || intent === 'SEARCH_TRAIN';
  if (activeBooking && !isBookingTurn && !state.context.pausedBooking) {
    state.context = savePausedBooking(state.context, 'USER_INTERRUPTION', nowIso(state));
  }
}

/** §23: after an interruption answer, explicitly offer to resume the booking. */
function resumePromptSuffix(context: ConversationContext): string {
  const paused = context.pausedBooking;
  if (!paused) return '';
  const question = paused.pendingQuestion ?? 'Booking continue karein?';
  return `\n\n(Wapas aapki booking par aa jaate hain — ${question})`;
}

function resolveTurnTrainNumber(u: AIUnderstandingResult, context: ConversationContext): string | null {
  if (u.slots.trainNumber) return u.slots.trainNumber;
  if (context.selectedTrain) return context.selectedTrain.number;
  if (context.lastReferencedTrain) return context.lastReferencedTrain.number;
  return null;
}

/** Remember the train a data answer was about, so "uska fare?" resolves to it. */
function rememberTrain(state: TurnState, trainNumber: string): void {
  if (state.context.selectedTrain?.number === trainNumber) {
    state.context = { ...state.context, lastReferencedTrain: state.context.selectedTrain, updatedAt: nowIso(state) };
    return;
  }
  const fromResults = state.context.lastSearchResults?.find((entry) => entry.train.number === trainNumber)?.train ?? null;
  const minimal: Train = fromResults ?? {
    number: trainNumber, name: null, originStation: null, destinationStation: null,
    departureTime: null, arrivalTime: null, runsOn: null, travelClasses: null, pantryCar: null,
  };
  state.context = { ...state.context, lastReferencedTrain: minimal, updatedAt: nowIso(state) };
}

async function handleLiveStatus(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'LIVE_TRAIN_STATUS');
  const trainNumber = resolveTurnTrainNumber(u, state.context);
  if (!trainNumber) {
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'selectedTrain', pendingQuestion: 'Kaunsi train? (number bataiye)' },
      nowIso(state),
    );
    return finish(state, 'LIVE_TRAIN_STATUS', 'Kaunsi train? (number bataiye)', { usedFallbackNlu: usedFallback });
  }
  const journeyDate = u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null;
  rememberTrain(state, trainNumber);
  const result = await executeTool(state, 'getLiveStatus', { trainNumber, ...(journeyDate ? { journeyDate } : {}) });
  const status = dataOf<LiveStatus>(result);
  const reply = status ? liveStatusReply(status) : railwayUnavailableReply(result);
  return finish(state, 'LIVE_TRAIN_STATUS', reply, { factsFromTools: !status, usedFallbackNlu: usedFallback });
}

async function handleAvailability(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'GET_AVAILABILITY');
  // §8: remember the class as soon as it is mentioned — train/class are NEVER re-asked.
  if (u.slots.travelClass) {
    state.context = setContextSlots(state.context, { selectedClass: u.slots.travelClass }, 'FILL_MISSING', nowIso(state));
  }
  const trainNumber = resolveTurnTrainNumber(u, state.context);
  if (!trainNumber) {
    return finish(state, 'GET_AVAILABILITY', 'Kaunsi train ke liye seats check karun? (number bataiye)', { usedFallbackNlu: usedFallback });
  }
  const from = state.context.origin?.code;
  const to = state.context.destination?.code;
  if (!from || !to) {
    // Persist the train/class/date and — if the user already named a route THIS
    // turn ("asr jn se ndls") — resolve it now instead of asking again.
    const resolved = await snapshotAndMaybeResolveDataRoute(state, u, usedFallback, 'GET_AVAILABILITY', trainNumber);
    if (resolved) return resolved;
    return finish(state, 'GET_AVAILABILITY', 'Kis route ke liye availability chahiye? (jaise: Amritsar se Ludhiana)', {
      usedFallbackNlu: usedFallback,
    });
  }
  {
    const blocked = await refuseIfTrainSkipsSegment(state, trainNumber, from, to, 'GET_AVAILABILITY', usedFallback);
    if (blocked) return blocked;
  }
  const journeyDate = (u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null) ?? state.context.journeyDate;
  if (!journeyDate) {
    snapshotPendingDataRoute(state, u, 'GET_AVAILABILITY', trainNumber);
    state.context = updateConversationMeta(
      state.context,
      { lastAskedField: 'journeyDate', pendingQuestion: 'Kis date ke liye availability chahiye? (aaj/kal/parso ya date)' },
      nowIso(state),
    );
    return finish(state, 'GET_AVAILABILITY', 'Kis date ke liye availability chahiye? (aaj/kal/parso ya date)', {
      usedFallbackNlu: usedFallback,
    });
  }
  // Persist the resolved date so a later class-ask snapshot keeps it.
  if (state.context.journeyDate !== journeyDate) {
    state.context = setContextSlots(state.context, { journeyDate }, 'FILL_MISSING', nowIso(state));
  }
  const travelClass = u.slots.travelClass ?? state.context.selectedClass;
  if (!travelClass) {
    snapshotPendingDataRoute(state, u, 'GET_AVAILABILITY', trainNumber);
    await ensureTrainClasses(state, trainNumber);
    return finish(state, 'GET_AVAILABILITY', askClassNow(state), { usedFallbackNlu: usedFallback });
  }
  // FIX (user complaint): if the selected train's VERIFIED classes don't include the
  // requested class, say so honestly and re-ask — never show fake availability.
  const offeredClasses = state.context.selectedTrain?.travelClasses ?? null;
  if (offeredClasses && offeredClasses.length > 0 && !offeredClasses.includes(travelClass)) {
    state.context = setContextSlots(state.context, { selectedClass: null }, 'FILL_MISSING', nowIso(state));
    const question = `${trainNumber} mein ${travelClass} class available nahi hai — is train mein ${offeredClasses.join('/')} classes hain. ${askClassNow(state)}`;
    return finish(state, 'GET_AVAILABILITY', question, { usedFallbackNlu: usedFallback });
  }
  rememberTrain(state, trainNumber);
  const result = await executeTool(state, 'getAvailability', {
    trainNumber,
    journeyDate,
    travelClass,
    fromStationCode: from,
    toStationCode: to,
  });
  const availability = dataOf<Availability>(result);
  const reply = availability ? availabilityReply(availability) : railwayUnavailableReply(result);
  return finish(state, 'GET_AVAILABILITY', reply, { factsFromTools: !availability, usedFallbackNlu: usedFallback });
}

async function handleFare(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'GET_FARE');
  const trainNumber = resolveTurnTrainNumber(u, state.context);
  if (!trainNumber) {
    return finish(state, 'GET_FARE', 'Kaunsi train ka fare chahiye? (number bataiye)', { usedFallbackNlu: usedFallback });
  }
  const from = state.context.origin?.code;
  const to = state.context.destination?.code;
  if (!from || !to) {
    const resolved = await snapshotAndMaybeResolveDataRoute(state, u, usedFallback, 'GET_FARE', trainNumber);
    if (resolved) return resolved;
    return finish(state, 'GET_FARE', 'Kis route ka fare chahiye? (jaise: Amritsar se Ludhiana)', { usedFallbackNlu: usedFallback });
  }
  {
    const blocked = await refuseIfTrainSkipsSegment(state, trainNumber, from, to, 'GET_FARE', usedFallback);
    if (blocked) return blocked;
  }
  const journeyDate = (u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null) ?? state.context.journeyDate;
  rememberTrain(state, trainNumber);
  const result = await executeTool(state, 'getFare', {
    trainNumber,
    fromStationCode: from,
    toStationCode: to,
    ...(journeyDate ? { journeyDate } : {}),
    ...(u.slots.travelClass ? { travelClass: u.slots.travelClass } : {}),
  });
  const fare = dataOf<Fare>(result);
  if (fare && fare.breakdown.totalMinor !== null) {
    return finish(state, 'GET_FARE', fareReply(fare), { factsFromTools: true, usedFallbackNlu: usedFallback });
  }
  // total UNKNOWN → fare unavailable (never approximated, never ₹0)
  return finish(state, 'GET_FARE', 'Fare abhi available nahi hai (provider ne total fare nahi diya).', {
    factsFromTools: true,
    usedFallbackNlu: usedFallback,
  });
}

async function handleSimpleTrainTool(
  state: TurnState,
  u: AIUnderstandingResult,
  tool: 'getTimetable' | 'getTrainInfo',
  _replyKey: string,
  usedFallback: boolean,
): Promise<OrchestratorTurn> {
  const intent: Intent = tool === 'getTimetable' ? 'GET_TIMETABLE' : 'GET_TRAIN_INFO';
  await maybePauseForInterruption(state, intent);
  const trainNumber = resolveTurnTrainNumber(u, state.context);
  if (!trainNumber) {
    return finish(state, intent, 'Kaunsi train? (number bataiye)', { usedFallbackNlu: usedFallback });
  }
  rememberTrain(state, trainNumber);
  const result = await executeTool(state, tool, { trainNumber });
  if (tool === 'getTimetable') {
    const timetable = dataOf<Timetable>(result);
    if (!timetable) {
      return finish(state, intent, railwayUnavailableReply(result), { factsFromTools: true, usedFallbackNlu: usedFallback });
    }
    // Arrival-time question ("kitne baje pahunchi thi", "kab pahunchti hai") →
    // highlight the scheduled arrival at the referenced (or destination) stop.
    if (isArrivalTimeQuestion(state.message)) {
      return finish(state, intent, arrivalTimeReply(state.message, timetable, trainNumber), {
        factsFromTools: false,
        usedFallbackNlu: usedFallback,
      });
    }
    // Stoppage question ("does X stop at Y?" / "X Y pe rukti hai?") → answer the
    // membership from the REAL stops; never a guess.
    if (isStoppageQuestion(state.message)) {
      return finish(state, intent, stoppageReply(u, state.message, timetable, trainNumber), {
        factsFromTools: false,
        usedFallbackNlu: usedFallback,
      });
    }
    return finish(state, intent, timetableReply(timetable), { factsFromTools: false, usedFallbackNlu: usedFallback });
  }
  const train = dataOf<Train>(result);
  // §12: exact speed is only answerable from a VERIFIED provider field (we have none) — never estimated.
  if (/\bspeed\b|\baraftar\b/i.test(state.message)) {
    const label = train ? `${train.number}${train.name ? ` — ${train.name}` : ''}` : trainNumber;
    return finish(
      state,
      intent,
      `${label} ki EXACT speed provider data mein available nahi hai — main andaza nahi lagata. Train type aur route se speed badalti hai; official timetable se average speed nikal sakte hain (distance ÷ duration).`,
      { factsFromTools: !train, usedFallbackNlu: usedFallback },
    );
  }
  return finish(state, intent, train ? trainInfoReply(train) : railwayUnavailableReply(result), {
    factsFromTools: !train,
    usedFallbackNlu: usedFallback,
  });
}

/** Is the message asking WHEN a train arrives (not "what is the whole timetable")? */
function isArrivalTimeQuestion(message: string): boolean {
  return /(kitn[ei]?\s*(baje|bje|time)|kab\s+(pahunch|pahunchti|pahuch)|pahunch\s*(time|kab)|arrival\s*time|arrive)/i.test(message) ||
    /(pahunchi|pahunchti|pahuchi|pahuchti|pahuch)\s*(thi|thae|gayi)?\s*(hai)?\b/i.test(message);
}

/**
 * "Does train X stop at station Y?" — a stoppage / route-membership check.
 * Matches Hinglish/Hindi ("12053 Ludhiana rukti hai?") and English
 * ("does 12053 stop at Ludhiana", "stops at X"). Never answers itself — it only
 * decides to route to the timetable so the backend can check the REAL stops.
 */
function isStoppageQuestion(message: string): boolean {
  const lower = message.toLowerCase().replace(/[?.!]+$/, '');
  return (
    /\b(ruk(ta|ti|te|a)|ruke?|rukte|ruki)\b/.test(lower) ||
    /(stop(s|ped)?)\b/.test(lower) ||
    /\bstop(s|ped)?\s+(at|on|par)\b/.test(lower) ||
    /\bdoes\b.*\bstop(s|ped)?\b/.test(lower)
  );
}

/** The station the user asks about in a stoppage question: destination > origin > mentioned[0]. */
function stoppageTargetQuery(u: AIUnderstandingResult, message: string): string | null {
  // `||` (not `??`) so an EMPTY string from the model counts as "not given".
  const q = u.slots.destinationQuery?.trim() || u.slots.originQuery?.trim() || (u.slots.mentionedStations ?? []).find(Boolean) || null;
  if (q) return q;
  // Fallback to any alphabetic word that is clearly a station (not stopwords/filler).
  const words = message.match(/[A-Za-z]{2,}/g) ?? [];
  const filler = /^(ruk|ruka|rukti|rukta|rukte|ruki|hai|hain|kya|kaun|kaunsi|kaunsa|station|train|train[0-9]|stops?|stop|ka|ki|ke|ko|par|mein|at|does|the|is|batao|batao|na)$/i;
  return words.find((w) => !filler.test(w)) ?? null;
}

/** True (with the stop) when `query` matches a stop in the verified timetable. */
function findStopForQuery(stops: readonly TrainStop[], query: string): TrainStop | null {
  const norm = (x: string) => x.toLowerCase().replace(/\b(j[n]|junction|station|halt)\b/g, '').replace(/\s+/g, ' ').trim();
  const qn = norm(query);
  if (!qn) return null;
  for (const stop of stops) {
    const code = (stop.stationCode ?? '').toLowerCase();
    const name = norm(stop.stationName ?? '');
    const candidate = norm(`${stop.stationName ?? ''} ${stop.stationCode}`);
    if (stationCodesMatch(code, qn) || (name && (name.includes(qn) || qn.includes(name))) || candidate === qn) return stop;
  }
  return null;
}

/** Answer a stoppage question from the VERIFIED timetable — never a guess. */
function stoppageReply(u: AIUnderstandingResult, message: string, timetable: Timetable, trainNumber: string): string {
  const query = stoppageTargetQuery(u, message);
  if (!query) return timetableReply(timetable); // no station named → full timetable
  const label = `${trainNumber}${timetable.trainName ? ` — ${timetable.trainName}` : ''}`;
  const stop = findStopForQuery(timetable.stops, query);
  if (stop) {
    const at = stop.arrivalTime ?? stop.departureTime;
    const day = stop.dayCount ? ` (day ${stop.dayCount})` : '';
    return `${label} ${stop.stationName ?? stop.stationCode} par rukti hai — scheduled ${at ?? 'takriban'}${day} ka halt.`;
  }
  const names = timetable.stops.map((s) => s.stationName ?? s.stationCode);
  const preview = names.slice(0, 5).join(', ');
  return `${label} ${query} par nahi rukti. ${timetable.stops.length} stops hain: ${preview}${names.length > 5 ? ' …' : ''}`;
}

/**
 * Answer a "kitne baje pahunchi" question from the VERIFIED timetable: the
 * scheduled arrival at the referenced stop, or the destination (last) stop.
 * Always real timetable data — never a guessed clock time. If the stop's
 * arrival is missing, it says so honestly.
 */
function arrivalTimeReply(message: string, timetable: Timetable, trainNumber: string): string {
  const stops = timetable.stops;
  const name = (stop: Timetable['stops'][number]) => stop.stationName ?? stop.stationCode ?? '';
  if (!stops || stops.length === 0) {
    return `${trainNumber} ka arrival time timetable mein nahi mila.`;
  }
  const messageLower = message.toLowerCase();
  const referenced = stops.find((stop) => {
    const text = `${name(stop)} ${stop.stationCode ?? ''}`.toLowerCase().trim();
    return text.length > 1 && messageLower.includes(text);
  });
  // Default to the destination (last stop) for "destination par pahunch".
  const stop = referenced ?? stops[stops.length - 1]!;
  const arrival = stop.arrivalTime ?? null;
  if (!arrival) {
    return `${trainNumber} ${name(stop)} ka arrival time provider data mein nahi mila — main andaza nahi lagata.`;
  }
  return `${trainNumber} ${name(stop)} par ${arrival} baje (scheduled) pahunchti hai. ... Ye scheduled timetable hai — actual arrival thodi pehle ya late ho sakti hai.`.replace(' ... ', '\n');
}

async function handlePnr(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'CHECK_PNR');
  if (!u.slots.pnr) {
    return finish(state, 'CHECK_PNR', 'PNR number bataiye (10 digits)', { usedFallbackNlu: usedFallback });
  }
  const result = await executeTool(state, 'checkPNR', { pnr: u.slots.pnr });
  const status = dataOf<PNRStatus>(result);
  return finish(state, 'CHECK_PNR', status ? pnrReply(status) : railwayUnavailableReply(result), {
    factsFromTools: !status,
    usedFallbackNlu: usedFallback,
  });
}

async function handleBookings(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'VIEW_BOOKINGS');
  const result = await executeTool(state, 'getBookings', {});
  const bookings = dataOf<unknown[]>(result) ?? [];
  return finish(state, 'VIEW_BOOKINGS', bookingsReply(bookings), { usedFallbackNlu: usedFallback });
}

async function handleWallet(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'VIEW_WALLET');
  const result = await executeTool(state, 'getWallet', {});
  return finish(state, 'VIEW_WALLET', walletReply(result), { usedFallbackNlu: usedFallback });
}

async function handleCancelled(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'GET_CANCELLED_TRAINS');
  const journeyDate = (u.slots.dateText ? resolveDateText(u.slots.dateText, state.now) : null) ?? state.now.toISOString().slice(0, 10);
  const result = await executeTool(state, 'getCancelledTrains', { journeyDate });
  const trains = dataOf<CancelledTrain[]>(result);

  if (!trains) {
    // Never claim a train is cancelled (or not) without provider evidence.
    const unavailable = railwayUnavailableReply(result);
    return finish(
      state,
      'GET_CANCELLED_TRAINS',
      u.slots.trainNumber ? `${u.slots.trainNumber} ke cancel hone ka confirmation abhi nahi de sakta — ${unavailable}` : unavailable,
      { factsFromTools: true, usedFallbackNlu: usedFallback },
    );
  }

  // "Train 12014 cancel hai?" → evidence-based yes/no for THAT train
  if (u.slots.trainNumber) {
    return finish(state, 'GET_CANCELLED_TRAINS', cancelledSpecificReply(u.slots.trainNumber, trains), {
      usedFallbackNlu: usedFallback,
    });
  }

  // Station-filtered request? The provider list is NOT station-filterable — say so honestly (§17).
  const stationFiltered = state.context.origin || state.context.destination || u.slots.originQuery;
  const reply = stationFiltered
    ? cancelledListUnfilteredReply(trains.length, trains)
    : cancelledReply(trains);
  return finish(state, 'GET_CANCELLED_TRAINS', reply, { usedFallbackNlu: usedFallback });
}

async function handleStationLookup(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  const query = u.slots.mentionedStations[0] ?? u.slots.originQuery ?? u.slots.destinationQuery;
  if (!query) {
    return finish(state, 'LOOKUP_STATION', 'Kaunsa station? (naam bataiye)', { usedFallbackNlu: usedFallback });
  }
  const result = await executeTool(state, 'lookupStation', { query: canonicalLookupQuery(query) });
  const stations = dataOf<Station[]>(result);
  return finish(state, 'LOOKUP_STATION', stations ? stationsReply(stations) : railwayUnavailableReply(result), {
    factsFromTools: !stations,
    usedFallbackNlu: usedFallback,
  });
}

/** Step 9 §7 + UNIVERSAL ENGINE: deterministic comparison result — verified values only. */
export interface ComparisonResult {
  winner: string | null;
  metric: string;
  verifiedValue: string | null;
  comparedTrains: string[];
  /** Provenance tag — always 'deterministic' (never AI-estimated). */
  source: 'deterministic';
}

const hhmmToMinutes = (time: string | null): number | null => {
  if (!time) return null;
  const parts = time.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? 0);
  return Number.isFinite(h) ? h * 60 + m : null;
};

/** Comparison direction: 'min' (fastest/earliest/shortest) or 'max' (longest/latest). */
export type ComparisonDirection = 'min' | 'max';

/** Deterministic metric detection from natural language. */
function detectComparisonMetric(message: string): { metric: 'duration' | 'arrival' | 'departure'; direction: ComparisonDirection } {
  const lower = message.toLowerCase();
  if (/longest|sabse zyada (samay|time|der)|zyada time lagat|sabse dheere|slowest/.test(lower)) {
    return { metric: 'duration', direction: 'max' }; // "longest journey" → MAX duration
  }
  if (/latest\s+departure|sabse late nikal/.test(lower)) return { metric: 'departure', direction: 'max' };
  if (/jaldi[\w\s]{0,20}pahunch|pahunch[\w\s]{0,20}jaldi|pehle[\w\s]{0,20}pahunch|earliest arrival/.test(lower)) return { metric: 'arrival', direction: 'min' };
  if (/pehle\s+\w+\s+(nikal|chalu)|earliest departure|sabse pehle nikal/.test(lower)) return { metric: 'departure', direction: 'min' };
  return { metric: 'duration', direction: 'min' }; // fastest / shortest / default
}

/** Pure comparison on VERIFIED search-result values; missing timing → no winner (never estimated). */
export function compareTrainsDeterministic(
  results: readonly TrainSearchResult[],
  a: TrainSearchResult,
  b: TrainSearchResult,
  metric: 'duration' | 'arrival' | 'departure',
  direction: ComparisonDirection = 'min',
): ComparisonResult {
  void results;
  const comparedTrains = [a.train.number, b.train.number];
  const valueOf = (entry: TrainSearchResult): number | null =>
    metric === 'duration' ? entry.durationMinutes : metric === 'arrival' ? hhmmToMinutes(entry.arrivalTime) : hhmmToMinutes(entry.departureTime);
  const valueA = valueOf(a);
  const valueB = valueOf(b);
  if (valueA === null || valueB === null) {
    return { winner: null, metric, verifiedValue: null, comparedTrains, source: 'deterministic' };
  }
  // LONGEST uses MAX — never the fastest/MIN logic (Step 9 regression fix).
  const winner = direction === 'max' ? (valueA >= valueB ? a : b) : valueA <= valueB ? a : b;
  const value = direction === 'max' ? Math.max(valueA, valueB) : Math.min(valueA, valueB);
  return { winner: winner.train.number, metric, verifiedValue: String(value), comparedTrains, source: 'deterministic' };
}

function formatMinutes(minutes: string): string {
  const total = Number(minutes);
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/** True when THIS message names a new A→B route (not a superlative over the current list). */
function namesNewRouteThisTurn(message: string): boolean {
  return (
    /(?:[\u0900-\u097F]|[A-Za-z])[^\s,!.?;]*\s+(?:se|from)\s+(?:[\u0900-\u097F]|[A-Za-z])/i.test(message) ||
    /\bfrom\s+\S+\s+(?:to|tak)\s+\S+/i.test(message)
  );
}

function listSuperlativeReply(
  best: { number: string; name: string | null; value: number; metric: string; direction: string; label: string },
  entry: TrainSearchResult,
  listSize: number,
): string {
  const name = best.name ? ` — ${best.name}` : '';
  const shown = best.metric === 'duration' ? formatDuration(best.value) : formatClock(best.value);
  const metricWord =
    best.metric === 'duration'
      ? best.direction === 'max'
        ? 'duration (sabse zyada samay)'
        : 'duration (sabse kam time)'
      : best.metric === 'arrival'
        ? 'arrival'
        : 'departure';
  const dep = entry.departureTime ?? '?';
  const arr = entry.arrivalTime ?? '?';
  return [
    `Current list ki ${listSize} trains mein se ${best.label}: ${best.number}${name}, ${metricWord} ${shown} (dep ${dep} → arr ${arr}).`,
    `WINNER: ${best.number}`,
    'Sirf yahi train dikha raha hoon — class tap karke book kar sakte ho.',
  ].join('\n');
}

async function answerListSuperlative(state: TurnState, usedFallback: boolean): Promise<OrchestratorTurn> {
  const results = state.context.lastSearchResults ?? [];
  const request = detectComparisonRequest(state.message);
  if (!request) {
    return finish(
      state,
      'COMPARE_TRAINS',
      'Kis criteria par compare karun — sabse tez, sabse pehle pahunch, ya sabse lambi? Current list se nikal doonga.',
      { usedFallbackNlu: usedFallback, sourceClass: 'COMPARISON' },
    );
  }
  const best = pickBestByMetric(results, request);
  if (!best) {
    return finish(
      state,
      'COMPARE_TRAINS',
      `Current list mein is metric ke liye kam se kam 2 trains ka verified ${request.metric} nahi mila — main andaza nahi lagata.`,
      { usedFallbackNlu: usedFallback, sourceClass: 'COMPARISON' },
    );
  }
  const entry = results.find((row) => row.train.number === best.number);
  if (!entry) {
    return finish(
      state,
      'COMPARE_TRAINS',
      'Winner current list mein nahi mila — main andaza nahi lagata.',
      { usedFallbackNlu: usedFallback, sourceClass: 'COMPARISON' },
    );
  }
  state.cards = [toTrainCard(entry)];
  state.wasFollowUp = true;
  rememberTrain(state, best.number);
  state.context = updateConversationMeta(
    state.context,
    { bookingStage: 'SEARCH_RESULTS', lastAskedField: 'selectedTrain', pendingQuestion: 'Kaunsi train leni hai?' },
    nowIso(state),
  );
  return finish(state, 'COMPARE_TRAINS', listSuperlativeReply(best, entry, results.length), {
    usedFallbackNlu: usedFallback,
    sourceClass: 'COMPARISON',
    allowAiNarration: !usedFallback,
  });
}

async function answerOpenListQuestion(state: TurnState, usedFallback: boolean): Promise<OrchestratorTurn> {
  const results = state.context.lastSearchResults ?? [];
  state.wasFollowUp = true;
  const fallbackText = `Current list mein ${results.length} verified trains hain. Fastest, slowest, ya koi train number poochho — main isi list se jawab doonga.`;
  return finish(state, 'COMPARE_TRAINS', fallbackText, {
    usedFallbackNlu: usedFallback,
    sourceClass: 'COMPARISON',
    allowAiNarration: !usedFallback,
  });
}

async function maybeAnswerListIntelligence(
  state: TurnState,
  _u: AIUnderstandingResult,
  usedFallback: boolean,
): Promise<OrchestratorTurn | null> {
  const results = state.context.lastSearchResults ?? [];
  if (results.length < 2) return null;
  if (isPassengerField(state.context.lastAskedField)) return null;
  if (isAwaitingBookingConfirmation(state.context)) return null;
  if (namesNewRouteThisTurn(state.message)) return null;
  const typed = [...state.message.matchAll(/\b(\d{4,5})\b/g)].map((match) => match[1]!);
  if (typed.length >= 2) return null;
  if (typed.length === 1 && listedTrain(results, typed[0])) return null;
  if (!detectComparisonRequest(state.message)) return null;
  return answerListSuperlative(state, usedFallback);
}

async function handleComparison(state: TurnState, u: AIUnderstandingResult, usedFallback: boolean): Promise<OrchestratorTurn> {
  await maybePauseForInterruption(state, 'COMPARE_TRAINS');
  const results = state.context.lastSearchResults ?? [];
  if (results.length < 2) {
    return finish(
      state,
      'COMPARE_TRAINS',
      'Compare karne ke liye pehle current search results chahiye — "Amritsar se Ludhiana kal" jaisa search karein, phir "12014 aur 14542 mein kaunsi better" poochhiye.',
      { usedFallbackNlu: usedFallback },
    );
  }
  const firstNumber = u.slots.trainNumber;
  const secondNumber = u.slots.secondTrainNumber;
  // Two named trains → pairwise. Superlative with no numbers → winner from the
  // WHOLE current list. Any other list question → NVIDIA phrases from verified facts.
  if (!(firstNumber && secondNumber)) {
    if (detectComparisonRequest(state.message)) return answerListSuperlative(state, usedFallback);
    return answerOpenListQuestion(state, usedFallback);
  }
  const a = results.find((entry) => entry.train.number === firstNumber);
  const b = results.find((entry) => entry.train.number === secondNumber);
  if (!a || !b) {
    return finish(
      state,
      'COMPARE_TRAINS',
      'Dono trains current result list mein honi chahiye — list mein se numbers bataiye (main list ke bahar ki train ke baare mein compare nahi karunga).',
      { usedFallbackNlu: usedFallback },
    );
  }
  // Deterministic engine on VERIFIED values (never AI-estimated).
  const { metric, direction } = detectComparisonMetric(state.message);
  const comparison = compareTrainsDeterministic(state.context.lastSearchResults ?? [], a, b, metric, direction);
  if (comparison.winner === null) {
    const missing = [a, b].filter((entry) =>
      metric === 'duration' ? entry.durationMinutes === null : metric === 'arrival' ? entry.arrivalTime === null : entry.departureTime === null,
    );
    return finish(
      state,
      'COMPARE_TRAINS',
      `Compare nahi kar paya — ${missing.map((entry) => entry.train.number).join(', ')} ka ${metric === 'duration' ? 'duration' : metric === 'arrival' ? 'arrival time' : 'departure time'} provider data mein nahi mila. Main andaza nahi lagata.`,
      { usedFallbackNlu: usedFallback },
    );
  }

  // Optional factual extras: provider fares for both trains on the searched route.
  const from = a.fromStation?.code ?? state.context.origin?.code ?? null;
  const to = a.toStation?.code ?? state.context.destination?.code ?? null;
  let fareA: Fare | null = null;
  let fareB: Fare | null = null;
  if (from && to) {
    const [resultA, resultB] = await Promise.all([
      executeTool(state, 'getFare', { trainNumber: a.train.number, fromStationCode: from, toStationCode: to }),
      executeTool(state, 'getFare', { trainNumber: b.train.number, fromStationCode: from, toStationCode: to }),
    ]);
    fareA = dataOf<Fare>(resultA);
    fareB = dataOf<Fare>(resultB);
  }

  const winnerEntry = comparison.winner === a.train.number ? a : b;
  const metricLabel = metric === 'duration' ? (direction === 'max' ? 'duration (longest)' : 'duration') : metric === 'arrival' ? 'arrival' : 'departure';
  const winnerValue =
    metric === 'duration'
      ? winnerEntry.durationMinutes !== null ? `${Math.floor(winnerEntry.durationMinutes / 60)}h ${winnerEntry.durationMinutes % 60}m` : '?'
      : (metric === 'arrival' ? winnerEntry.arrivalTime : winnerEntry.departureTime) ?? '?';
  const loserEntry = comparison.winner === a.train.number ? b : a;
  const loserValue =
    metric === 'duration'
      ? loserEntry.durationMinutes !== null ? `${Math.floor(loserEntry.durationMinutes / 60)}h ${loserEntry.durationMinutes % 60}m` : '?'
      : (metric === 'arrival' ? loserEntry.arrivalTime : loserEntry.departureTime) ?? '?';

  const lines = [
    `Compare (verified search results se):`,
    `• ${a.train.number}: ${metric === 'duration' ? (a.durationMinutes !== null ? `${Math.floor(a.durationMinutes / 60)}h ${a.durationMinutes % 60}m` : '?') : (metric === 'arrival' ? a.arrivalTime : a.departureTime) ?? '?'} ${metricLabel}`,
    `• ${b.train.number}: ${metric === 'duration' ? (b.durationMinutes !== null ? `${Math.floor(b.durationMinutes / 60)}h ${b.durationMinutes % 60}m` : '?') : (metric === 'arrival' ? b.arrivalTime : b.departureTime) ?? '?'} ${metricLabel}`,
    `→ ${metricLabel} mein WINNER: ${comparison.winner} (${winnerValue}) — ${loserEntry.train.number} ka ${loserValue}.`,
  ];
  // factual departure difference (verified values only)
  const depA = hhmmToMinutes(a.departureTime);
  const depB = hhmmToMinutes(b.departureTime);
  if (depA !== null && depB !== null && depA !== depB) {
    const later = depB > depA ? b : a;
    lines.push(`${later.train.number} ${Math.abs(depB - depA)} minute later nikalti hai.`);
  }
  // factual duration difference
  if (metric === 'duration' && a.durationMinutes !== null && b.durationMinutes !== null && a.durationMinutes !== b.durationMinutes) {
    const diff = Math.abs(a.durationMinutes - b.durationMinutes);
    lines.push(
      direction === 'max'
        ? `Duration mein ${comparison.winner} sabse zyada (${diff} minute extra) samay leti hai.`
        : `Duration mein ${comparison.winner} ${diff} minute tez hai.`,
    );
  }
  if (fareA?.breakdown.totalMinor != null && fareB?.breakdown.totalMinor != null) {
    lines.push(`Railway fare: ${a.train.number} ₹${(fareA.breakdown.totalMinor / 100).toFixed(2)}, ${b.train.number} ₹${(fareB.breakdown.totalMinor / 100).toFixed(2)}.`);
  }
  return finish(state, 'COMPARE_TRAINS', lines.join('\n'), { usedFallbackNlu: usedFallback });
}

export type { Train };
