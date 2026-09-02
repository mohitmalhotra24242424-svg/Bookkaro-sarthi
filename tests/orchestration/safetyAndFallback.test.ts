/**
 * AI failure fallback, structured-output rejection and SAFETY proofs:
 * the AI can never confirm a booking, touch wallet money, run unregistered
 * tools, or smuggle URLs. MOCK TESTS with scripted AI providers.
 */

import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult } from '../../shared/index.js';
import { providerFailure } from '../../shared/index.js';
import { createHarness, freshContext, run } from './harness.js';

/** Scriptable fake AI provider (returns raw untrusted JSON like a real model). */
class ScriptedAI implements AIProvider {
  readonly providerId = 'scripted-test-ai';
  constructor(
    private readonly rawUnderstand: unknown,
    private readonly options: { hang?: boolean; reply?: string } = {},
  ) {}
  async understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    if (this.options.hang) await new Promise(() => undefined); // never resolves → timeout path
    return this.rawUnderstand as AIUnderstandingResult;
  }
  async generateResponse(): Promise<{ message: string; askForField: null }> {
    return { message: this.options.reply ?? 'ok', askForField: null };
  }
}

type Harness = ReturnType<typeof createHarness>;
type Overrides = { ai: AIProvider; aiTimeoutMs?: number };
type TurnHarness = Harness;

describe('AI timeout fallback (§17)', () => {
  it('30: hanging AI → deterministic fallback still answers LIVE_TRAIN_STATUS, honestly', async () => {
    const harness: Harness = createHarness();
    const overrides: Overrides = { ai: new ScriptedAI(null, { hang: true }), aiTimeoutMs: 60 };
    const turn = await run(harness, freshContext(), '12014 ka live status batao', overrides);

    expect(turn.usedFallbackNlu).toBe(true);
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toContain('12014');
  });
});

describe('invalid AI JSON (§2/§16)', () => {
  it('31: unusable AI output → validator rejects → deterministic fallback answers', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      '12014 ka live status batao',
      { ai: new ScriptedAI({ hello: 'world', free: 'form' }) },
    );

    expect(turn.usedFallbackNlu).toBe(true);
    expect(turn.executedTools).toContain('getLiveStatus');
  });

  it('AI output with an unknown intent is rejected (never trusted blindly)', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      '12014 ka live status batao',
      { ai: new ScriptedAI({ intent: 'CANCEL_ALL_BOOKINGS', confidence: 0.99, entities: {} }) },
    );
    expect(turn.usedFallbackNlu).toBe(true); // fell back to deterministic NLU
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
  });
});

describe('unauthorized / arbitrary tool requests (§4)', () => {
  it('32: AI requests confirmBooking → REJECTED + recorded; booking never executed', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      'book kar do confirm',
      { ai: new ScriptedAI({ intent: 'BOOK_TRAIN', confidence: 0.9, tool: 'confirmBooking', toolInput: { draftId: 'x' }, entities: {} }) },
    );

    expect(turn.safetyRejections.join(' ')).toMatch(/confirmBooking.*rejected|protected tool "confirmBooking"/);
    expect(turn.executedTools).not.toContain('confirmBooking');
    expect(turn.reply).toMatch(/kar nahi sakta|server-side safety/i);
  });

  it('33: AI requests an unregistered tool with a URL → REJECTED, no arbitrary calls', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      '12014 ka live status batao',
      {
        ai: new ScriptedAI({
          intent: 'LIVE_TRAIN_STATUS',
          confidence: 0.9,
          tool: 'fetchUrl',
          toolInput: { url: 'https://evil.example.com/pwn' },
          entities: { trainNumber: '12014' },
        }),
      },
    );

    expect(turn.safetyRejections.join(' ')).toMatch(/unregistered tool "fetchUrl"/);
    expect(turn.executedTools).toEqual(['getLiveStatus']); // only the whitelisted tool ran
    expect(turn.reply).not.toContain('https://evil.example.com');
  });

  it('34: AI attempts a wallet money operation → no such tool exists, nothing runs', async () => {
    const harness = createHarness();
    const turn = await run(
      harness,
      freshContext(),
      'mere wallet se paise kaat do',
      { ai: new ScriptedAI({ intent: 'VIEW_WALLET', confidence: 0.9, tool: 'walletDebit', toolInput: { amount: 500 }, entities: {} }) },
    );

    expect(turn.safetyRejections.join(' ')).toMatch(/unregistered tool "walletDebit"/);
    expect(turn.executedTools).not.toContain('walletDebit');
    // the ONLY wallet-related executable tool is read-only getWallet
    expect(harness.toolRegistry.has('walletDebit')).toBe(false);
  });

  it('35: direct AI call to confirmBooking through the registry is rejected at the boundary', async () => {
    const harness: TurnHarness = createHarness();
    const registry = harness.toolRegistry;
    const result = await registry.execute(
      {
        id: 'tc-direct',
        tool: 'confirmBooking',
        input: { draftId: 'draft_x' },
        requestedBy: 'AI',
        conversationId: 'conv-1',
        createdAt: new Date().toISOString(),
      },
      { actor: 'AI', userId: 'user-1', conversationId: 'conv-1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_CALL_REJECTED');
    expect(result.data).toBeNull();
  });
});

describe('hallucination protection (§6/§15)', () => {
  it('tool returns unavailable → reply is the honest unavailable template, even if the AI "knows" an answer', async () => {
    const harness = createHarness({
      liveStatus: providerFailure('HTTP_ERROR', 'upstream down', { httpStatus: 503, source: 'RAILCORE' }),
    });
    const lyingAi = new ScriptedAI(
      { intent: 'LIVE_TRAIN_STATUS', confidence: 0.99, entities: { trainNumber: '12014' } },
      { reply: '12014 abhi New Delhi pahunch chuki hai aur 6 minute late thi.' },
    );
    const turn = await run(harness, freshContext(), '12014 ka live status batao', { ai: lyingAi });

    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toMatch(/available nahi/i);       // honest unavailable template wins
    expect(turn.reply).not.toMatch(/New Delhi pahunch/i); // AI prose did NOT fill the gap
  });

  it('AI replies can never hand the user a URL', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ka live status batao', {
      ai: new ScriptedAI(
        { intent: 'LIVE_TRAIN_STATUS', confidence: 0.9, entities: { trainNumber: '12014' } },
        { reply: 'Details at http://evil.example.com/trains' },
      ),
    });
    expect(turn.reply).not.toMatch(/evil\.example\.com/);
  });

  it('deterministic provider (default) never states a fact without tool data', async () => {
    const harness = createHarness({ trainSearch: 'EMPTY' });
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'kal');
    expect(turn.reply).toMatch(/koi train nahi mili/i); // zero results stated honestly
  });
});

describe('AI provider selection (§1)', () => {
  it('createConfiguredAIProvider defaults to deterministic without a key, uses NVIDIA/Gemini with one', async () => {
    const { createConfiguredAIProvider } = await import('../../ai/index.js');
    expect(createConfiguredAIProvider({ provider: 'nvidia', model: null, apiKey: null }).name).toMatch(/deterministic/);
    expect(createConfiguredAIProvider({ provider: 'gemini', model: null, apiKey: null }).name).toMatch(/deterministic/);
    expect(createConfiguredAIProvider({ provider: 'deterministic', model: null, apiKey: null }).provider.providerId).toBe('deterministic-nlu');

    const blockedFetch = (async () => { throw new Error('blocked'); }) as unknown as typeof globalThis.fetch;
    expect(
      createConfiguredAIProvider({ provider: 'nvidia', model: 'meta/llama-3.1-70b-instruct', apiKey: 'unit-test-only', fetchImpl: blockedFetch }).provider
        .providerId,
    ).toBe('nvidia');
    expect(
      createConfiguredAIProvider({ provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'unit-test-only', fetchImpl: blockedFetch }).provider
        .providerId,
    ).toBe('gemini');
  });
});
