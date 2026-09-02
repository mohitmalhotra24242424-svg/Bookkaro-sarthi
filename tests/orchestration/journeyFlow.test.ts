/**
 * Journey conversation flow (MOCK): search, missing info, explicit dates,
 * station resolution, interruption/resume, corrections.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, isoPlusDays, run } from './harness.js';

describe('journey flow: search + missing information (§8/§10)', () => {
  it('1/2: "Mujhe Amritsar se Ludhiana jaana hai" resolves both stations, asks ONLY for the date, never searches', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Amritsar se Ludhiana jaana hai');

    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.reply).toMatch(/kis date/i);
    expect(harness.countCapability('stationLookup')).toBe(2); // name → code via the lookup TOOL
    expect(harness.countCapability('trainSearch')).toBe(0);   // no search without a date
  });

  it('4: "Kal" fills ONLY the date (stations preserved) and triggers the search', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'Kal');

    expect(turn.context.origin?.code).toBe('ASR');
    expect(turn.context.destination?.code).toBe('LDH');
    expect(turn.context.journeyDate).toBe(isoPlusDays(1)); // tomorrow, deterministically resolved
    expect(turn.context.lastSearchResults).toHaveLength(2);
    expect(turn.reply).toMatch(/12014/);
    expect(turn.reply).toMatch(/14542/);
  });

  it('3: explicit "aaj" means today — never silently assumed', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const turn = await run(harness, context, 'aaj');
    expect(turn.context.journeyDate).toBe(isoPlusDays(0));
  });

  it('5: "parso" means the day after tomorrow', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Jammu se Beas jaana hai')).context;
    const turn = await run(harness, context, 'parso');
    expect(turn.context.origin?.code).toBe('JAT');
    expect(turn.context.destination?.code).toBe('BEAS');
    expect(turn.context.journeyDate).toBe(isoPlusDays(2));
  });

  it('16: Jammu → Beas resolves both stations through the provider (no invented codes)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Jammu se Beas jaana hai');
    expect(harness.countCapability('stationLookup')).toBeGreaterThanOrEqual(2);
    expect(turn.reply).toMatch(/kis date/i);
  });

  it('15: station lookup as a direct question', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Ludhiana ka station code kya hai?');
    expect(turn.intent).toBe('LOOKUP_STATION');
    expect(turn.reply).toContain('LDH');
  });

  it('does not re-ask known fields — asks only the NEXT missing field', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;
    const dateTurn = await run(harness, context, 'kal');
    expect(dateTurn.reply).not.toMatch(/kahan se/i); // origin/destination never re-asked
    expect(dateTurn.reply).not.toMatch(/kahan tak/i);
  });
});

describe('interruption & resume (§9)', () => {
  it('26: live-status question interrupts a pending booking, then 27: "Kal jaana hai" resumes it — kal is the BOOKING date, not the live-status date', async () => {
    const harness = createHarness();
    let context = freshContext();

    context = (await run(harness, context, 'Mujhe Amritsar se New Delhi jaana hai')).context; // exact, unambiguous
    expect(context.journeyDate).toBeNull();
    expect(context.lastAskedField).toBe('journeyDate');

    const liveTurn = await run(harness, context, '12014 ka live status batao');
    expect(liveTurn.intent).toBe('LIVE_TRAIN_STATUS');
    expect(liveTurn.reply).toMatch(/12014/);
    expect(liveTurn.context.pausedBooking).not.toBeNull();        // booking snapshotted
    expect(liveTurn.context.origin?.code).toBe('ASR');            // slots intact via snapshot

    const before = harness.countCapability('liveStatus');
    const resumeTurn = await run(harness, liveTurn.context, 'Kal jaana hai');
    expect(harness.countCapability('liveStatus')).toBe(before);   // "kal" did NOT re-run live status
    expect(harness.countCapability('trainSearch')).toBe(1);       // it resumed the booking search
    expect(resumeTurn.context.journeyDate).toBe(isoPlusDays(1));
    expect(resumeTurn.context.destination?.code).toBe('NDLS');
    expect(resumeTurn.context.lastSearchResults).toHaveLength(2);
    expect(resumeTurn.context.pausedBooking).toBeNull();
  });
});

describe('corrections (§11)', () => {
  it('28: "Nahi, Jalandhar se jaana hai" corrects ONLY the origin; destination survives', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se Ludhiana jaana hai')).context;

    const turn = await run(harness, context, 'Nahi, Jalandhar se jaana hai');
    expect(turn.context.origin?.code).toBe('JRC');
    expect(turn.context.destination?.code).toBe('LDH'); // NOT erased
    expect(turn.context.userCorrections.length).toBeGreaterThanOrEqual(1); // audited
    expect(turn.reply).toMatch(/kis date/i); // flow continues where it left off
  });

  it('29: "Delhi nahi, Chandigarh" corrects ONLY the destination; origin survives', async () => {
    const harness = createHarness();
    let context = freshContext();
    context = (await run(harness, context, 'Mujhe Amritsar se New Delhi jaana hai')).context;

    const turn = await run(harness, context, 'Delhi nahi, Chandigarh');
    expect(turn.context.origin?.code).toBe('ASR');      // NOT erased
    expect(turn.context.destination?.code).toBe('CHD');
    expect(turn.reply).toMatch(/kis date/i);
  });
});
