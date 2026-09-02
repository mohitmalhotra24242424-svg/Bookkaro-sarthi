/**
 * AI PROVIDER ABSTRACTION.
 *
 * One interface, many future backends (NVIDIA, Gemini, other) — the
 * orchestration layer will depend only on this interface, so swapping or
 * adding providers never rewrites orchestration.
 *
 * SAFETY CONTRACT:
 *   - understand() interprets the user turn and may REQUEST a tool.
 *   - generateResponse() words the reply from tool results.
 *   - An AIProvider NEVER executes a tool, NEVER debits the wallet and NEVER
 *     executes a booking. It never receives API keys of other services and
 *     never sees deterministic money code paths.
 *
 * Step 1 ships a deterministic MockAIProvider plus NOT-IMPLEMENTED provider
 * stubs. No credentials, no network calls.
 */

import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
} from '../shared/index.js';

export interface AIProvider {
  readonly providerId: string;
  /** Interpret a user turn: intent, extracted slots, missing fields, optional tool REQUEST. */
  understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult>;
  /** Compose the natural-language reply from verified tool results. */
  generateResponse(input: AIReplyInput): Promise<AIReplyResult>;
}
