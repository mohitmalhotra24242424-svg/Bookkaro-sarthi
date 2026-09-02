/**
 * TOOL PERMISSION LAYER (Step 3 §4).
 *
 *  READ            → railway read tools + user data (bookings, wallet)
 *  DRAFT           → booking-flow tools that create data but move no money
 *  SENSITIVE_ACTION→ confirmBooking — the AI can NEVER request or execute it;
 *                    final booking needs deterministic application logic plus
 *                    an explicit user confirmation (Step 1 guards unchanged).
 */

import type { ToolName } from '../shared/index.js';

export type ToolPermission = 'READ' | 'DRAFT' | 'SENSITIVE_ACTION';

export const TOOL_PERMISSIONS: Readonly<Record<ToolName, ToolPermission>> = {
  lookupStation: 'READ',
  searchTrains: 'READ',
  getTrainInfo: 'READ',
  getTimetable: 'READ',
  getLiveStatus: 'READ',
  getAvailability: 'READ',
  getFare: 'READ',
  checkPNR: 'READ',
  getCancelledTrains: 'READ',
  getBookings: 'READ',
  getWallet: 'READ',
  getRailwayKnowledge: 'READ',
  compareTrains: 'READ',
  createBookingDraft: 'DRAFT',
  reviewFare: 'DRAFT',
  confirmBooking: 'SENSITIVE_ACTION',
  // Records the user's explicit YES after a full review — deterministic-only.
  acknowledgeBookingConfirmation: 'SENSITIVE_ACTION',
  // Step 5 deterministic MOCK booking boundary: requires a recorded explicit
  // confirmation + verified fare + server-side wallet check. DEMO ONLY.
  executeMockBooking: 'SENSITIVE_ACTION',
};

export function toolPermission(tool: ToolName): ToolPermission {
  return TOOL_PERMISSIONS[tool] ?? 'SENSITIVE_ACTION'; // unknown tools fail closed
}

/** The single authority the orchestrator consults before any AI tool request. */
export function canAiRequestTool(tool: ToolName, registrySaysAiRequestable: boolean): boolean {
  if (toolPermission(tool) === 'SENSITIVE_ACTION') return false; // even if a registry entry is misconfigured
  return registrySaysAiRequestable;
}
