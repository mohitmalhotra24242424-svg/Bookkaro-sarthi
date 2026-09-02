/**
 * AI layer contracts.
 *
 * SAFETY: the AI provider only UNDERSTANDS and GENERATES TEXT. It can REQUEST
 * a tool via `toolRequest`, but it can never execute one — all execution is
 * done by deterministic server-side code after validation. AI providers never
 * receive secrets beyond what is listed here and never see wallet debit or
 * booking execution code paths.
 */

import type { ConversationContext, ContextSlotField, SearchFilterHint } from './core.js';
import type { Intent } from './intent.js';
import type { ToolName, ToolResult } from './tools.js';
import type { TravelClassCode } from './railway.js';

/** Free-text slots extracted from one user turn (resolved against context later). */
export interface AISlotExtraction {
  originQuery: string | null;
  destinationQuery: string | null;
  /** Resolved ISO date, if the provider resolved one. */
  journeyDate: string | null;
  /** RAW date expression ("kal", "parso", "aaj", "2026-08-27") — resolved deterministically server-side. */
  dateText: string | null;
  passengerCount: number | null;
  trainNumber: string | null;
  /** Second train for comparisons ("12014 aur 14542"). */
  secondTrainNumber: string | null;
  travelClass: TravelClassCode | null;
  pnr: string | null;
  /** Reference into lastSearchResults: "pehli", "doosri", "third", "last", "upar", or a train number. */
  resultReference: string | null;
  /** true when the user is correcting a previously stated slot ("nahi, Ludhiana se…"). */
  isCorrection: boolean;
  /** All station-like tokens mentioned, for context-aware correction merges. */
  mentionedStations: string[];
  /** Glossary concept the user asked about ("CC", "RAC", "WL", …). */
  glossaryTerm: string | null;
}

/** A REQUEST for a tool — the server decides if it is valid and executes it. */
export interface AIToolRequest {
  tool: ToolName;
  input: Record<string, unknown>;
  rationale: string | null;
}

export interface AIUnderstandingInput {
  userMessage: string;
  conversation: ConversationContext;
  availableIntents: readonly Intent[];
  availableTools: readonly ToolName[];
}

export interface AIUnderstandingResult {
  intent: Intent;
  confidence: number;
  slots: AISlotExtraction;
  missingFields: ContextSlotField[];
  toolRequest: AIToolRequest | null;
  /**
   * OPTIONAL time-of-day/clock-window filter the AI read from the user's turn
   * ("subah/morning ki trains", "4am se 6am ke beech"). The model interprets it
   * — this makes the AI visibly participate in understanding a filter — but the
   * orchestrator always cross-checks it against the user's literal words
   * (deterministic extractSearchFilterHint) before applying it. NEVER used to
   * invent a filter the user didn't ask for.
   */
  searchFilter?: SearchFilterHint | null;
}

export interface AIReplyInput {
  conversation: ConversationContext;
  toolResults: readonly ToolResult[];
  tone: 'FRIENDLY' | 'CONCISE';
  /** The user's exact current turn, so the AI can answer THAT specific question from the verified data (e.g. a stoppage yes/no). */
  userMessage?: string;
}

export interface AIReplyResult {
  message: string;
  askForField: ContextSlotField | null;
}
