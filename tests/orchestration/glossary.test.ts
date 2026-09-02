/**
 * Glossary (GENERAL knowledge) vs LIVE railway data — the two never mix.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, run, ASR, LDH } from './harness.js';
import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';

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
