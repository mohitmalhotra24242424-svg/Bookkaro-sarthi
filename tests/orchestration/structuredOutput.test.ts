/**
 * Structured-output validator (§2): the backend never trusts AI JSON blindly.
 */

import { describe, expect, it } from 'vitest';
import { validateAIUnderstanding } from '../../ai/structuredOutput.js';
import type { ToolName } from '../../shared/index.js';

const ALL_TOOLS: readonly ToolName[] = [
  'lookupStation', 'searchTrains', 'getTrainInfo', 'getTimetable', 'getLiveStatus', 'getAvailability',
  'getFare', 'checkPNR', 'getCancelledTrains', 'getBookings', 'getWallet', 'compareTrains',
  'createBookingDraft', 'reviewFare', 'confirmBooking',
];

function validate(raw: unknown) {
  return validateAIUnderstanding({
    raw,
    availableTools: ALL_TOOLS,
    isToolAiRequestable: (tool) => tool !== 'confirmBooking', // registry-equivalent policy
  });
}

describe('validateAIUnderstanding', () => {
  it('accepts the documented wire schema and sanitizes it into the internal shape', () => {
    const result = validate({
      intent: 'LIVE_TRAIN_STATUS',
      tool: 'getLiveStatus',
      entities: { trainNumber: '12014', date: null },
      missing: [],
      confidence: 0.95,
    });
    expect(result.ok).toBe(true);
    expect(result.result?.intent).toBe('LIVE_TRAIN_STATUS');
    expect(result.result?.slots.trainNumber).toBe('12014');
    expect(result.result?.confidence).toBe(0.95);
    expect(result.toolCall?.tool).toBe('getLiveStatus');
  });

  it('accepts BOOK_TRAIN with missing slots (wire example 2)', () => {
    const result = validate({
      intent: 'BOOK_TRAIN',
      tool: 'searchTrains',
      entities: { origin: 'ASR', destination: 'LDH', date: null, passengerCount: null },
      missing: ['date', 'passengerCount'],
      confidence: 0.8,
    });
    expect(result.ok).toBe(true);
    expect(result.result?.slots.originQuery).toBe('ASR');
    expect(result.result?.missingFields).toEqual(['journeyDate', 'passengerCount']); // 'date' now maps to the journeyDate slot (Step-8 model-compat)
  });

  it('rejects non-objects, unknown intents and malformed entities', () => {
    expect(validate('just a string').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
    expect(validate({ intent: 'HACK_THE_RAILWAYS', entities: {} }).ok).toBe(false);
    expect(validate({ intent: 'CHECK_PNR', entities: { pnr: '123' } }).ok).toBe(false); // not 10 digits
    expect(validate({ intent: 'LIVE_TRAIN_STATUS', entities: { trainNumber: 'XX123' } }).ok).toBe(false);
    expect(validate({ intent: 'BOOK_TRAIN', entities: { passengerCount: 99 } }).ok).toBe(false);
  });

  it('drops URLs from every string field — the AI cannot pick endpoints', () => {
    const result = validate({
      intent: 'LIVE_TRAIN_STATUS',
      entities: { trainNumber: '12014', origin: 'http://evil.example.com' },
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
    expect(result.result?.slots.originQuery).toBeNull(); // URL stripped to null
  });

  it('rejects protected/unregistered tools as TOOL rejections while keeping the turn alive', () => {
    const protectedTool = validate({ intent: 'BOOK_TRAIN', tool: 'confirmBooking', entities: {}, confidence: 0.9 });
    expect(protectedTool.ok).toBe(true);
    expect(protectedTool.result?.toolRequest).toBeNull();
    expect(protectedTool.toolErrors.join(' ')).toMatch(/protected tool "confirmBooking"/);

    const unknownTool = validate({ intent: 'VIEW_WALLET', tool: 'stealMoney', entities: {}, confidence: 0.9 });
    expect(unknownTool.ok).toBe(true);
    expect(unknownTool.toolErrors.join(' ')).toMatch(/unregistered tool "stealMoney"/);

    const urlTool = validate({ intent: 'LIVE_TRAIN_STATUS', tool: 'getLiveStatus', toolInput: { url: 'https://x' }, entities: { trainNumber: '12014' } });
    expect(urlTool.ok).toBe(true);
    expect(urlTool.toolErrors.join(' ')).toMatch(/URL/);
    expect(urlTool.toolCall).toBeUndefined();
  });

  it('clamps confidence and validates travel classes', () => {
    const result = validate({ intent: 'GET_AVAILABILITY', entities: { travelClass: 'CC' }, confidence: 42 });
    expect(result.ok).toBe(true);
    expect(result.result?.confidence).toBe(1);
    expect(result.result?.slots.travelClass).toBe('CC');

    const badClass = validate({ intent: 'GET_AVAILABILITY', entities: { travelClass: 'FIRST' }, confidence: 0.5 });
    expect(badClass.ok).toBe(true);
    expect(badClass.result?.slots.travelClass).toBeNull(); // unknown class → null, never coerced
  });
});
