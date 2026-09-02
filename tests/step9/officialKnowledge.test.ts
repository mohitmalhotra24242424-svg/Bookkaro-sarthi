/**
 * STEP 9 (official-source revision) — OFFICIAL RAILWAY KNOWLEDGE SOURCE TESTS.
 * Verifies: official-source routing, rule-sensitive (Tatkal) questions never
 * answered from static/model memory, live-data NEVER served from web, domain
 * allowlist enforcement, honest-unavailable behavior and booking-context safety.
 */

import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../shared/index.js';
import { createHarness, freshContext, run } from '../orchestration/harness.js';
import { setContextSlots } from '../../shared/index.js';
import {
  HONEST_UNAVAILABLE_MESSAGE,
  OFFICIAL_RAILWAY_PAGES,
  RAILWAY_WEB_ALLOWLIST,
  RULE_SENSITIVE_QUERY,
  createKnowledgeToolExecutor,
} from '../../tools/executors/knowledgeTools.js';
import { validateToolArguments } from '../../api/ai/tool-catalog.js';

const ctxStub = { actor: 'AI' as const, userId: 'u', conversationId: 'c', call: undefined };

function failingFetch() {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    throw new Error('network unreachable');
  }) as never;
  return { impl, calls };
}

describe('§K1-4: stable concepts → deterministic knowledge (no provider/web)', () => {
  it('1-4: CC / RAC / WL / GN → general railway knowledge, zero tool calls', async () => {
    const harness = createHarness();
    for (const q of ['CC kya hota hai?', 'RAC kya hota hai?', 'WL kya hota hai?', 'GN quota kya hota hai?']) {
      const turn = await run(harness, freshContext(), q);
      expect(turn.sourceClass, q).toBe('GENERAL_RAILWAY_KNOWLEDGE');
      expect(turn.executedTools, q).toHaveLength(0); // deterministic glossary — no web, no provider
    }
  });
});

describe('§K5-6: rule-sensitive questions → OFFICIAL source required', () => {
  it('5: "Tatkal kya hai?" → official web tool invoked (never the static glossary)', async () => {
    const harness = createHarness(); // real fetch → honest failure expected in-sandbox
    const turn = await run(harness, freshContext(), 'Tatkal kya hai?');
    expect(turn.sourceClass).toBe('GENERAL_RAILWAY_KNOWLEDGE');
    expect(turn.executedTools).toContain('getRailwayKnowledge');
    // Either official retrieval succeeded (provenance line) or the spec's honest message.
    expect(turn.reply).toMatch(/official|Is information ko verify karne/i);
    // The static glossary tatkal text must NOT be served for rule-sensitive questions.
    expect(turn.reply).not.toMatch(/ek din pehle khulti hai/i);
  });

  it('6: "Tatkal booking kab khulti hai?" → official-source-backed answer or honest unavailable, never model memory', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Tatkal booking kab khulti hai?');
    expect(turn.executedTools).toContain('getRailwayKnowledge');
    expect(turn.reply).toMatch(/official|Is information ko verify karne/i);
    expect(turn.reply).not.toMatch(/\b(10|11)\s*(AM|am|baje)\b/); // no invented timing
  });

  it('targeted official page selection: tatkal → official Tatkal Scheme page', async () => {
    const { impl, calls } = ((): { impl: unknown; calls: string[] } => {
      const calls2: string[] = [];
      return {
        calls: calls2,
        impl: (async (url: string) => {
          calls2.push(String(url));
          return { ok: true, status: 200, url: String(url), text: async () => '<html><body>Tatkal scheme: reservation rules and timings as published by Indian Railways for passengers.</body></html>' };
        }) as never,
      };
    })();
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl as never }).getRailwayKnowledge!;
    const result = await executor({ query: 'Tatkal booking kab khulti hai?' }, ctxStub);
    expect(result.ok).toBe(true);
    const data = result.data as { source: string; sourceTitle: string; sourceUrl: string; retrievedText: string; retrievedAt: string };
    expect(data.source).toBe('web');
    expect(data.sourceTitle).toMatch(/Tatkal Scheme — Indian Railways/);
    expect(data.sourceUrl).toContain('tatkal_Scheme.html');
    expect(data.retrievedText.length).toBeGreaterThan(20);
    expect(data.retrievedAt).toBeTruthy();
    expect(calls[0]).toContain('indianrail.gov.in');
  });

  it('RULE_SENSITIVE_QUERY classification sanity', () => {
    expect(RULE_SENSITIVE_QUERY.test('Tatkal booking kab khulti hai?')).toBe(true);
    expect(RULE_SENSITIVE_QUERY.test('refund rules kya hain?')).toBe(true);
    expect(RULE_SENSITIVE_QUERY.test('luggage limit kitni hai?')).toBe(true);
    expect(RULE_SENSITIVE_QUERY.test('CC kya hota hai?')).toBe(false); // stable concept
  });
});

describe('§K7-10: live data NEVER from web', () => {
  it('7-8: availability + live status → providers, web tool never invoked', async () => {
    const harness = createHarness();
    const availability = await run(harness, freshContext(), '12014 mein CC available hai?');
    expect(availability.intent).toBe('GET_AVAILABILITY');
    expect(availability.executedTools).not.toContain('getRailwayKnowledge');
    const live = await run(harness, freshContext(), '12014 abhi kaha hai?');
    expect(live.sourceClass).toBe('LIVE_RAILWAY_DATA');
    expect(live.executedTools).toContain('getLiveStatus');
    expect(live.executedTools).not.toContain('getRailwayKnowledge');
  });

  it('9: fare → provider data, NOT web', async () => {
    const turn = await run(createHarness(), freshContext(), '12014 ka fare?');
    expect(turn.intent).toBe('GET_FARE');
    expect(turn.executedTools).not.toContain('getRailwayKnowledge');
  });

  it('10: comparison → deterministic engine on verified results, never web', async () => {
    const harness = createHarness();
    let context: ConversationContext = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    context = (await run(harness, context, 'kal')).context;
    const turn = await run(harness, context, '12014 aur 14542 mein kaunsi jaldi pahunchti hai?');
    expect(turn.sourceClass).toBe('COMPARISON');
    expect(turn.reply).toMatch(/WINNER/);
    expect(turn.executedTools).not.toContain('getRailwayKnowledge');
  });
});

describe('§K11-14: restricted web tool enforcement', () => {
  it('11: arbitrary URL request → rejected before any fetch', async () => {
    const { impl, calls } = failingFetch();
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl }).getRailwayKnowledge!;
    const result = await executor({ query: 'tatkal rules', url: 'https://evil.example.com/tatkal' }, ctxStub);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('URL_REJECTED');
    expect(calls).toHaveLength(0);
  });

  it('12: untrusted DOMAIN parameter → rejected', async () => {
    const { impl, calls } = failingFetch();
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl }).getRailwayKnowledge!;
    const result = await executor({ query: 'tatkal rules', domain: 'wikipedia.org' }, ctxStub);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('URL_REJECTED');
    expect(calls).toHaveLength(0);
  });

  it('approved domain parameter → accepted (fetch stays on allowlist)', async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, url: String(url), text: async () => '<html><body>Indian Railways official passenger reservation information and rules published for travellers.</body></html>' };
    }) as never;
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl }).getRailwayKnowledge!;
    const result = await executor({ query: 'reservation rules kya hain', domain: 'indianrail.gov.in' }, ctxStub);
    expect(result.ok).toBe(true);
    expect(calls[0]).toContain('indianrail.gov.in');
    void RAILWAY_WEB_ALLOWLIST;
  });

  it('13: web unavailable → spec honest-unavailable response (no guessing)', async () => {
    const { impl } = failingFetch();
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl }).getRailwayKnowledge!;
    const result = await executor({ query: 'Tatkal booking kab khulti hai?' }, ctxStub);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe(HONEST_UNAVAILABLE_MESSAGE);
  });

  it('14: API key request → rejected by the catalog validator', () => {
    const validation = validateToolArguments('RAILWAY_KNOWLEDGE', { query: 'tatkal', apiKey: 'nvapi-stolen', authorization: 'Bearer x' });
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/forbidden/i);
  });

  it('official pages map contains the 5 configured official sources', () => {
    const keys = OFFICIAL_RAILWAY_PAGES.map((page) => page.key);
    expect(keys).toEqual(expect.arrayContaining(['tatkal', 'quota-codes', 'pnr-legend', 'seat-availability', 'rules']));
    for (const page of OFFICIAL_RAILWAY_PAGES) {
      expect(page.url).toContain('indianrail.gov.in');
    }
  });
});

describe('§K15: general knowledge during booking — context preserved', () => {
  it('tatkal question mid-booking → answered, booking slots intact', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Kal Amritsar se Ludhiana 2 ticket chahiye')).context;
    const before = { date: context.journeyDate, pax: context.passengerCount, stage: context.bookingStage };

    const interrupt = await run(harness, context, 'Tatkal quota kya hota hai?');
    expect(interrupt.reply).toMatch(/official railway source|Is information ko verify karne|Tatkal/i);
    expect(interrupt.context.journeyDate).toBe(before.date);
    expect(interrupt.context.passengerCount).toBe(before.pax);

    const resumed = await run(harness, interrupt.context, 'pehli wali');
    expect(resumed.context.journeyDate).toBe(before.date);
    expect(resumed.context.passengerCount).toBe(before.pax);
    void setContextSlots;
  });
});
