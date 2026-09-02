/**
 * NVIDIA AI key failover tests — jawab HAMESHA primary key se aata hai;
 * backup key sirf tab use hoti hai jab primary 401/402/403/429 de.
 */
import { describe, expect, it } from 'vitest';
import { NvidiaAIProvider } from '../../ai/providers/NvidiaAIProvider.js';
import { createConversationContext } from '../../shared/index.js';

function fetchStub(byKeyStatus: Record<string, number>) {
  const usedKeys: string[] = [];
  const impl = (async (_url: unknown, init: { headers: Record<string, string> }) => {
    const key = String(init.headers.authorization).replace('Bearer ', '');
    usedKeys.push(key);
    const status = byKeyStatus[key] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 200 ? { choices: [{ message: { content: '{"intent":"TEST","entities":{},"confidence":1}' } }] } : { error: 'key problem' }),
    };
  }) as unknown as typeof globalThis.fetch;
  return { impl, usedKeys };
}

describe('AI key failover', () => {
  it('primary key works → backup NEVER used', async () => {
    const { impl, usedKeys } = fetchStub({ primary: 200, backup: 200 });
    const provider = new NvidiaAIProvider({ apiKey: 'primary', fallbackApiKeys: ['backup'], fetchImpl: impl });
    const result = await provider.understand({ userMessage: 'test', conversation: createConversationContext({ userId: 'u' }), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('TEST');
    expect(usedKeys).toEqual(['primary']); // ← answer primary ne diya
  });

  it('primary 401 → backup answers', async () => {
    const { impl, usedKeys } = fetchStub({ primary: 401, backup: 200 });
    const provider = new NvidiaAIProvider({ apiKey: 'primary', fallbackApiKeys: ['backup'], fetchImpl: impl });
    const result = await provider.understand({ userMessage: 'test', conversation: createConversationContext({ userId: 'u' }), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('TEST');
    expect(usedKeys).toEqual(['primary', 'backup']); // rotation happened
  });

  it('primary quota (429) → backup answers', async () => {
    const { impl, usedKeys } = fetchStub({ primary: 429, backup: 200 });
    const provider = new NvidiaAIProvider({ apiKey: 'primary', fallbackApiKeys: ['backup'], fetchImpl: impl });
    const result = await provider.understand({ userMessage: 'test', conversation: createConversationContext({ userId: 'u' }), availableIntents: [], availableTools: [] });
    expect(result.intent).toBe('TEST');
    expect(usedKeys).toEqual(['primary', 'backup']);
  });

  it('dono keys fail → honest failure (orchestrator deterministic fallback lega)', async () => {
    const { impl } = fetchStub({ primary: 401, backup: 403 });
    const provider = new NvidiaAIProvider({ apiKey: 'primary', fallbackApiKeys: ['backup'], fetchImpl: impl });
    await expect(provider.understand({ userMessage: 'test', conversation: createConversationContext({ userId: 'u' }), availableIntents: [], availableTools: [] })).rejects.toThrow();
  });

  it('non-key error (500) → NO rotation (backup waste nahi hoti)', async () => {
    const { impl, usedKeys } = fetchStub({ primary: 500, backup: 200 });
    const provider = new NvidiaAIProvider({ apiKey: 'primary', fallbackApiKeys: ['backup'], fetchImpl: impl });
    await expect(provider.understand({ userMessage: 'test', conversation: createConversationContext({ userId: 'u' }), availableIntents: [], availableTools: [] })).rejects.toThrow();
    expect(usedKeys).toEqual(['primary']); // server error ≠ key error
  });
});
