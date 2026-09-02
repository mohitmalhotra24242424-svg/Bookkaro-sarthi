import { describe, expect, it } from 'vitest';
import { understandAutonomously } from '../ai/autonomous/AutonomousIntentEngine.js';
import { DeterministicNLUProvider } from '../ai/providers/DeterministicNLUProvider.js';
import { stationFromDirectInput } from '../ai/slotResolution.js';
import { createConversationContext } from '../shared/index.js';

function idle() {
  return createConversationContext({ userId: 'test' });
}

function originDest(entities: { type: string; value: unknown }[]) {
  return {
    origin: entities.find((e) => e.type === 'origin')?.value ?? null,
    destination: entities.find((e) => e.type === 'destination')?.value ?? null,
  };
}

describe('station capture (token before se — never the whole prefix)', () => {
  it('understandAutonomously: filler words are not the origin', () => {
    const a = understandAutonomously('mujhe kal amritsar se ludhiana jaana hai', idle());
    expect(originDest(a.entities)).toEqual({ origin: 'amritsar', destination: 'ludhiana' });

    const b = understandAutonomously('bhai kal subah ki train chahiye asr se ldh', idle());
    const stations = originDest(b.entities);
    expect(String(stations.origin).toLowerCase()).toMatch(/amritsar|asr/);
    expect(String(stations.destination).toLowerCase()).toMatch(/ludhiana|ldh/);
    expect(String(stations.origin).toLowerCase()).not.toMatch(/bhai|kal|subah|train|chahiye/);
  });

  it('DeterministicNLU: ASR se LDH and Amritsar se Ludhiana', async () => {
    const nlu = new DeterministicNLUProvider();
    const asr = await nlu.understand({
      userMessage: 'ASR se LDH jaana hai',
      conversation: idle(),
      availableIntents: [],
      availableTools: [],
    });
    expect(asr.slots.originQuery?.toUpperCase()).toBe('ASR');
    expect(asr.slots.destinationQuery?.toUpperCase()).toBe('LDH');
    expect(asr.intent).toMatch(/BOOK_TRAIN|SEARCH_TRAIN/);

    const named = await nlu.understand({
      userMessage: 'mujhe kal amritsar se ludhiana jaana hai',
      conversation: idle(),
      availableIntents: [],
      availableTools: [],
    });
    expect(named.slots.originQuery?.toLowerCase()).toBe('amritsar');
    expect(named.slots.destinationQuery?.toLowerCase()).toBe('ludhiana');
  });

  it('lowercase asr/ldh are typed codes, mixed-case city names are not', () => {
    expect(stationFromDirectInput('asr')?.station?.code).toBe('ASR');
    expect(stationFromDirectInput('ldh')?.station?.code).toBe('LDH');
    expect(stationFromDirectInput('ASR')?.station?.code).toBe('ASR');
    expect(stationFromDirectInput('amritsar')).toBeNull();
    expect(stationFromDirectInput('kal')).toBeNull();
  });

  it('DeterministicNLU: greetings map to HELP (not UNKNOWN)', async () => {
    const nlu = new DeterministicNLUProvider();
    const hi = await nlu.understand({
      userMessage: 'hi',
      conversation: idle(),
      availableIntents: [],
      availableTools: [],
    });
    expect(hi.intent).toBe('HELP');
  });
});
