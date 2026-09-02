/**
 * Railway question flows through the full orchestrator (MOCK): live status,
 * availability, fare, timetable, train info, PNR, bookings, wallet,
 * cancelled trains — plus missing-information asks.
 */

import { describe, expect, it } from 'vitest';
import { freshContext, run, createHarness } from './harness.js';
import type { ConversationContext } from '../../shared/index.js';
import { setContextSlots, setSearchResults } from '../../shared/index.js';
import { makeSearchResults, ASR, LDH } from './harness.js';

function contextWithJourney(): ConversationContext {
  let context = freshContext();
  context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27', passengerCount: 2 }, 'FILL_MISSING');
  context = setSearchResults(context, makeSearchResults());
  context = setContextSlots(context, { selectedTrain: makeSearchResults()[0]!.train }, 'FILL_MISSING');
  return context;
}

describe('live status (§6)', () => {
  it('6: "12014 ka live status batao" → getLiveStatus tool → factual reply', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ka live status batao');
    expect(turn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toContain('12014');
    expect(turn.reply).toMatch(/minute|RUNNING|pahunch|late/i);
  });

  it('asks which train when none is known', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'live status batao');
    expect(turn.executedTools).not.toContain('getLiveStatus');
    expect(turn.reply).toMatch(/kaunsi train/i);
  });
});

describe('availability (§7/§10)', () => {
  it('7: "12014 mein CC mein seat hai?" → availability tool with route+date from context', async () => {
    const harness = createHarness();
    const turn = await run(harness, contextWithJourney(), '12014 mein CC mein seat hai?');
    expect(turn.intent).toBe('GET_AVAILABILITY');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.reply).toMatch(/AVAILABLE/i);
  });

  it('asks for the missing class, then the missing date — one field at a time', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = setContextSlots(context, { origin: ASR, destination: LDH, journeyDate: '2026-08-27' }, 'FILL_MISSING');

    const noClass = await run(harness, context, '12014 mein kitni seats hain?');
    expect(noClass.reply).toMatch(/kaunsi class/i);
    expect(noClass.executedTools).not.toContain('getAvailability');

    const noDate = await run(harness, freshContext(), '12014 mein CC seat hai?'); // no journey context at all
    expect(noDate.reply).toMatch(/kis date|kis route/i);
  });
});

describe('fare (§8)', () => {
  it('8: "CC mein kitna fare hai?" uses the selected train + route, provider-quoted total', async () => {
    const harness = createHarness();
    const turn = await run(harness, contextWithJourney(), 'CC mein kitna fare hai?');
    expect(turn.intent).toBe('GET_FARE');
    expect(turn.executedTools).toContain('getFare');
    expect(turn.reply).toContain('₹405.00'); // 40500 paise — verbatim from the tool result
  });
});

describe('timetable / train info (§9/§10)', () => {
  it('9: timetable via tool', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ka timetable batao');
    expect(turn.executedTools).toContain('getTimetable');
    expect(turn.reply).toMatch(/timetable|stops/i);
  });

  it('10: train info via tool', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), '12014 ke baare mein batao');
    expect(turn.executedTools).toContain('getTrainInfo');
    expect(turn.reply).toContain('12014');
  });
});

describe('PNR (§11)', () => {
  it('11: "PNR 4123456789 check karo" → checkPNR tool, statuses only (names never existed here)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'PNR 4123456789 check karo');
    expect(turn.intent).toBe('CHECK_PNR');
    expect(turn.executedTools).toContain('checkPNR');
    expect(turn.reply).toContain('CONFIRMED');
    expect(turn.reply).not.toMatch(/PASSENGER (ONE|TWO)/i);
  });

  it('asks for the PNR when missing', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mera PNR check karo');
    expect(turn.reply).toMatch(/PNR number/i);
    expect(turn.executedTools).not.toContain('checkPNR');
  });
});

describe('user data (§12/§13)', () => {
  it('12: "meri tickets dikhao" → honest empty bookings (no booking system exists)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Meri tickets dikhao');
    expect(turn.intent).toBe('VIEW_BOOKINGS');
    expect(turn.executedTools).toContain('getBookings');
    expect(turn.reply).toMatch(/koi booked ticket nahi/i);
  });

  it('13: "wallet balance dikhao" → honest unavailable (wallet not implemented)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'wallet ka balance dikhao');
    expect(turn.intent).toBe('VIEW_WALLET');
    expect(turn.executedTools).toContain('getWallet');
    expect(turn.reply).toMatch(/available nahi/i);
  });
});

describe('cancelled trains (§14)', () => {
  it('14: cancelled list via the RailKit capability through the router', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'aaj ki cancelled trains batao');
    expect(turn.intent).toBe('GET_CANCELLED_TRAINS');
    expect(turn.executedTools).toContain('getCancelledTrains');
    expect(turn.reply).toContain('15098');
  });
});
