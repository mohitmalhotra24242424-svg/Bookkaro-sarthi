/**
 * TOOL REGISTRY.
 *
 * The AI can REQUEST a tool; the SERVER decides whether the call is valid and
 * is the only side that can execute anything. This class is that boundary:
 *   1. validateToolCall() — whitelist name, AI-permission check, strict input schema.
 *   2. execute()          — validation first, then a deterministic executor.
 *      In Step 1 no executors exist: every execute() honestly returns
 *      NOT_IMPLEMENTED with zero data.
 */

import { ValidationError } from '../shared/index.js';
import type { ToolCall, ToolDefinition, ToolDescriptor, ToolName, ToolRequester, ToolResult } from '../shared/index.js';
import { validateToolInput } from './schema.js';
import { toolCallRejected, toolNotImplemented } from './results.js';
import { TOOL_DEFINITIONS } from './definitions.js';

export interface ToolExecutionContext {
  actor: ToolRequester;
  userId: string | null;
  conversationId: string | null;
  /** The validated tool call being executed (for result bookkeeping). */
  call?: ToolCall;
}

/** Deterministic executors are attached in later steps — never by the AI layer. */
export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor | null;
}

export interface ToolCallValidation {
  ok: boolean;
  errors: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<ToolName, RegisteredTool>();

  register(definition: ToolDefinition, executor: ToolExecutor | null = null): void {
    if (!definition?.name || typeof definition.name !== 'string') {
      throw new ValidationError('Tool definition must have a name.');
    }
    if (this.tools.has(definition.name)) {
      throw new ValidationError(`Tool "${definition.name}" is already registered.`);
    }
    const fieldNames = definition.input.map((spec) => spec.name);
    if (new Set(fieldNames).size !== fieldNames.length) {
      throw new ValidationError(`Tool "${definition.name}" has duplicate input fields.`);
    }
    this.tools.set(definition.name, { definition, executor });
  }

  has(name: string): boolean {
    return this.tools.has(name as ToolName);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name as ToolName)?.definition ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }

  /** Serializable, executor-free descriptors — the only shape ever given to an AI model. */
  describeAll(): ToolDescriptor[] {
    return this.list().map((definition) => ({
      name: definition.name,
      summary: definition.summary,
      description: definition.description,
      input: definition.input,
      outputDescription: definition.outputDescription,
      aiRequestable: definition.aiRequestable,
      sideEffects: definition.sideEffects,
      status: definition.status,
    }));
  }

  /** The validation boundary. AI requests stop here unless everything checks out. */
  validateToolCall(call: ToolCall): ToolCallValidation {
    const errors: string[] = [];
    const definition = this.get(call.tool);

    if (!definition) {
      errors.push(`unknown tool "${String(call.tool)}"`);
      return { ok: false, errors };
    }
    if (call.requestedBy === 'AI' && !definition.aiRequestable) {
      errors.push(
        `tool "${definition.name}" is DETERMINISTIC_ONLY — the AI is not authorized to request it`,
      );
    }
    const inputCheck = validateToolInput(definition.input, call.input);
    errors.push(...inputCheck.errors);
    return { ok: errors.length === 0, errors };
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const validation = this.validateToolCall(call);
    if (!validation.ok) {
      return toolCallRejected(call, validation.errors);
    }
    const entry = this.tools.get(call.tool);
    if (!entry) {
      return toolCallRejected(call, [`unknown tool "${String(call.tool)}"`]);
    }
    if (entry.definition.status !== 'IMPLEMENTED' || !entry.executor) {
      return toolNotImplemented(call, entry.definition.name);
    }
    return entry.executor(call.input, { ...context, call });
  }
}

/** Default registry: all 15 tools defined, zero executors (Step 1). */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of TOOL_DEFINITIONS) {
    registry.register(definition, null);
  }
  return registry;
}
