/**
 * SEMANTIC MODEL ADAPTERS — wrap the existing provider classes as the minimal
 * `SemanticModelClient` / `SemanticNlu` interfaces the planner needs. Reuses the
 * real NvidiaAIProvider transport (server-side key, key rotation, timeout,
 * thinking-disabled) and the DeterministicNLUProvider (offline, safe, always
 * available). Nothing is duplicated, and no secret leaves the server.
 */

import { NvidiaAIProvider } from '../../ai/providers/NvidiaAIProvider.js';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import type { AIUnderstandingResult } from '../../shared/index.js';
import type { ConversationContext } from '../../shared/index.js';
import type { SemanticModelClient, SemanticNlu } from './semantic-planner.js';

export interface NvidiaClientOptions {
  model: string;
  apiKey: string;
  backupApiKeys?: string[];
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

/** Adapter: NvidiaAIProvider → SemanticModelClient (exposes only `complete`). */
export class NvidiaAIClient implements SemanticModelClient {
  readonly model: string;
  readonly baseUrl: string;
  private readonly provider: NvidiaAIProvider;

  constructor(options: NvidiaClientOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    this.provider = new NvidiaAIProvider({
      apiKey: options.apiKey,
      fallbackApiKeys: options.backupApiKeys,
      model: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  async complete(messages: Array<{ role: string; content: string }>, temperature = 0.0): Promise<unknown> {
    return this.provider.complete(messages, temperature);
  }
}

export function createNvidiaClient(options: NvidiaClientOptions): SemanticModelClient {
  return new NvidiaAIClient(options);
}

/** Adapter: DeterministicNLUProvider → SemanticNlu (offline fallback). */
export class NewDeterministicNlu implements SemanticNlu {
  private readonly provider: DeterministicNLUProvider;
  constructor() {
    this.provider = new DeterministicNLUProvider();
  }

  async understand(input: { userMessage: string; conversation: ConversationContext }): Promise<AIUnderstandingResult> {
    return this.provider.understand({
      userMessage: input.userMessage,
      conversation: input.conversation,
      availableIntents: ['BOOK_TRAIN', 'SEARCH_TRAIN', 'LIVE_TRAIN_STATUS', 'GET_AVAILABILITY', 'GET_FARE', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_PNR', 'GET_CANCELLED_TRAINS', 'COMPARE_TRAINS', 'GENERAL_RAILWAY_QUERY'],
      availableTools: [],
    });
  }
}

export const semanticNlu: SemanticNlu = new NewDeterministicNlu();
