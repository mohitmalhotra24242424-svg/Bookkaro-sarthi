import { describe, expect, it } from 'vitest';
import { trainServesCommercialSegment } from '../shared/trainHalt.js';

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

  it('null when there is no schedule to judge', () => {
    expect(trainServesCommercialSegment([], 'ASR', 'NDLS')).toBeNull();
    expect(trainServesCommercialSegment(null, 'ASR', 'NDLS')).toBeNull();
  });
});
