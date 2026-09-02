/**
 * SEMANTIC AI TOOL PLANNER — RUNTIME WIRING.
 *
 * Composes the multi-model planner (primary gpt-oss-20b → secondary
 * nemotron-3.5-lightning-30b-a3b → deterministic NLU) with the backend
 * orchestrator (catalog validation → ToolRegistry → RailCore→RailKit router).
 * Secrets stay server-side; the AI receives neither keys nor URLs.
 */

import type { ConversationContext } from '../../shared/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { semanticNlu as deterministicNlu, NvidiaAIClient as nvidiaClient, createNvidiaClient } from './semantic-model.js';
import { SemanticPlanner } from './semantic-planner.js';
import type { SemanticModelClient, SemanticNlu } from './semantic-planner.js';
import { restoreSemanticPlan, runSemanticOrchestrator } from './semantic-orchestrator.js';
import type { SemanticTurnResult } from './semantic-orchestrator.js';

export { SemanticPlanner, runSemanticOrchestrator };
export type { SemanticModelClient, SemanticNlu, SemanticTurnResult };

export interface SemanticRunnerConfig {
  registry: ToolRegistry;
  primaryClient: SemanticModelClient;
  secondaryClient: SemanticModelClient | null;
  nlu: SemanticNlu;
  timeoutMs?: number;
  now?: () => Date;
}

export class SemanticRunner {
  readonly planner: SemanticPlanner;
  private readonly registry: ToolRegistry;
  private readonly now: () => Date;

  constructor(config: SemanticRunnerConfig) {
    this.planner = new SemanticPlanner({
      primary: config.primaryClient,
      secondary: config.secondaryClient,
      timeoutMs: config.timeoutMs,
      nlu: config.nlu,
    });
    this.registry = config.registry;
    this.now = config.now ?? (() => new Date());
  }

  async run(message: string, context: ConversationContext, input: { userId: string | null; conversationId: string | null }): Promise<SemanticTurnResult> {
    // If we asked the user to pick a station last turn, do NOT re-run the AI on
    // their short reply (e.g. "pehla" / "ASR"). Restore the interrupted plan and
    // let the orchestrator resolve the choice deterministically + resume the journey.
    if (context.stationChoices) {
      const pendingPlan = restoreSemanticPlan(context.pendingSemanticPlan);
      if (pendingPlan) {
        return runSemanticOrchestrator(pendingPlan, context, { registry: this.registry, now: this.now, message }, input);
      }
    }
    const planResult = await this.planner.plan(message, context);
    return runSemanticOrchestrator(planResult, context, { registry: this.registry, now: this.now, message }, input);
  }
}

// ── factory helpers for wiring in the API layer ──────────────────────────────

export interface SemanticRunnerOptions {
  registry: ToolRegistry;
  primaryModel: string;
  secondaryModel: string | null;
  apiKey: string;
  backupApiKeys?: string[];
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export function createSemanticRunner(options: SemanticRunnerOptions): SemanticRunner {
  const primary = createNvidiaClient({ model: options.primaryModel, apiKey: options.apiKey, backupApiKeys: options.backupApiKeys, baseUrl: options.baseUrl, timeoutMs: options.timeoutMs });
  const secondary = options.secondaryModel
    ? createNvidiaClient({ model: options.secondaryModel, apiKey: options.apiKey, backupApiKeys: options.backupApiKeys, baseUrl: options.baseUrl, timeoutMs: options.timeoutMs })
    : null;
  return new SemanticRunner({
    registry: options.registry,
    primaryClient: primary,
    secondaryClient: secondary,
    nlu: deterministicNlu,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
}

export { semanticNlu as deterministicNlu, NvidiaAIClient as nvidiaClient } from './semantic-model.js';
