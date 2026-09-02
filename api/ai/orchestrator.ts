/**
 * API-LEVEL AI ORCHESTRATOR (Step 6 §1).
 *
 * Input : { message, conversationId, context }
 * Output: { intent, entities, requiredTools, toolArguments, response,
 *           missingSlots, interrupt, resumeContext, safety }
 *
 * This module is the API façade over the Step 3–5 conversational orchestrator,
 * PLUS the Step-6 dynamic multi-tool path: when a single message asks for
 * several independent data pieces ("fare aur availability dono batao"), the
 * orchestrator selects those tools, executes them IN PARALLEL through the
 * catalog executor, and answers from the returned data only.
 *
 * Safety invariants (unchanged): the AI never receives provider keys, never
 * chooses providers, never books/pays — every execution is server-side,
 * catalog-validated, budget-bounded and routed RailCore→RailKit.
 */

import type { ConversationContext, ToolResult } from '../../shared/index.js';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import type { OrchestratorTurn } from '../../ai/orchestrator.js';
import { availabilityReply, fareReply, liveStatusReply } from '../../ai/replyTemplates.js';
import type { AIProvider } from '../../ai/index.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { executeAiToolCalls, formatToolEnvelope } from './tool-executor.js';
import type { AiToolCallRequest, AiToolExecution, ToolResultEnvelope } from './tool-executor.js';
import type { ToolRegistry } from '../../tools/index.js';
import { semanticToolToCatalogId } from './semantic-tools.js';
import { isAiSelectableTool } from './tool-catalog.js';

export interface OrchestratorInput {
  message: string;
  conversationId: string | null;
  context: ConversationContext;
}

export interface OrchestratorDeps {
  ai: AIProvider;
  registry: ToolRegistry;
  aiTimeoutMs?: number;
  now?: () => Date;
  /**
   * Optional AI-first tool planner. When provided, `runAiOrchestrator` asks the
   * AI (primary → secondary → deterministic NLU) to decide the tool/API set for
   * the message — including MULTI-tool requests — instead of the deterministic
   * regex gate. The deterministic regex is kept ONLY as a fallback when the AI
   * yields no usable plan (i.e. the AI failed), so the AI stays primary and the
   * user's "fetch whichever tool/API is needed" is AI-decided.
   */
  planTools?: (message: string, context: ConversationContext) => Promise<MultiToolPlan | null>;
}

export interface OrchestratorOutput {
  intent: string;
  entities: Record<string, unknown>;
  requiredTools: string[];
  toolArguments: Record<string, unknown>;
  response: string;
  missingSlots: string[];
  interrupt: boolean;
  resumeContext: Record<string, unknown> | null;
  safety: {
    rejections: string[];
    aiCanBook: false;
    aiCanMoveMoney: false;
    providersChosenBy: 'server-router';
    toolCallBudget: number;
  };
  toolEnvelopes: ToolResultEnvelope[];
  // extra fields for the existing chat UI (cards/panel/slots stay compatible)
  turn: OrchestratorTurn;
  context: ConversationContext;
}

// ── multi-tool detection (§10/§11) ────────────────────────────────────────────

interface MultiToolPlan {
  intent: string;
  tools: AiToolCallRequest[];
}

/**
 * Detects a single message that asks for MULTIPLE independent live-data pieces.
 * Only fires when a train is known (from the message or context) and the route
 * is known — otherwise the conversational flow asks for what's missing.
 */
export function detectMultiToolRequest(message: string, context: ConversationContext): MultiToolPlan | null {
  const lower = message.toLowerCase();
  const trainNumber = message.match(/\b(\d{5})\b/)?.[1] ?? context.selectedTrain?.number ?? null;
  if (!trainNumber) return null;

  const from = context.origin?.code ?? context.lastSearchResults?.[0]?.fromStation?.code ?? null;
  const to = context.destination?.code ?? context.lastSearchResults?.[0]?.toStation?.code ?? null;
  const journeyDate = context.journeyDate;
  const travelClass = message.match(/\b(1a|2a|3a|3e|cc|ec|sl|2s)\b/i)?.[1]?.toUpperCase() ?? context.selectedClass;

  const wantsFare = /\bfare\b|\bkitna (padega|hai)\b|price/.test(lower);
  const wantsAvailability = /\bavailab|seats?\b|\bkitni (seat|seats)\b/.test(lower);
  const wantsLive = /\blive\b|\babhi\b|\bkaha hai\b|\blate\b/.test(lower);
  const wantsTimetable = /\btimetable\b|time\s*table|\broute\b|\bstops?\b/.test(lower);

  const selected: AiToolCallRequest[] = [];
  let count = 0;
  if (wantsFare) { count += 1; selected.push({ tool: 'GET_FARE', args: { trainNumber, ...(from ? { fromStationCode: from } : {}), ...(to ? { toStationCode: to } : {}), ...(journeyDate ? { journeyDate } : {}), ...(travelClass ? { travelClass } : {}) } }); }
  if (wantsAvailability) { count += 1; if (journeyDate && travelClass && from && to) selected.push({ tool: 'GET_AVAILABILITY', args: { trainNumber, journeyDate, travelClass, fromStationCode: from, toStationCode: to } }); }
  if (wantsLive) { count += 1; selected.push({ tool: 'GET_LIVE_STATUS', args: { trainNumber, ...(journeyDate ? { journeyDate } : {}) } }); }
  if (wantsTimetable) { count += 1; selected.push({ tool: 'GET_TIMETABLE', args: { trainNumber } }); }

  if (count < 2 || selected.length < 2) return null; // single-tool messages take the normal conversational path
  return { intent: 'MULTI_TOOL_QUERY', tools: selected };
}

/**
 * Build an AI-first multi-tool planner from the semantic AI planner.
 *
 * The semantic planner is ALREADY AI-primary (gpt-oss-20b → nemotron →
 * deterministic NLU); this adapter takes its validated `toolPlan` and maps each
 * semantic tool id to a REAL catalog id, so the SAME catalog validation +
 * ToolRegistry/providers + MAX_TOOL_CALLS budget applies. It returns a plan only
 * when the AI proposes MULTIPLE independent tools; single-tool and booking
 * messages fall through to the normal (also AI-primary) conversational path.
 *
 * Deterministic is used ONLY here as a last-resort fallback: when the planner
 * yields no AI plan (source = nlu / none) we return null, so the deterministic
 * regex gate may still catch a multi-tool query — it never overrides the AI.
 */
export function createAiPlanTools(
  planner: { plan: (message: string, context: ConversationContext) => Promise<{ plan: import('./semantic-plan.js').SemanticPlan | null; usedNlu: boolean }> },
): (message: string, context: ConversationContext) => Promise<MultiToolPlan | null> {
  return async (message, context) => {
    // Comparison ("kaunsi tez/better", "compare", two train numbers) must stay on
    // the deterministic COMPARE_TRAINS path — it compares stored search results,
    // not two fresh timetable fetches. Routing it to a multi-tool fetch would
    // return "data available nahi" (as seen live) instead of the comparison.
    const isComparison = /(kaunsi (better|best|tez|jaldi)|kaun (better|best|tez)|sabse (tez|jaldi|fast|dheere)|compare|comparison|versus|\bvs\b|\bbetter\b|(?:aur|and|vs)\s+\d+)/i.test(message) ||
      ((message.match(/\b\d{4,5}\b/g) ?? []).length >= 2);
    if (isComparison) return null; // let the deterministic COMPARE_TRAINS path handle it

    let result: { plan: import('./semantic-plan.js').SemanticPlan | null; usedNlu: boolean } | null = null;
    try {
      result = await planner.plan(message, context);
    } catch {
      return null; // AI planner failed → non-fatal, deterministic may decide
    }
    if (!result.plan || result.usedNlu) return null; // AI failed → let deterministic decide
    const tools: AiToolCallRequest[] = [];
    for (const call of result.plan.toolPlan) {
      const catalogId = semanticToolToCatalogId(call.tool);
      if (!catalogId || !isAiSelectableTool(catalogId)) continue; // only READ, never PROHIBITED
      tools.push({ tool: catalogId, args: (call.args as Record<string, unknown>) ?? {} });
    }
    if (tools.length < 2) return null; // single-tool handled by the AI-primary conversational path
    return { intent: 'MULTI_TOOL_QUERY', tools };
  };
}

function replyFromExecutions(executions: readonly AiToolExecution[]): string {
  const parts: string[] = [];
  for (const execution of executions) {
    if (!execution.result) continue;
    const data = execution.result.data as Record<string, unknown> | null;
    if (execution.tool === 'GET_FARE' && data) {
      const fare = data as unknown as Parameters<typeof fareReply>[0];
      parts.push(fare.breakdown?.totalMinor != null ? fareReply(fare) : 'Fare abhi available nahi hai.');
    } else if (execution.tool === 'GET_AVAILABILITY' && data) {
      parts.push(availabilityReply(data as unknown as Parameters<typeof availabilityReply>[0]));
    } else if (execution.tool === 'GET_LIVE_STATUS' && data) {
      parts.push(liveStatusReply(data as unknown as Parameters<typeof liveStatusReply>[0]));
    } else {
      parts.push('Abhi railway data available nahi ho raha. Thodi der baad try karein.');
    }
  }
  return parts.join('\n\n');
}

// ── main entry ────────────────────────────────────────────────────────────────

export async function runAiOrchestrator(input: OrchestratorInput, deps: OrchestratorDeps): Promise<OrchestratorOutput> {
  const context = input.context;

  // Step-6 dynamic multi-tool path (parallel execution, budget-bounded).
  // AI-FIRST: when a tool planner is wired, the AI decides which tool/API to
  // fetch (single or multi). The deterministic regex is only a FALLBACK for when
  // the AI produced no usable plan (i.e. the AI failed / is unconfigured).
  let plan: MultiToolPlan | null = null;
  if (deps.planTools) {
    try {
      plan = await deps.planTools(input.message, context);
    } catch {
      plan = null; // AI planner error → fall through to the deterministic gate
    }
  }
  if (!plan) plan = detectMultiToolRequest(input.message, context);
  if (plan) {
    const { executions, budgetExhausted } = await executeAiToolCalls(plan.tools, {
      userId: context.userId,
      conversationId: input.conversationId ?? context.id,
      registry: deps.registry,
    });
    const response = budgetExhausted
      ? `${replyFromExecutions(executions)}\n(Baar tool calls ki limit aa gayi — baaki sawab alag poochhiye.)`
      : replyFromExecutions(executions);

    return {
      intent: plan.intent,
      entities: { trainNumber: plan.tools[0]?.args?.trainNumber ?? null },
      requiredTools: plan.tools.map((tool) => tool.tool),
      toolArguments: Object.fromEntries(plan.tools.map((tool) => [tool.tool, tool.args ?? {}])),
      response,
      missingSlots: [],
      interrupt: context.pausedBooking !== null,
      resumeContext: null,
      safety: {
        rejections: budgetExhausted ? ['tool-call budget exhausted'] : [],
        aiCanBook: false,
        aiCanMoveMoney: false,
        providersChosenBy: 'server-router',
        toolCallBudget: 5,
      },
      toolEnvelopes: executions.map(formatToolEnvelope),
      turn: {
        reply: response,
        context,
        intent: 'MULTI_TOOL_QUERY' as never,
        usedFallbackNlu: false,
        executedTools: executions.map((execution) => execution.tool),
        safetyRejections: [],
        cards: null,
        panel: null,
        chips: null,
        sourceClass: 'LIVE_RAILWAY_DATA',
      },
      context,
    };
  }

  // Standard conversational path (Steps 3–5 — booking, corrections, glossary…).
  const turn = await orchestrateTurn(
    { ai: deps.ai, fallbackNlu: new DeterministicNLUProvider(), toolRegistry: deps.registry, aiTimeoutMs: deps.aiTimeoutMs, now: deps.now },
    context,
    input.message,
  );

  const missingSlots = turn.context.lastAskedField ? [turn.context.lastAskedField] : [];
  const entities: Record<string, unknown> = {
    origin: turn.context.origin?.code ?? null,
    destination: turn.context.destination?.code ?? null,
    journeyDate: turn.context.journeyDate,
    passengerCount: turn.context.passengerCount,
    trainNumber: turn.context.selectedTrain?.number ?? null,
    selectedClass: turn.context.selectedClass,
  };

  return {
    intent: turn.intent,
    entities,
    requiredTools: turn.executedTools,
    toolArguments: {},
    response: turn.reply,
    missingSlots,
    interrupt: turn.context.pausedBooking !== null,
    resumeContext: turn.context.pausedBooking
      ? { pausedAtStage: turn.context.pausedBooking.pausedAtStage, pendingQuestion: turn.context.pausedBooking.pendingQuestion }
      : null,
    safety: {
      rejections: turn.safetyRejections,
      aiCanBook: false,
      aiCanMoveMoney: false,
      providersChosenBy: 'server-router',
      toolCallBudget: 5,
    },
    toolEnvelopes: [],
    turn,
    context: turn.context,
  };
}

export type { ToolResult };
