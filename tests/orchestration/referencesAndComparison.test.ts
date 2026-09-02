/**
 * Result references (§12) and comparison (§13) — only against the CURRENT
 * search result list, never invented trains.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, isoPlusDays, run } from './harness.js';
import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';
import { makeSearchResults, ASR, LDH } from './harness.js';

async function searchedContext(): Promise<ConversationContext> {
  const harness = createHarness();
  let context = freshContext();
  context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
  context = (await run(harness, context, 'Kal')).context;
  return context;
}

describe('result references (§12)', () => {
  it('17: "pehli wali" selects the first result and asks for the class', async () => {
    const harness = createHarness();
    const turn = await run(harness, await searchedContext(), 'pehli wali');
    expect(turn.context.selectedTrain?.number).toBe('12014');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/kaunsi class/i);
  });

  it('18: "doosri wali" selects the second result', async () => {
    const harness = createHarness();
    const turn = await run(harness, await searchedContext(), 'doosri wali');
    expect(turn.context.selectedTrain?.number).toBe('14542');
  });

  it('19: numbered train reference "12014 wali" only works if the train IS in the list', async () => {
    const harness = createHarness();
    const turn = await run(harness, await searchedContext(), '12014 wali');
    expect(turn.context.selectedTrain?.number).toBe('12014');

    const missing = await run(harness, await searchedContext(), '99999 wali');
    expect(missing.context.selectedTrain).toBeNull();
    expect(missing.reply).toMatch(/current result list mein nahi/i);
  });

  it('"last wali" selects the last result', async () => {
    const harness = createHarness();
    const turn = await run(harness, await searchedContext(), 'last wali');
    expect(turn.context.selectedTrain?.number).toBe('14542');
  });
});

describe('full selection flow → draft (booking safety visible end-to-end)', () => {
  it('full conversational flow: selection → class → availability+fare → passenger details → FINAL REVIEW', async () => {
    const harness = createHarness();
    const registry = harness.toolRegistry;
    let context = await searchedContext();

    context = (await run(harness, context, 'pehli wali')).context;
    const classTurn = await run(harness, context, 'CC');
    expect(classTurn.context.selectedClass).toBe('CC');
    expect(classTurn.executedTools).toContain('getAvailability'); // §7 fresh availability
    expect(classTurn.executedTools).toContain('getFare');         // §8 fare fetched (quietly, for the review)
    expect(classTurn.reply).toMatch(/AVAILABLE/i);
    expect(classTurn.reply).not.toMatch(/Railway fare/i);         // fare hidden mid-flow (review-only)
    context = classTurn.context;

    const countTurn = await run(harness, context, '2');
    expect(countTurn.reply).toMatch(/Passenger 1 of 2/i); // §21 progress
    context = countTurn.context;

    const replies: string[] = [];
    for (const group of [['Rahul', '30', 'M'], ['Priya', '28', 'F']]) {
      for (const answer of group) {
        const turn = await run(harness, context, answer as string);
        context = turn.context;
        replies.push(turn.reply);
      }
    }

    expect(context.bookingStage).toBe('WAITING_CONFIRMATION');
    expect(context.passengers).toHaveLength(2);
    expect(context.passengers[0]).toMatchObject({ name: 'Rahul', age: 30, gender: 'M', berthPreference: null });
    expect(context.passengers[1]).toMatchObject({ name: 'Priya', age: 28, gender: 'F', berthPreference: null });
    const reviewText = replies[replies.length - 1]!;
    expect(reviewText).toMatch(/BOOKING REVIEW/i);
    expect(reviewText).toMatch(/Railway fare/i);
    expect(reviewText).toMatch(/service fee/i);
    expect(reviewText).toMatch(/Total/i);
    expect(reviewText).toMatch(/confirm karun/i);
    expect(registry.get('confirmBooking')?.status).toBe('NOT_IMPLEMENTED');
    expect(registry.get('confirmBooking')?.aiRequestable).toBe(false);
  });
});

describe('comparison (§13)', () => {
  it('20: "12014 aur 14542 mein kaunsi better hai?" compares CURRENT results only, factual fields only', async () => {
    const harness = createHarness();
    const turn = await run(harness, await searchedContext(), '12014 aur 14542 mein kaunsi better hai?');
    expect(turn.intent).toBe('COMPARE_TRAINS');
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/14542/);
    expect(turn.reply).toMatch(/duration/i);
    expect(turn.reply).toMatch(/15 minute tez|115|tez/i); // factual duration difference (115 vs 130 = 15 min)
    expect(turn.reply).not.toMatch(/hamesha better/i);   // no subjective invention
    expect(turn.executedTools).not.toContain('searchTrains'); // used stored results only
  });

  it('comparison without prior search asks the user to search first', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 aur 14542 mein kaunsi better hai?');
    expect(turn.reply).toMatch(/pehle .*search/i);
  });

  it('comparison with a train outside the current list is refused honestly', async () => {
    const harness = createHarness();
    const context = await searchedContext();
    const turn = await run(harness, context, '12014 aur 99999 mein kaunsi better hai?');
    expect(turn.reply).toMatch(/current result list mein honi chahiye/i);
  });
});

describe('journey context defaults flow into references', () => {
  it('search results carry the resolved route for later questions', async () => {
    const harness = createHarness();
    const context = await searchedContext();
    expect(context.origin?.code).toBe('ASR');
    expect(context.destination?.code).toBe('LDH');
    expect(context.journeyDate).toBe(isoPlusDays(1));
    void setContextSlots; void setSearchResults; void ASR; void LDH; void makeSearchResults;
  });
});
