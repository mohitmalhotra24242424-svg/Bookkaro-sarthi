import { describe, expect, it } from 'vitest';
import { newId } from '../shared/index.js';
import type { ToolCall } from '../shared/index.js';
import {
  TOOL_DEFINITIONS,
  ToolRegistry,
  createDefaultToolRegistry,
  validateToolInput,
} from '../tools/index.js';

const EXPECTED_TOOLS = [
  'searchTrains',
  'lookupStation',
  'getTrainInfo',
  'getTimetable',
  'getLiveStatus',
  'getAvailability',
  'getFare',
  'getCancelledTrains',
  'checkPNR',
  'getBookings',
  'getWallet',
  'compareTrains',
  'createBookingDraft',
  'reviewFare',
  'confirmBooking',
  'acknowledgeBookingConfirmation',
  'executeMockBooking',
  'getRailwayKnowledge',
];

function call(tool: ToolCall['tool'], input: Record<string, unknown>, requestedBy: ToolCall['requestedBy'] = 'AI'): ToolCall {
  return { id: newId('tc'), tool, input, requestedBy, conversationId: 'conv-1', createdAt: new Date().toISOString() };
}

describe('tool registry: definitions', () => {
  const registry = createDefaultToolRegistry();

  it('registers exactly the 18 planned tools', () => {
    expect(registry.list().map((d) => d.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(TOOL_DEFINITIONS).toHaveLength(18);
  });

  it('every tool declares name, input, output, validation boundary and status', () => {
    for (const definition of registry.list()) {
      expect(definition.summary.length, definition.name).toBeGreaterThan(0);
      expect(definition.description.length, definition.name).toBeGreaterThan(10);
      expect(definition.input.every((f) => f.name && f.type && typeof f.required === 'boolean' && f.description), definition.name).toBe(true);
      expect(definition.outputDescription.length, definition.name).toBeGreaterThan(0);
      expect(['AI_REQUEST_SERVER_VALIDATED', 'DETERMINISTIC_ONLY'], definition.name).toContain(definition.executionPolicy);
      expect(['NONE', 'CREATES_DRAFT', 'EXECUTES_BOOKING', 'MOVES_MONEY'], definition.name).toContain(definition.sideEffects);
    }
  });

  it('ALL tools are honestly NOT_IMPLEMENTED in Step 1', () => {
    for (const definition of registry.list()) {
      expect(definition.status, definition.name).toBe('NOT_IMPLEMENTED');
    }
  });

  it('confirmBooking is DETERMINISTIC_ONLY and not AI-requestable (booking safety)', () => {
    const confirm = registry.get('confirmBooking');
    expect(confirm?.aiRequestable).toBe(false);
    expect(confirm?.executionPolicy).toBe('DETERMINISTIC_ONLY');
    expect(confirm?.sideEffects).toBe('EXECUTES_BOOKING');
    expect(confirm?.category).toBe('PAYMENT');
  });

  it('wallet tool is read-only (no side effects)', () => {
    const wallet = registry.get('getWallet');
    expect(wallet?.aiRequestable).toBe(true);
    expect(wallet?.sideEffects).toBe('NONE');
  });
});

describe('tool registry: validation boundary', () => {
  const registry = createDefaultToolRegistry();

  it('rejects unknown tools', () => {
    const validation = registry.validateToolCall(call('launchMissiles' as never, {}));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unknown tool/i);
  });

  it('rejects an AI request for confirmBooking', () => {
    const validation = registry.validateToolCall(call('confirmBooking', { draftId: 'draft_1' }, 'AI'));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/DETERMINISTIC_ONLY/);
  });

  it('rejects unknown input fields (no smuggling)', () => {
    const validation = registry.validateToolCall(call('checkPNR', { pnr: '1234567890', url: 'http://evil.example' }));
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unknown field "url"/);
  });

  it('rejects URLs inside string inputs (AI cannot pick endpoints)', () => {
    const validation = validateToolInput(
      [{ name: 'query', type: 'string', required: true, description: 'station query' }],
      { query: 'see http://evil.example' },
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/URL/);
  });

  it('enforces formats: PNR digits, train numbers, ISO dates, station codes', () => {
    expect(registry.validateToolCall(call('checkPNR', { pnr: '12345' })).ok).toBe(false);
    expect(registry.validateToolCall(call('getTrainInfo', { trainNumber: '12A14' })).ok).toBe(false);
    expect(registry.validateToolCall(call('searchTrains', { originCode: 'ASR', destinationCode: 'LDH', journeyDate: '27-08-2026' })).ok).toBe(false);
    expect(registry.validateToolCall(call('searchTrains', { originCode: 'A', destinationCode: 'LDH' })).ok).toBe(false);
  });

  it('enforces required fields and numeric ranges', () => {
    expect(registry.validateToolCall(call('checkPNR', {})).ok).toBe(false);
    expect(registry.validateToolCall(call('searchTrains', { originCode: 'ASR', destinationCode: 'LDH', passengerCount: 9 })).ok).toBe(false);
    expect(registry.validateToolCall(call('searchTrains', { originCode: 'ASR', destinationCode: 'LDH', passengerCount: 2.5 })).ok).toBe(false);
  });

  it('compareTrains needs a list of 2+ valid train numbers', () => {
    expect(registry.validateToolCall(call('compareTrains', { trainNumbers: ['12014'] })).ok).toBe(false);
    expect(registry.validateToolCall(call('compareTrains', { trainNumbers: ['12014', 'XX'] })).ok).toBe(false);
    expect(registry.validateToolCall(call('compareTrains', { trainNumbers: ['12014', '14542'] })).ok).toBe(true);
  });

  it('accepts a well-formed AI tool request', () => {
    const validation = registry.validateToolCall(call('checkPNR', { pnr: '1234567890' }));
    expect(validation.ok).toBe(true);
  });
});

describe('tool registry: execution is server-side, honest and inert in Step 1', () => {
  const registry = createDefaultToolRegistry();
  const context = { actor: 'AI' as const, userId: 'user-1', conversationId: 'conv-1' };

  it('a valid AI request executes server-side but honestly reports NOT_IMPLEMENTED with zero data', async () => {
    const result = await registry.execute(call('searchTrains', { originCode: 'ASR', destinationCode: 'LDH' }), context);
    expect(result.executedBy).toBe('SERVER');
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.unavailableReason).toBe('NOT_IMPLEMENTED');
    expect(result.error?.code).toBe('TOOL_NOT_IMPLEMENTED');
  });

  it('never fabricates a PNR answer for checkPNR', async () => {
    const result = await registry.execute(call('checkPNR', { pnr: '1234567890' }), context);
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
  });

  it('rejected calls are marked TOOL_CALL_REJECTED and executed by SERVER only', async () => {
    const result = await registry.execute(call('confirmBooking', { draftId: 'd1' }, 'AI'), context);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_CALL_REJECTED');
    expect(result.executedBy).toBe('SERVER');
  });

  it('describeAll returns JSON-serializable descriptors safe for AI prompts', () => {
    const descriptors = registry.describeAll();
    expect(descriptors).toHaveLength(18);
    expect(() => JSON.stringify(descriptors)).not.toThrow();
    expect(JSON.stringify(descriptors)).not.toMatch(/https?:\/\//);
  });

  it('refuses duplicate registration', () => {
    const fresh = new ToolRegistry();
    const definition = TOOL_DEFINITIONS[0]!;
    fresh.register(definition);
    expect(() => fresh.register(definition)).toThrowError(/already registered/);
  });
});
