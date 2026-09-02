import { describe, expect, it } from 'vitest';
import {
  canonicalStationCode,
  collapseEquivalentStations,
  trainServesCommercialSegment,
} from '../shared/trainHalt.js';

function stops(...codes: string[]) {
  return codes.map((stationCode) => ({ stationCode }));
}

describe('trainServesCommercialSegment', () => {
  it('true when both codes are commercial stops in order', () => {
    expect(trainServesCommercialSegment(stops('ASR', 'BEAS', 'JUC', 'NDLS'), 'ASR', 'NDLS')).toBe(true);
    expect(trainServesCommercialSegment(stops('ASR', 'LDH'), 'asr', 'ldh')).toBe(true);
  });

  it('false when destination is not a halt (DLI train is not NDLS)', () => {
    expect(trainServesCommercialSegment(stops('PTK', 'ASR', 'BEAS', 'JUC', 'DLI'), 'ASR', 'NDLS')).toBe(false);
  });

  it('false when origin is missing or order is reversed', () => {
    expect(trainServesCommercialSegment(stops('NDLS', 'CNB'), 'ASR', 'NDLS')).toBe(false);
    expect(trainServesCommercialSegment(stops('ASR', 'NDLS'), 'NDLS', 'ASR')).toBe(false);
  });

  it('true when destination appears after origin even if the code also appeared earlier', () => {
    expect(trainServesCommercialSegment(stops('ASR', 'NDLS', 'ASR'), 'NDLS', 'ASR')).toBe(true);
  });

  it('null when there is no schedule to judge', () => {
    expect(trainServesCommercialSegment([], 'ASR', 'NDLS')).toBeNull();
    expect(trainServesCommercialSegment(null, 'ASR', 'NDLS')).toBeNull();
  });

  it('BCT and MMCT are the same Mumbai Central halt', () => {
    expect(canonicalStationCode('BCT')).toBe('MMCT');
    expect(trainServesCommercialSegment(stops('MMCT', 'BVI', 'ST', 'NDLS'), 'BCT', 'NDLS')).toBe(true);
    expect(trainServesCommercialSegment(stops('CSMT', 'DR', 'NDLS'), 'BCT', 'NDLS')).toBe(false);
  });
});

describe('collapseEquivalentStations', () => {
  it('keeps MMCT and drops duplicate BCT', () => {
    const collapsed = collapseEquivalentStations([
      { code: 'BCT', name: 'MUMBAI CENTRAL' },
      { code: 'MMCT', name: 'MUMBAI CENTRAL' },
      { code: 'LTT', name: 'LOKMANYA TILAK T' },
    ]);
    expect(collapsed.map((s) => s.code)).toEqual(['MMCT', 'LTT']);
  });
});
