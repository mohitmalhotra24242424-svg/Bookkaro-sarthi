import { describe, expect, it } from 'vitest';
import { createDefaultAIProvider } from '../ai/index.js';
import { NotImplementedError } from '../shared/index.js';
import { MockAIProvider } from '../ai/MockAIProvider.js';
import { NvidiaAIProvider } from '../ai/providers/NvidiaAIProvider.js';
import { GeminiAIProvider } from '../ai/providers/GeminiAIProvider.js';
import { INTENTS, createConversationContext } from '../shared/index.js';
import type { AIProvider } from '../ai/index.js';

const conversation = createConversationContext({ userId: 'user-1' });

function blockNetwork<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('NETWORK_BLOCKED_IN_TEST — AI providers must not touch the network');
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

describe('AI provider abstraction', () => {
  it('MockAIProvider satisfies the AIProvider contract (swap providers without touching orchestration)', () => {
    const provider: AIProvider = new MockAIProvider();
    expect(provider.providerId).toBe('mock');
    expect(typeof provider.understand).toBe('function');
    expect(typeof provider.generateResponse).toBe('function');
  });

  it('understand() returns a valid intent and never a tool execution', async () => {
    const provider = new MockAIProvider();
    const result = await blockNetwork(() =>
      provider.understand({
        userMessage: 'Mujhe Amritsar se Ludhiana jaana hai',
        conversation,
        availableIntents: INTENTS,
        availableTools: ['searchTrains'],
      }),
    );
    expect(INTENTS).toContain(result.intent);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.toolRequest).toBeNull(); // a REQUEST would be fine; execution never happens here
    expect(result.slots.trainNumber).toBeNull();
  });

  it('generateResponse() words an honest not-implemented reply and never invents facts', async () => {
    const provider = new MockAIProvider();
    const result = await blockNetwork(() =>
      provider.generateResponse({ conversation, toolResults: [], tone: 'FRIENDLY' }),
    );
    expect(result.message.length).toBeGreaterThan(10);
    expect(result.message).toMatch(/not implemented/i);
    expect(result.message).toMatch(/never guess|never.*invent/i);
  });

  it('is deterministic (same input → same output)', async () => {
    const provider = new MockAIProvider();
    const input = { userMessage: 'PNR check karo', conversation, availableIntents: INTENTS, availableTools: [] as never[] };
    const first = await provider.understand(input);
    const second = await provider.understand(input);
    expect(first).toEqual(second);
  });

  it('works with the network completely blocked — zero API calls, zero credentials', async () => {
    const provider = createDefaultAIProvider();
    await expect(
      blockNetwork(async () => {
        await provider.understand({ userMessage: 'hi', conversation, availableIntents: INTENTS, availableTools: [] });
        await provider.generateResponse({ conversation, toolResults: [], tone: 'CONCISE' });
      }),
    ).resolves.toBeUndefined();
  });

  it('real providers (NVIDIA, Gemini) fail honestly when the endpoint is unreachable — no fabricated output', async () => {
    const blockedFetch = (() => Promise.reject(new NotImplementedError('network blocked in test'))) as unknown as typeof globalThis.fetch;
    const nvidia: AIProvider = new NvidiaAIProvider({ apiKey: 'unit-test-only', fetchImpl: blockedFetch });
    const gemini: AIProvider = new GeminiAIProvider({ apiKey: 'unit-test-only', fetchImpl: blockedFetch });
    await expect(nvidia.understand({ userMessage: 'hi', conversation, availableIntents: INTENTS, availableTools: [] })).rejects.toThrow();
    await expect(gemini.generateResponse({ conversation, toolResults: [], tone: 'CONCISE' })).rejects.toThrow();
    await expect(nvidia.generateResponse({ conversation, toolResults: [], tone: 'CONCISE' })).rejects.toThrow();
  });

  it('default provider for Step 1 is the deterministic mock', () => {
    expect(createDefaultAIProvider().providerId).toBe('mock');
  });
});
