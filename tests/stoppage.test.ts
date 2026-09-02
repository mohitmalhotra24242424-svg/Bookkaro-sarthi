/**
 * STOPPAGE ("does train X stop at station Y?") — a common railway question the
 * AI/NLU must route to the VERIFIED timetable and answer from real stops, never
 * a guess.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, run } from './orchestration/harness.js';
import type { AIProvider, AIUnderstandingInput, AIUnderstandingResult } from '../ai/AIProvider.js';
import type { AIReplyInput, AIReplyResult } from '../ai/AIProvider.js';

/** A stub AI that proposes a single getTimetable tool request (AI-requested-tool path). */
function stubAiToolRequest(): AIProvider {
  return {
    providerId: 'nvidia-stub',
    async understand(_i: AIUnderstandingInput): Promise<AIUnderstandingResult> {
      return {
        intent: 'GET_TIMETABLE',
        confidence: 0.85,
        slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: '12053', secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: [], glossaryTerm: null },
        missingFields: [],
        toolRequest: { tool: 'getTimetable', input: { trainNumber: '12053' }, rationale: 'stoppage check' },
      };
    },
    async generateResponse(_i: AIReplyInput): Promise<AIReplyResult> {
      return { askForField: null, message: 'n/a' };
    },
  };
}

/** A stub AI that COMPOSES a data-verified Hinglish answer via generateResponse (AI-reasoning autonomy). */
function stubAiReasoning(reply: string): AIProvider {
  return {
    providerId: 'nvidia-stub',
    async understand(_i: AIUnderstandingInput): Promise<AIUnderstandingResult> {
      return {
        intent: 'GET_TIMETABLE',
        confidence: 0.85,
        slots: { originQuery: null, destinationQuery: null, journeyDate: null, dateText: null, passengerCount: null, trainNumber: null, secondTrainNumber: null, travelClass: null, pnr: null, resultReference: null, isCorrection: false, mentionedStations: ['ludhiana'], glossaryTerm: null },
        missingFields: [],
        toolRequest: { tool: 'getTimetable', input: { trainNumber: '12053' }, rationale: 'stoppage check' },
      };
    },
    async generateResponse(_i: AIReplyInput): Promise<AIReplyResult> {
      return { askForField: null, message: reply };
    },
  };
}

describe('stoppage: "does train X stop at station Y"', () => {
  it('routes "12053 Ludhiana rukti hai?" to GET_TIMETABLE and answers YES from the real stops', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 Ludhiana rukti hai?');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/ruk/i); // clear yes/no phrasing
    expect(turn.reply).toMatch(/ludhiana|LDH/i); // names the station/stop
    expect(turn.reply).not.toMatch(/samajh nahi paaya/i);
  });

  it('answers NO when the station is not a stop ("12053 Ambala rukti hai?")', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 Ambala rukti hai?');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/nahi rukti/i);
    expect(turn.reply).toMatch(/ambala/i);
  });

  it('also recognises English "does 12053 stop at Ludhiana?"', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'does 12053 stop at Ludhiana?');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/ruk/i);
  });

  it('still returns the full timetable for a plain "ka timetable" request', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 ka timetable batao');
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/timetable|stops/i);
  });

  it('does not guess when the timetable is unavailable (honest reply)', async () => {
    const harness = createHarness({ timetable: 'EMPTY' });
    const turn = await run(harness, freshContext(), '12053 Ludhiana rukti hai?');
    // No invented answer — the orchestrator must report data unavailability.
    expect(turn.reply).not.toMatch(/ruk (jaa|gayi)|ruk jaata/i);
  });
});

describe('stoppage on the AI-requested-tool path (toolRequest from the model)', () => {
  it('answers YES from real stops when the AI proposes getTimetable', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 Ludhiana rukti hai?', { ai: stubAiToolRequest() });
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/ruk/i);
    expect(turn.reply).toMatch(/ludhiana|LDH/i);
  });

  it('answers NO when the AI proposes getTimetable but the station is not a stop', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 Ambala rukti hai?', { ai: stubAiToolRequest() });
    expect(turn.intent).toBe('GET_TIMETABLE');
    expect(turn.reply).toMatch(/nahi rukti/i);
  });
});

describe('AI-reasoning autonomy: AI composes the data-backed answer (guarded)', () => {
  it('uses the AI-composed Hinglish answer when it phrases the verified data', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12053 ludhiana rukti hai?', {
      ai: stubAiReasoning('Han, doston, 12053 LUDHIANA JN par 19:38 par rukti hai.'),
    });
    // The AI's composed answer wins (it is the one phrasing the verified data).
    expect(turn.reply).toMatch(/ruk/);
    expect(turn.reply).toContain('LUDHIANA');
  });

  it('falls back to the deterministic stop reply when the AI prose is not Hinglish', async () => {
    const harness = createHarness();
    // English-only prose → maybeAiReply guard rejects it → deterministic fallback.
    const turn = await run(harness, freshContext(), '12053 ludhiana rukti hai?', {
      ai: stubAiReasoning('Yes, train 12053 stops at Ludhiana at 19:38.'),
    });
    expect(turn.reply).toMatch(/ruk/);
    expect(turn.reply).toMatch(/ludhiana|LDH/i);
  });

  it('passes the user message to the reply generator', async () => {
    const harness = createHarness();
    let capturedMessage: string | undefined;
    const ai: AIProvider = {
      ...stubAiReasoning('dekho, data ke hisaab se nahi rukti.'),
      async generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
        capturedMessage = input.userMessage;
        return { askForField: null, message: 'dekho, data ke hisaab se nahi rukti.' };
      },
    };
    await run(harness, freshContext(), '12053 ambala rukti hai?', { ai });
    expect(capturedMessage).toMatch(/ambala/i);
  });
});
