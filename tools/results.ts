/** ToolResult constructors — every result is produced by SERVER code, never by the AI. */

import type { ToolCall, ToolName, ToolResult, ToolUnavailableReason } from '../shared/index.js';

export function toolSuccess<T>(call: { id?: string | null; tool: ToolName | string }, data: T): ToolResult<T> {
  return {
    callId: call.id ?? null,
    tool: call.tool,
    ok: true,
    data,
    unavailableReason: null,
    error: null,
    executedBy: 'SERVER',
  };
}

export function toolFailure(
  call: { id?: string | null; tool: ToolName | string },
  code: string,
  message: string,
): ToolResult<never> {
  return {
    callId: call.id ?? null,
    tool: call.tool,
    ok: false,
    data: null,
    unavailableReason: null,
    error: { code, message },
    executedBy: 'SERVER',
  };
}

export function toolUnavailable(
  call: { id?: string | null; tool: ToolName | string },
  reason: ToolUnavailableReason,
  message: string,
): ToolResult<never> {
  return {
    callId: call.id ?? null,
    tool: call.tool,
    ok: false,
    data: null,
    unavailableReason: reason,
    error: { code: `TOOL_${reason}`, message },
    executedBy: 'SERVER',
  };
}

export function toolCallRejected(call: { id?: string | null; tool: ToolName | string }, errors: readonly string[]): ToolResult<never> {
  return toolFailure(call, 'TOOL_CALL_REJECTED', `Server rejected this tool call: ${errors.join('; ')}`);
}

export function toolNotImplemented(call: { id?: string | null; tool: ToolName | string }, name: string): ToolResult<never> {
  return toolUnavailable(
    call,
    'NOT_IMPLEMENTED',
    `Tool "${name}" is registered but NOT IMPLEMENTED in Step 1. No railway data was fetched and none was fabricated.`,
  );
}
