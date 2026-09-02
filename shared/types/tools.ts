/** Tool name registry — the only tools the AI may ever REQUEST (server validates + executes). */

export type ToolName =
  | 'searchTrains'
  | 'lookupStation'
  | 'getTrainInfo'
  | 'getTimetable'
  | 'getLiveStatus'
  | 'getAvailability'
  | 'getFare'
  | 'getCancelledTrains'
  | 'checkPNR'
  | 'getBookings'
  | 'getWallet'
  | 'getRailwayKnowledge'
  | 'compareTrains'
  | 'createBookingDraft'
  | 'reviewFare'
  | 'confirmBooking'
  | 'acknowledgeBookingConfirmation'
  | 'executeMockBooking';

export type ToolRequester = 'AI' | 'USER' | 'SERVER';

export interface ToolCall {
  id: string;
  tool: ToolName;
  input: Record<string, unknown>;
  requestedBy: ToolRequester;
  conversationId: string | null;
  createdAt: string;
}

export type ToolUnavailableReason = 'NOT_IMPLEMENTED' | 'NO_DATA' | 'UNKNOWN' | 'NO_RESULTS' | 'NOT_FOUND';

export interface ToolResultError {
  code: string;
  message: string;
}

/**
 * Every ToolResult is produced by deterministic SERVER code. `tool` is a
 * string (not ToolName) so rejected calls with a bogus tool name can also be
 * reported honestly.
 */
export interface ToolResult<T = unknown> {
  callId: string | null;
  tool: string;
  ok: boolean;
  data: T | null;
  unavailableReason: ToolUnavailableReason | null;
  error: ToolResultError | null;
  executedBy: 'SERVER';
  /** Which railway provider answered (lowercase, e.g. 'railcore' / 'railkit') — never a credential. */
  provider?: string | null;
}

export type ToolCategory = 'RAILWAY_DATA' | 'USER_DATA' | 'BOOKING_FLOW' | 'PAYMENT';

export type ToolExecutionPolicy =
  /** AI may request; server validates input and executes deterministically. */
  | 'AI_REQUEST_SERVER_VALIDATED'
  /** Only deterministic server code may execute (AI can never request it). */
  | 'DETERMINISTIC_ONLY';

export type ToolSideEffect = 'NONE' | 'CREATES_DRAFT' | 'EXECUTES_BOOKING' | 'MOVES_MONEY';

export type ToolStatus = 'IMPLEMENTED' | 'NOT_IMPLEMENTED';

export type ToolFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'stationCode'
  | 'trainNumber'
  | 'pnr'
  | 'travelClass'
  | 'quota'
  | 'enum'
  | 'trainNumberList';

export interface ToolFieldSpec {
  name: string;
  type: ToolFieldType;
  required: boolean;
  description: string;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

export interface ToolDefinition {
  name: ToolName;
  category: ToolCategory;
  summary: string;
  description: string;
  input: readonly ToolFieldSpec[];
  outputDescription: string;
  /** Can the AI layer request this tool at all? (confirmBooking → false) */
  aiRequestable: boolean;
  executionPolicy: ToolExecutionPolicy;
  sideEffects: ToolSideEffect;
  status: ToolStatus;
  safetyNotes: string;
}

/** Safe, serializable description of a tool — the only shape ever handed to an AI model. */
export interface ToolDescriptor {
  name: ToolName;
  summary: string;
  description: string;
  input: readonly ToolFieldSpec[];
  outputDescription: string;
  aiRequestable: boolean;
  sideEffects: ToolSideEffect;
  status: ToolStatus;
}
