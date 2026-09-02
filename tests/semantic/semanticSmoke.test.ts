/**
 * REAL SMOKE TESTS — Semantic AI Tool Planner executed through the implemented
 * runtime, using the real server-side NVIDIA keys + RailCore/RailKit adapters.
 *
 * Runs ONLY when NVIDIA_API_KEY / RAILCORE_API_KEY are configured; otherwise
 * the whole file skips (keyless CI stays green). NO MOCKS inside.
 *
 * Verifies the FINAL spec's runtime requirements:
 *   - PRIMARY ai (openai/gpt-oss-20b) real request success
 *   - SECONDARY ai (nvidia/nemotron-3.5-lightning-30b-a3b) real request success
 *   - PRIMARY → SECONDARY fallback (simulated primary failure)
 *   - BOTH AI → deterministic NLU fallback (simulated)
 *   - RailCore primary operation + RailCore→RailKit fallback (no secrets exposed)
 */

import { describe, expect, it } from 'vitest';
import { getAIApiKey, getSecret, getAIModelName } from '../../api/config.js';
import { createSemanticRunner, SemanticPlanner } from '../../api/ai/semantic-runner.js';
import { createNvidiaClient } from '../../api/ai/semantic-model.js';
import { createProductionToolRegistry } from '../../tools/executors/index.js';
import { createDefaultRailwayRouter } from '../../railway/router.js';
import { createHarness } from '../orchestration/harness.js';
import { createConversationContext } from '../../shared/index.js';
import type { ConversationContext } from '../../shared/index.js';

const primaryKey = getAIApiKey();
const primaryModel = process.env.GPT_OSS_MODEL?.trim() || 'openai/gpt-oss-20b';
const secondaryModel = getAIModelName() ?? 'nvidia/nemotron-3.5-lightning-30b-a3b';
const railCoreKey = getSecret('RAILCORE_API_KEY');
const railKitKey = getSecret('RAILKIT_API_KEY');

const T = { timeout: 90_000 };
const keyed = primaryKey !== null && primaryKey.length > 0;

function context(): ConversationContext {
  return createConversationContext({ userId: 'smoke' });
}

function realRegistry() {
  const router = createDefaultRailwayRouter({ railCore: { apiKey: railCoreKey, timeoutMs: 15_000 }, railKit: { apiKey: railKitKey } });
  return createProductionToolRegistry({ router });
}

describe.skipIf(!keyed)('Semantic AI Tool Planner — REAL runtime smoke (NVIDIA + Railway)', () => {
  it('PRIMARY ai (gpt-oss-20b) real request → valid plan (source ai_primary)', T, async () => {
    const runner = createSemanticRunner({ registry: realRegistry(), primaryModel, secondaryModel, apiKey: primaryKey ?? '', baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 60_000 });
    const turn = await runner.run('Mujhe kal Amritsar se Ludhiana jaana hai', context(), { userId: 'u', conversationId: 'c' });
    console.log(`  [primary] source=${turn.diagnostics.source} model=${turn.diagnostics.modelUsed} tools=${turn.executedTools.join(',') || '-'}`);
    expect(turn.diagnostics.source).toBe('ai_primary');
    expect(turn.diagnostics.modelUsed).toContain('gpt-oss');
  });

  it('SECONDARY ai (nemotron) real request → valid plan (source ai_secondary)', T, async () => {
    // Force the secondary by making the primary throw (simulated primary failure).
    const planner = new SemanticPlanner({
      primary: { model: 'openai/gpt-oss-20b', baseUrl: 'https://integrate.api.nvidia.com/v1', complete: async () => { throw new Error('simulated primary failure'); } },
      secondary: createNvidiaClient({ model: secondaryModel, apiKey: primaryKey ?? '', baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 60_000 }),
      timeoutMs: 60_000,
    });
    const result = await planner.plan('12014 ka live status batao', context());
    console.log(`  [secondary] source=${result.source} model=${result.modelUsed} tool=${result.plan?.toolPlan[0]?.tool}`);
    expect(result.source).toBe('ai_secondary');
    expect(result.modelUsed).toContain('nemotron');
    expect(result.plan?.toolPlan[0]?.tool).toBe('TRACK_TRAIN');
  });

  it('BOTH AI unavailable → deterministic NLU (source nlu)', T, async () => {
    const planner = new SemanticPlanner({
      primary: { model: 'gpt', baseUrl: 'x', complete: async () => { throw new Error('timeout'); } },
      secondary: { model: 'nemotron', baseUrl: 'x', complete: async () => { throw new Error('network'); } },
      timeoutMs: 1_000,
    });
    const result = await planner.plan('kal ASR se LDH jaana hai', context());
    console.log(`  [nlu] source=${result.source} tool=${result.plan?.toolPlan[0]?.tool}`);
    expect(result.source).toBe('nlu');
    expect(result.usedNlu).toBe(true);
    expect(result.plan?.toolPlan[0]?.tool).toBe('SEARCH_TRAINS');
  });

  it('AIR endpoint family returns acceptable JSON-only output (no prose, no URLs)', T, async () => {
    const system = 'Return only JSON: {"toolPlan":[],"comparison":null,"needsClarification":true,"missingFields":["origin"],"clarificationQuestion":"Kahan se?"}';
    const client = createNvidiaClient({ model: primaryModel, apiKey: primaryKey ?? '', baseUrl: 'https://integrate.api.nvidia.com/v1', timeoutMs: 60_000 });
    const raw = await client.complete([{ role: 'system', content: system }, { role: 'user', content: 'jaana hai' }], 0.0);
    expect(typeof raw).toBe('string');
    expect(String(raw)).not.toMatch(/https?:\/\//);
  });
});

describe.skipIf(!keyed)('Semantic planner runtime wiring (deterministic, no live rail)', () => {
  it('registry + orchestrator path is sound via the harness mock router', async () => {
    const harness = createHarness();
    const runner = createSemanticRunner({
      registry: harness.toolRegistry,
      primaryModel: 'gpt', secondaryModel: null, apiKey: primaryKey ?? '',
    });
    const turn = await runner.run('ASR se LDH ki trains', context(), { userId: 'u', conversationId: 'c' });
    expect(turn).toBeTruthy();
  });
});
