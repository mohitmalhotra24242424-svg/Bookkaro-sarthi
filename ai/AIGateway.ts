/**
 * AI GATEWAY (Step 9 §1/§2) — model-agnostic primary/secondary understanding.
 *
 *   GPT-OSS-20B (PRIMARY) → Nemotron 3 (SECONDARY) → (caller's deterministic NLU)
 *
 * Rules enforced here:
 *  - AI-model fallback is COMPLETELY SEPARATE from railway-provider fallback
 *    (RailCore→RailKit happens later inside the ProviderRouter).
 *  - The gateway only UNDERSTANDS. It never executes tools — so a model switch
 *    can never cause a duplicate railway call (execution happens exactly once,
 *    after a valid plan survives the ToolGate).
 *  - A primary response is only accepted when it is a VALID plan (known intent
 *    and either a non-UNKNOWN intent or usable extracted slots); otherwise the
 *    secondary model is tried.
 *  - Secrets never pass through the gateway: it forwards only the message +
 *    conversation + intent vocabulary.
 */

import { isKnownIntent } from '../shared/index.js';
import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
} from '../shared/index.js';
import type { AIProvider } from './AIProvider.js';

export interface AIGatewayOptions {
  primary: AIProvider;
  secondary: AIProvider | null;
  /** Per-model timeout for the understand step. */
  timeoutMs?: number;
}

function hasUsableStructure(result: AIUnderstandingResult): boolean {
  if (result.intent !== 'UNKNOWN') return true;
  const slots = result.slots;
  return (
    slots.trainNumber !== null ||
    slots.secondTrainNumber !== null ||
    slots.pnr !== null ||
    slots.originQuery !== null ||
    slots.destinationQuery !== null ||
    slots.dateText !== null ||
    slots.passengerCount !== null ||
    slots.travelClass !== null ||
    slots.resultReference !== null ||
    slots.glossaryTerm !== null
  );
}

/** A plan is valid when the intent is registered, committed (not UNKNOWN) and usable. */
export function isValidToolPlan(result: AIUnderstandingResult | null | undefined): boolean {
  if (!result) return false;
  if (!isKnownIntent(result.intent)) return false;
  if (result.intent === 'UNKNOWN') return false; // the model must commit; extraction-only turns belong to the deterministic NLU
  return hasUsableStructure(result);
}

export class AIGateway implements AIProvider {
  readonly providerId = 'ai-gateway';

  readonly primary: AIProvider;
  readonly secondary: AIProvider | null;
  private readonly timeoutMs: number;

  /** Test observability: which models were tried on the last understand call. */
  lastAttempted: 'primary' | 'secondary' | 'none' = 'none';

  constructor(options: AIGatewayOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    // PRIMARY (GPT-OSS-20B)
    this.lastAttempted = 'primary';
    try {
      const result = await withTimeout(this.primary.understand(input), this.timeoutMs);
      if (isValidToolPlan(result)) return result;
    } catch {
      // timeout / HTTP failure / malformed output → fall through to the secondary
    }

    // SECONDARY (Nemotron 3 family)
    if (this.secondary) {
      this.lastAttempted = 'secondary';
      const result = await this.secondary.understand(input); // orchestrator's timeout still applies
      if (isValidToolPlan(result)) return result;
      throw new Error('AI_GATEWAY_EXHAUSTED'); // both models unusable → deterministic path
    }

    throw new Error('AI_GATEWAY_EXHAUSTED');
  }

  async generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    try {
      return await withTimeout(this.primary.generateResponse(input), this.timeoutMs);
    } catch {
      if (this.secondary) return this.secondary.generateResponse(input);
      throw new Error('AI_GATEWAY_EXHAUSTED');
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
