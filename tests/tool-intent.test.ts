/**
 * STEP 6 — TOOL-INTENT TESTS (§25 part 1).
 * Proves: every railway question maps to the correct approved tool, the tool
 * executes server-side with fresh data, invalid tools/arguments are rejected,
 * and no railway fact is ever fabricated.
 */

import { describe, expect, it } from 'vitest';
import { createHarness, freshContext, run } from './orchestration/harness.js';
import { AI_TOOL_CATALOG, catalogIdForRegistryTool, isAiSelectableTool, validateToolArguments } from '../api/ai/tool-catalog.js';

describe('catalog integrity', () => {
  it('contains every spec tool with the exact ids', () => {
    const ids = AI_TOOL_CATALOG.map((tool) => tool.id);
    for (const id of [
      'SEARCH_TRAINS', 'LOOKUP_STATION', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'GET_LIVE_STATUS',
      'GET_AVAILABILITY', 'GET_FARE', 'GET_PNR', 'GET_CANCELLED_TRAINS', 'GET_BOOKING_HISTORY',
      'GET_WALLET', 'COMPARE_TRAINS', 'CREATE_BOOKING_DRAFT', 'FARE_REVIEW', 'REQUEST_BOOKING_CONFIRMATION',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('PROHIBITED tools are rejected BY NAME for the AI', () => {
    expect(isAiSelectableTool('CONFIRM_BOOKING')).toBe(false);
    expect(isAiSelectableTool('PAYMENT')).toBe(false);
    expect(isAiSelectableTool('WALLET_DEBIT')).toBe(false);
    expect(isAiSelectableTool('GET_LIVE_STATUS')).toBe(true);
  });
});

describe('tool argument validation (§6)', () => {
  it('33: invalid arguments are rejected safely (formats)', () => {
    expect(validateToolArguments('GET_LIVE_STATUS', { trainNumber: 'ABC' }).ok).toBe(false);
    expect(validateToolArguments('GET_LIVE_STATUS', {}).ok).toBe(false); // missing required
    expect(validateToolArguments('GET_PNR', { pnr: '12345' }).ok).toBe(false);
    expect(validateToolArguments('GET_AVAILABILITY', { trainNumber: '12014', journeyDate: '27-08-2026', travelClass: 'CC' }).ok).toBe(false);
    expect(validateToolArguments('GET_AVAILABILITY', { trainNumber: '12014', journeyDate: '2026-08-27', travelClass: 'FIRST' }).ok).toBe(false);
    expect(validateToolArguments('SEARCH_TRAINS', { originCode: 'ASR', destinationCode: 'LDH', journeyDate: '2026-08-27', passengerCount: 9 }).ok).toBe(false);
  });

  it('rejects URL / method / credential arguments outright (§5)', () => {
    const validation = validateToolArguments('GET_LIVE_STATUS', { trainNumber: '12014', url: 'https://evil.example', method: 'POST', apiKey: 'stolen' });
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/forbidden/);
  });

  it('valid arguments pass and are normalized', () => {
    const validation = validateToolArguments('GET_AVAILABILITY', { trainNumber: '12014', journeyDate: '2026-08-27', travelClass: 'cc', fromStationCode: 'asr', toStationCode: 'LDH' });
    expect(validation.ok).toBe(true);
    expect(validation.sanitized.travelClass).toBe('CC');
    expect(validation.sanitized.fromStationCode).toBe('ASR');
  });
});

describe('§7 intent → tool matrix (fresh server-side data each time)', () => {
  it('1: "Amritsar se Ludhiana ki trains batao" → SEARCH_TRAINS (after date)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Amritsar se Ludhiana ki trains batao');
    expect(turn.intent).toBe('BOOK_TRAIN');
    const catalogIds = turn.executedTools.map((tool) => catalogIdForRegistryTool(tool));
    expect(catalogIds).toContain('LOOKUP_STATION'); // station resolution via tool
    expect(turn.reply).toMatch(/kis date/i);
  });

  it('7/8/9/14: live status / availability / fare / timetable', async () => {
    const harness = createHarness();
    const live = await run(harness, freshContext(), '12014 ka live status batao');
    expect(live.executedTools).toContain('getLiveStatus');
    expect(live.reply).toContain('12014');

    const late = await run(harness, freshContext(), '12014 kitni late hai?');
    expect(late.executedTools).toContain('getLiveStatus');

    const { contextWithJourney } = await import('./orchestration/railwayQueries.helpers.js');
    const context = contextWithJourney();
    const availability = await run(harness, context, '12014 mein CC ki kitni availability hai?');
    expect(availability.executedTools).toContain('getAvailability');

    const fare = await run(harness, context, '12014 ka CC fare kitna hai?');
    expect(fare.executedTools).toContain('getFare');

    const timetable = await run(harness, freshContext(), '12014 ka timetable batao');
    expect(timetable.executedTools).toContain('getTimetable');
  });

  it('10: PNR → GET_PNR (RailKit capability via router)', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'mera PNR 4123456789 check karo');
    expect(turn.executedTools).toContain('checkPNR');
  });

  it('11: booking history → GET_BOOKING_HISTORY', async () => {
    const turn = await run(createHarness(), freshContext(), 'meri ticket history dikhao');
    expect(turn.executedTools).toContain('getBookings');
  });

  it('12: wallet → GET_WALLET', async () => {
    const turn = await run(createHarness(), freshContext(), 'mera wallet batao');
    expect(turn.executedTools).toContain('getWallet');
  });

  it('13: cancelled → GET_CANCELLED_TRAINS', async () => {
    const turn = await run(createHarness(), freshContext(), 'cancelled trains batao');
    expect(turn.executedTools).toContain('getCancelledTrains');
  });

  it('15: "Delhi station ka code?" → LOOKUP_STATION', async () => {
    const turn = await run(createHarness(), freshContext(), 'New Delhi station ka code kya hai?');
    expect(turn.intent).toBe('LOOKUP_STATION');
    expect(turn.reply).toContain('NDLS');
  });

  it('16/17: glossary answers never call providers', async () => {
    const harness = createHarness();
    const cc = await run(harness, freshContext(), 'CC kya hota hai?');
    expect(cc.executedTools).toHaveLength(0);
    expect(cc.reply).toMatch(/Chair Car/i);
    const rac = await run(harness, freshContext(), 'RAC kya hota hai?');
    expect(rac.executedTools).toHaveLength(0);
  });
});

describe('no hallucination (§9 / §25: 34-36)', () => {
  it('34: fare always comes from the tool — never model memory', async () => {
    const harness = createHarness();
    let context = freshContext();
    const { contextWithJourney } = await import('./orchestration/railwayQueries.helpers.js');
    context = contextWithJourney();
    const turn = await run(harness, context, '12014 ka CC fare kitna hai?');
    expect(turn.executedTools).toContain('getFare');
    expect(turn.reply).toContain('₹405.00'); // the exact provider-quoted value
  });

  it('35: availability never invented — unknown provider status → honest UNKNOWN', async () => {
    const { providerSuccess } = await import('../shared/index.js');
    const harness = createHarness({ availability: providerSuccess('RAILCORE', {
      trainNumber: '12014', journeyDate: '2026-08-27', travelClass: 'CC', quota: 'GN',
      status: 'UNAVAILABLE', availableCount: null, racCount: null, waitlistNumber: null, asOf: null,
    }) });
    let context = freshContext();
    const { contextWithJourney } = await import('./orchestration/railwayQueries.helpers.js');
    context = contextWithJourney();
    const turn = await run(harness, context, '12014 mein CC ki kitni seats hain?');
    expect(turn.executedTools).toContain('getAvailability');
    expect(turn.reply).not.toMatch(/\d+ seats AVAILABLE/i); // no invented count
  });

  it('36: live status never invented — provider failure → honest unavailable', async () => {
    const { providerFailure } = await import('../shared/index.js');
    const harness = createHarness({ liveStatus: providerFailure('HTTP_ERROR', 'down', { httpStatus: 503, source: 'RAILCORE' }) });
    const turn = await run(harness, freshContext(), '12014 abhi kaha hai?');
    expect(turn.executedTools).toContain('getLiveStatus');
    expect(turn.reply).toMatch(/available nahi/i);
    expect(turn.reply).not.toMatch(/12014 abhi \w+ par hai\./i);
  });
});
