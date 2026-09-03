/**
 * Glossary (GENERAL knowledge) vs LIVE railway data — the two never mix.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, run, ASR, LDH } from './harness.js';
import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';
import type { AIProvider } from '../../ai/index.js';
import type { AIUnderstandingInput, AIUnderstandingResult } from '../../shared/index.js';
import { composeKnowledgeAnswer } from '../../shared/railwayKnowledge.js';
import { createKnowledgeToolExecutor } from '../../tools/executors/knowledgeTools.js';

function contextWithJourney(): ConversationContext {
  let context = freshContext();
  context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27', selectedClass: 'CC' }, 'FILL_MISSING');
  context = setSearchResults(context, []);
  return context;
}

describe('glossary: approved static knowledge (§7)', () => {
  it('21: CC glossary', async () => {
    const turn = await run(createHarness(), freshContext(), 'CC kya hota hai?');
    expect(turn.intent).toBe('GENERAL_RAILWAY_QUERY');
    expect(turn.executedTools).toHaveLength(0); // no tool needed for concepts
    expect(turn.reply).toMatch(/Chair Car/i);
  });

  it('22: SL glossary', async () => {
    const turn = await run(createHarness(), freshContext(), 'SL kya hota hai?');
    expect(turn.reply).toMatch(/Sleeper/i);
  });

  it('23: RAC glossary', async () => {
    const turn = await run(createHarness(), freshContext(), 'RAC kya hota hai?');
    expect(turn.reply).toMatch(/Reservation Against Cancellation/i);
  });

  it('24: WL glossary', async () => {
    const turn = await run(createHarness(), freshContext(), 'WL kya hota hai?');
    expect(turn.reply).toMatch(/Waiting List/i);
  });

  it('glossary answers are labelled as generic concepts', async () => {
    const turn = await run(createHarness(), freshContext(), 'CC kya hota hai?');
    expect(turn.reply).toMatch(/Generic concept/i);
  });
});

describe('25: live data vs glossary discrimination', () => {
  it('"12014 mein CC available hai?" goes to the AVAILABILITY TOOL — never the glossary', async () => {
    const harness = createHarness();
    const turn = await run(harness, contextWithJourney(), '12014 mein CC available hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.reply).not.toMatch(/Chair Car — AC seating class/i); // no glossary answer
  });
});

describe('all IRCTC class codes, not only CC/SL', () => {
  it.each([
    ['3A kya hota hai?', /Third AC/i],
    ['2A matlab kya', /Second AC/i],
    ['1A kya hai', /First AC/i],
    ['EC kya hota hai?', /Executive Chair/i],
    ['2S kya hota hai?', /Second Sitting/i],
    ['3E kya hota hai?', /Economy/i],
    ['EA kya hota hai?', /Anubhuti/i],
    ['anubhuti class kya hai', /Anubhuti/i],
    ['FC kya hota hai?', /First Class/i],
    ['EV kya hota hai?', /Vistadome AC/i],
  ])('%s', async (q, pattern) => {
    const turn = await run(createHarness(), freshContext(), q);
    expect(turn.intent, q).toBe('GENERAL_RAILWAY_QUERY');
    expect(turn.reply, q).toMatch(pattern);
    expect(turn.reply, q).not.toMatch(/approved railway knowledge se available nahi/i);
  });

  it('composeKnowledgeAnswer matches a sentence, not only the bare code', () => {
    expect(composeKnowledgeAnswer('CC kya hota hai?')?.matchedTerms).toEqual(['CC']);
    expect(composeKnowledgeAnswer('EA matlab kya')?.matchedTerms).toEqual(['EA']);
  });

  it('getRailwayKnowledge on a class-meaning question uses glossary, not web', async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      throw new Error('web should not run');
    }) as never;
    const executor = createKnowledgeToolExecutor({ fetchImpl: impl }).getRailwayKnowledge!;
    const result = await executor(
      { query: 'CC kya hota hai?' },
      { actor: 'AI', userId: 'u', conversationId: 'c', call: undefined },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect((result.data as { source: string; retrievedText: string }).source).toBe('deterministic');
    expect((result.data as { retrievedText: string }).retrievedText).toMatch(/Chair Car/i);
  });
});

describe('NVIDIA cannot steal class-meaning into availability', () => {
  class ScriptedAI implements AIProvider {
    readonly providerId = 'scripted-test-ai';
    async understand(_input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
      return {
        intent: 'GET_AVAILABILITY',
        confidence: 0.99,
        slots: {
          originQuery: null, destinationQuery: null, journeyDate: null, dateText: null,
          passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: 'CC',
          pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null,
        },
        missingFields: [],
        toolRequest: { tool: 'getAvailability', input: { travelClass: 'CC' }, rationale: 'class' },
      } as AIUnderstandingResult;
    }
    async generateResponse() {
      return { message: 'ok', askForField: null };
    }
  }

  it('lying model that asks getAvailability for "CC kya hota hai" still gets Chair Car', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'CC kya hota hai?', { ai: new ScriptedAI() });
    expect(turn.intent).toBe('GENERAL_RAILWAY_QUERY');
    expect(turn.executedTools).not.toContain('getAvailability');
    expect(turn.reply).toMatch(/Chair Car/i);
  });
});
