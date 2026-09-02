/**
 * AI MODEL PROVIDER (Step 6 §20) — interchangeable model backends.
 *
 * Environment: AI_PROVIDER, AI_MODEL, AI_API_KEY, AI_BASE_URL (server-side
 * only). Supported: deterministic (no key, zero network), nvidia, gemini, and
 * any OpenAI-compatible endpoint via AI_BASE_URL (RapidAPI-hosted etc.).
 * Business logic never references a vendor — it depends on AIProvider.
 */

import type { AIProvider } from '../../ai/index.js';
import { AIGateway } from '../../ai/AIGateway.js';
import { DeterministicNLUProvider } from '../../ai/index.js';
import { NvidiaAIProvider } from '../../ai/providers/NvidiaAIProvider.js';
import { GeminiAIProvider } from '../../ai/providers/GeminiAIProvider.js';
import { getAIApiKey, getAIApiKeys, getAIModelName, getSecret } from '../config.js';

export interface ModelProviderConfig {
  provider: string;
  model: string | null;
  apiKey: string | null;
  /** Backup NVIDIA keys (NVIDIA_API_KEY_2 …) for automatic failover. */
  backupKeys?: string[];
  baseUrl: string | null;
}

export interface ModelProviderSelection {
  provider: AIProvider;
  name: string;
  /** true when the active provider is the offline deterministic NLU. */
  deterministic: boolean;
}

export function getModelProviderConfig(): ModelProviderConfig {
  // Step 8: NVIDIA_API_KEY + NVIDIA_MODEL are first-class; AI_* remain as aliases.
  const hasNvidiaKey = getSecret('NVIDIA_API_KEY') !== null;
  const provider = hasNvidiaKey
    ? (process.env.AI_PROVIDER?.trim().toLowerCase() || 'nvidia')
    : (process.env.AI_PROVIDER ?? 'deterministic').trim().toLowerCase();
  const model = getAIModelName();
  const [apiKey, ...backupKeys] = getAIApiKeys();
  const baseUrl = process.env.AI_BASE_URL?.trim() || null;
  return { provider, model, apiKey: apiKey ?? null, backupKeys, baseUrl };
}

/**
 * Selection rules (keys never leave the server; deterministic when unkeyed):
 *   nvidia | openai-compatible (+AI_BASE_URL) → chat-completions adapter
 *   gemini (+key)                             → generativelanguage adapter
 *   anything else / no key                    → deterministic NLU (offline)
 */
export function createModelProvider(config: ModelProviderConfig = getModelProviderConfig()): ModelProviderSelection {
  const { provider, model, apiKey, backupKeys, baseUrl } = config;
  const options = { apiKey: apiKey ?? '', model: model ?? undefined, baseUrl: baseUrl ?? undefined, fallbackApiKeys: backupKeys ?? [] };

  if (apiKey && (provider === 'nvidia' || ((provider === 'openai' || provider === 'openai-compatible' || provider === 'rapidapi') && baseUrl))) {
    // Step 9 AI GATEWAY: GPT-OSS-20B PRIMARY → Nemotron SECONDARY
    // (model-level fallback only — completely separate from RailCore→RailKit
    // provider fallback; both models share the identical ToolGate/ToolExecutor/
    // ProviderRouter/safety pipeline; neither ever receives keys or URLs).
    const primaryModel = process.env.GPT_OSS_MODEL?.trim() || 'openai/gpt-oss-20b';
    const secondaryModel = model ?? 'nvidia/nemotron-3.5-lightning-30b-a3b';
    const primary = new NvidiaAIProvider({ ...options, model: primaryModel });
    const secondary = new NvidiaAIProvider({ ...options, model: secondaryModel });
    const gateway = new AIGateway({ primary, secondary, timeoutMs: 15_000 });
    return {
      provider: gateway,
      name: `nvidia-gateway:${primaryModel}→${secondaryModel}`,
      deterministic: false,
    };
  }
  if (apiKey && provider === 'gemini') {
    return { provider: new GeminiAIProvider(options), name: `gemini:${model ?? 'default'}`, deterministic: false };
  }
  return {
    provider: new DeterministicNLUProvider(),
    name: provider === 'deterministic' ? 'deterministic' : `${provider}-unconfigured→deterministic`,
    deterministic: true,
  };
}
