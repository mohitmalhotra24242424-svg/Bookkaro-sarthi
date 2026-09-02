/**
 * AI TOOL EXECUTOR (Step 6 §5/§11/§22).
 *
 * The ONLY bridge between an AI tool SELECTION and real execution:
 *   1. the tool must exist in the approved catalog and be AI-selectable;
 *   2. arguments are validated against the catalog spec (no URLs, no methods,
 *      no credentials, strict formats);
 *   3. execution goes through the Step-1 ToolRegistry (which routes through the
 *      ProviderRouter: RailCore primary, RailKit fallback — the AI never
 *      chooses a provider);
 *   4. independent tool calls run in PARALLEL;
 *   5. MAX_TOOL_CALLS_PER_TURN bounds every turn (no infinite tool loops).
 */

import { newId } from '../../shared/index.js';
import type { ToolCall, ToolName, ToolResult } from '../../shared/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { getCatalogTool, isAiSelectableTool, validateToolArguments } from './tool-catalog.js';
import type { CatalogTool } from './tool-catalog.js';

export const MAX_TOOL_CALLS_PER_TURN = 5;

export interface AiToolCallRequest {
  tool: string;
  args?: Record<string, unknown>;
}

export interface AiToolExecution {
  tool: string;
  ok: boolean;
  result: ToolResult | null;
  error: string | null;
  latencyMs: number;
}

export interface ExecutorContext {
  userId: string;
  conversationId: string;
  registry: ToolRegistry;
  budget?: number; // remaining tool-call budget for the turn
}

export interface ExecuteManyOutcome {
  executions: AiToolExecution[];
  budgetExhausted: boolean;
}

/** §21 TOOL RESULT FORMAT — the compact envelope the API/model consumes. */
export interface ToolResultEnvelope {
  success: boolean;
  tool: string;
  provider: string | null;
  data: unknown;
  error: string | null;
  timestamp: string;
}

export function formatToolEnvelope(execution: AiToolExecution): ToolResultEnvelope {
  const result = execution.result;
  return {
    success: Boolean(result?.ok),
    tool: execution.tool,
    provider: result?.provider ?? null,
    data: result?.ok ? result.data : null,
    error: result?.ok ? null : (result?.error?.code ?? 'RAILWAY_DATA_UNAVAILABLE'),
    timestamp: new Date().toISOString(),
  };
}

function notExecutedError(tool: string, message: string): ToolResult {
  return {
    callId: null,
    tool,
    ok: false,
    data: null,
    unavailableReason: null,
    error: { code: 'TOOL_REJECTED', message },
    executedBy: 'SERVER',
  };
}

async function executeOne(request: AiToolCallRequest, context: ExecutorContext): Promise<AiToolExecution> {
  const startedAt = Date.now();

  // 1. Catalog whitelist (PROHIBITED ids are rejected BY NAME).
  const catalogTool: CatalogTool | null = getCatalogTool(request.tool);
  if (!catalogTool) {
    return { tool: request.tool, ok: false, result: notExecutedError(request.tool, `unknown tool "${request.tool}"`), error: `unknown tool "${request.tool}"`, latencyMs: 0 };
  }
  if (!isAiSelectableTool(request.tool)) {
    return {
      tool: request.tool,
      ok: false,
      result: notExecutedError(request.tool, `tool "${request.tool}" is PROHIBITED for the AI (deterministic server-side only)`),
      error: 'prohibited tool',
      latencyMs: 0,
    };
  }

  // 2. Argument validation (formats + forbidden keys).
  const validation = validateToolArguments(request.tool, request.args);
  if (!validation.ok) {
    return {
      tool: request.tool,
      ok: false,
      result: notExecutedError(request.tool, `invalid arguments: ${validation.errors.join('; ')}`),
      error: validation.errors.join('; '),
      latencyMs: Date.now() - startedAt,
    };
  }

  // 3. CONFIRMATION_GATED tools execute only in the correct conversation stage.
  if (catalogTool.permission === 'CONFIRMATION_GATED') {
    return {
      tool: request.tool,
      ok: false,
      result: notExecutedError(request.tool, 'confirmation requests are handled by the deterministic booking flow after a presented review'),
      error: 'gated by booking flow',
      latencyMs: 0,
    };
  }

  // 4. Catalog tools without a registry executable are flow-level (comparison/review) —
  //    the orchestrator handles them conversationally; the executor refuses them here.
  if (catalogTool.registryTool === null) {
    return {
      tool: request.tool,
      ok: false,
      result: notExecutedError(request.tool, `"${request.tool}" is a conversational flow step — no direct execution`),
      error: 'flow-level tool',
      latencyMs: 0,
    };
  }

  // 5. Real execution via the ToolRegistry (ProviderRouter inside).
  const call: ToolCall = {
    id: newId('aitc'),
    tool: catalogTool.registryTool as ToolName,
    input: validation.sanitized,
    requestedBy: 'AI',
    conversationId: context.conversationId,
    createdAt: new Date().toISOString(),
  };
  const result = await context.registry.execute(call, {
    actor: 'AI',
    userId: context.userId,
    conversationId: context.conversationId,
    call,
  });
  return { tool: request.tool, ok: result.ok, result, error: null, latencyMs: Date.now() - startedAt };
}

/**
 * Execute a batch of AI tool selections. Independent data reads run in
 * PARALLEL (§11); the per-turn budget (§22) is enforced before dispatch.
 */
export async function executeAiToolCalls(
  requests: readonly AiToolCallRequest[],
  context: ExecutorContext,
): Promise<ExecuteManyOutcome> {
  const budget = context.budget ?? MAX_TOOL_CALLS_PER_TURN;
  if (requests.length === 0) return { executions: [], budgetExhausted: false };

  const allowed = requests.slice(0, budget);
  const executions = await Promise.all(allowed.map((request) => executeOne(request, context)));

  // Overflow calls are refused with an honest budget error (never silently run).
  for (const overflow of requests.slice(budget)) {
    executions.push({
      tool: overflow.tool,
      ok: false,
      result: notExecutedError(overflow.tool, `tool-call limit reached (max ${MAX_TOOL_CALLS_PER_TURN} per turn)`),
      error: 'budget exhausted',
      latencyMs: 0,
    });
  }
  return { executions, budgetExhausted: requests.length > budget };
}
