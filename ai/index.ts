export * from './AIProvider.js';
export * from './MockAIProvider.js';
export * from './providers/DeterministicNLUProvider.js';
export * from './providers/NvidiaAIProvider.js';
export * from './providers/GeminiAIProvider.js';
export * from './structuredOutput.js';
export * from './timeout.js';
export * from './slotResolution.js';
export * from './replyTemplates.js';
export * from './orchestrator.js';

import type { AIProvider } from './AIProvider.js';
import { MockAIProvider } from './MockAIProvider.js';
import { DeterministicNLUProvider } from './providers/DeterministicNLUProvider.js';
import { NvidiaAIProvider } from './providers/NvidiaAIProvider.js';
import { GeminiAIProvider } from './providers/GeminiAIProvider.js';

export interface AIProviderConfig {
  provider: string;   // 'deterministic' | 'nvidia' | 'gemini'
  model: string | null;
  apiKey: string | null; // server-side only
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Provider selection stays configuration-driven — orchestration code never
 * hard-codes a model. Without a key the deterministic NLU is used (and it is
 * always available as the failure fallback).
 */
export function createConfiguredAIProvider(config: AIProviderConfig): { provider: AIProvider; name: string } {
  if (config.apiKey && config.provider === 'nvidia') {
    return { provider: new NvidiaAIProvider({ apiKey: config.apiKey, model: config.model ?? undefined, timeoutMs: config.timeoutMs, fetchImpl: config.fetchImpl }), name: 'nvidia' };
  }
  if (config.apiKey && config.provider === 'gemini') {
    return { provider: new GeminiAIProvider({ apiKey: config.apiKey, model: config.model ?? undefined, timeoutMs: config.timeoutMs, fetchImpl: config.fetchImpl }), name: 'gemini' };
  }
  return { provider: new DeterministicNLUProvider(), name: config.provider && config.provider !== 'deterministic' ? `${config.provider}-unconfigured-fallback-deterministic` : 'deterministic' };
}

/** Backwards-compatible default from Step 1. */
export function createDefaultAIProvider(): AIProvider {
  return new MockAIProvider();
}
