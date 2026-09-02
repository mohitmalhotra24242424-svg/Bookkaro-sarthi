/** Intent vocabulary. The full intent engine is NOT IMPLEMENTED in Step 1. */

import type { ToolName } from './tools.js';

export type Intent =
  | 'BOOK_TRAIN'
  | 'SEARCH_TRAIN'
  | 'LIVE_TRAIN_STATUS'
  | 'GET_AVAILABILITY'
  | 'GET_FARE'
  | 'GET_TRAIN_INFO'
  | 'GET_TIMETABLE'
  | 'LOOKUP_STATION'
  | 'CHECK_PNR'
  | 'VIEW_BOOKINGS'
  | 'VIEW_WALLET'
  | 'GET_CANCELLED_TRAINS'
  | 'COMPARE_TRAINS'
  | 'GENERAL_RAILWAY_QUERY'
  | 'NORMAL_CHAT'
  | 'HELP'
  | 'UNKNOWN';

export interface IntentDefinition {
  intent: Intent;
  title: string;
  description: string;
  examplePhrases: readonly string[];
  suggestedTools: readonly ToolName[];
  /** true → completing this intent requires an explicit user confirmation step. */
  requiresExplicitConfirmation: boolean;
  notes: string | null;
}
