/**
 * STATION NAME RESOLUTION (user complaint fix): "Ludhiana se Haridwar jaana hai"
 * type queries must resolve by NAME — providers return "HARIDWAR JN",
 * "LUDHIANA JN", "LUDHIANA QUICK TRANS" etc. Junction-suffix matching +
 * provider confidence/isMajor signals auto-pick the main station; genuine
 * ambiguity still asks. Verified against REAL RailCore response shapes.
 */

import { describe, expect, it } from 'vitest';
import { canonicalLookupQuery, stationFromLookup } from '../../ai/slotResolution.js';
import type { Station } from '../../shared/index.js';
import { createHarness, freshContext, run } from '../orchestration/harness.js';

const S = (code: string, name: string, extra: Partial<Station> = {}): Station => ({
  code, name, zone: null, state: null, latitude: null, longitude: null, ...extra,
});

// Real RailCore response shapes (captured live 2026-08-28)
const LUDHIANA_RESULTS: Station[] = [
  S('LDH', 'LUDHIANA JN', { confidence: 1, isMajor: true }),
  S('LQTS', 'LUDHIANA QUICK TRANS', { confidence: 0.62 }),
  S('GNGR', 'GUNGRANA'),
];
const HARIDWAR_RESULTS: Station[] = [
  S('HW', 'HARIDWAR JN', { confidence: 1, isMajor: true }),
  S('HDS', 'HARIDASPUR'),
  S('HRJ', 'HARIJ'),
];

describe('stationFromLookup: name → main station (verified provider shapes)', () => {
  it('"ludhiana" with 2 real Ludhiana stations asks — never silent-picks JN over Quick Trans', () => {
    const result = stationFromLookup('ludhiana', LUDHIANA_RESULTS);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['LDH', 'LQTS']);
  });

  it('"ludhiana" with only one related station auto-picks LDH (noise like GUNGRANA ignored)', () => {
    const result = stationFromLookup('ludhiana', [S('LDH', 'LUDHIANA JN', { isMajor: true }), S('GNGR', 'GUNGRANA')]);
    expect(result.station?.code).toBe('LDH');
    expect(result.choiceNeeded).toBeNull();
  });

  it('"haridwar" → HW (HARIDWAR JN) — even with HARIDASPUR/HARIJ in results', () => {
    const result = stationFromLookup('haridwar', HARIDWAR_RESULTS);
    expect(result.station?.code).toBe('HW');
    expect(result.choiceNeeded).toBeNull();
  });

  it('exact name still wins ("BEAS")', () => {
    expect(stationFromLookup('beas', [S('BEAS', 'BEAS')]).station?.code).toBe('BEAS');
  });

  it('2+ related stations from REAL lookup ask — no hardcoded city list (Jalandhar City vs Cantt)', () => {
    const result = stationFromLookup('jalandhar', [
      S('JRC', 'JALANDHAR CITY', { confidence: 1, isMajor: true }),
      S('JUC', 'JALANDHAR CANTT', { confidence: 0.6 }),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['JRC', 'JUC']);
  });

  it('specific station name is kept — "Jalandhar City" does not re-ask', () => {
    const result = stationFromLookup('Jalandhar City', [
      S('JRC', 'Jalandhar City'),
      S('JUC', 'Jalandhar Cantt'),
    ]);
    expect(result.station?.code).toBe('JRC');
    expect(result.choiceNeeded).toBeNull();
  });

  it('Mumbai-style lookup (any India city) asks every related station from provider data', () => {
    const result = stationFromLookup('mumbai', [
      S('CSTM', 'MUMBAI CST'),
      S('BCT', 'MUMBAI CENTRAL'),
      S('LTT', 'LOKMANYA TILAK T'),
      S('BDTS', 'BANDRA TERMINUS', { city: 'Mumbai' }),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['BCT', 'BDTS', 'CSTM']);
  });

  it('Mumbai lookup includes LTT when provider city is Mumbai', () => {
    const result = stationFromLookup('mumbai', [
      S('CSTM', 'MUMBAI CST'),
      S('BCT', 'MUMBAI CENTRAL'),
      S('LTT', 'LOKMANYA TILAK T', { city: 'Mumbai' }),
      S('BDTS', 'BANDRA TERMINUS', { city: 'Mumbai' }),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['BCT', 'BDTS', 'CSTM', 'LTT']);
  });

  it('bangalore aliases onto bengaluru stations and asks every related one', () => {
    const result = stationFromLookup('bangalore', [
      S('BNC', 'BENGALURU CANT', { city: 'Bengaluru', isMajor: true }),
      S('BNCE', 'BENGALURU EAST', { city: 'Bengaluru' }),
      S('SBC', 'KSR BENGALURU', { city: 'Bengaluru', isMajor: true, confidence: 1 }),
      S('SMVB', 'SMVT BENGALURU', { city: 'Bengaluru' }),
      S('BNJ', 'BANGAON JN'),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['BNC', 'BNCE', 'SBC', 'SMVB']);
  });

  it('Amritsar JN and CBA are both offered — never silent ASR', () => {
    const result = stationFromLookup('amritsar', [
      S('ASR', 'AMRITSAR JN', { city: 'Amritsar', isMajor: true }),
      S('ASRA', 'AMRITSAR CBA'),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['ASR', 'ASRA']);
  });

  it('"amritsar jn" auto-picks ASR — never asks ASR vs ASRA vs Verka', () => {
    const result = stationFromLookup('amritsar jn', [
      S('ASR', 'AMRITSAR JN', { city: 'Amritsar', isMajor: true }),
      S('ASRA', 'AMRITSAR CBA'),
      S('VKA', 'VERKA JN', { city: 'Amritsar' }),
    ]);
    expect(result.station?.code).toBe('ASR');
    expect(result.choiceNeeded).toBeNull();
  });

  it('"ludhiana jn" / "ldh jn" auto-picks LDH over Quick Trans', () => {
    expect(stationFromLookup('ludhiana jn', LUDHIANA_RESULTS).station?.code).toBe('LDH');
    expect(stationFromLookup('ldh jn', LUDHIANA_RESULTS).station?.code).toBe('LDH');
    expect(stationFromLookup('ludhiana jn', LUDHIANA_RESULTS).choiceNeeded).toBeNull();
  });

  it('drops cabin/yard/CB noise and still asks real Lucknow stations', () => {
    const result = stationFromLookup('lucknow', [
      S('LKO', 'LUCKNOW NR', { city: 'Lucknow', isMajor: true }),
      S('LJN', 'LUCKNOW NE', { city: 'Lucknow', isMajor: true }),
      S('LC', 'LUCKNOW CITY', { city: 'Lucknow' }),
      S('LKOY', 'LUCKNOW YARD'),
      S('HZG', 'LUCKNOW C B'),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['LC', 'LJN', 'LKO']);
  });

  it('Pune RVLWR noise is dropped so unique PUNE JN is kept', () => {
    const result = stationFromLookup('pune', [
      S('PUNE', 'PUNE JN', { city: 'Pune', isMajor: true }),
      S('RP', 'PUNE RVLWR PETH'),
    ]);
    expect(result.station?.code).toBe('PUNE');
    expect(result.choiceNeeded).toBeNull();
  });

  it('canonicalLookupQuery maps historic names, leaves others intact', () => {
    expect(canonicalLookupQuery('bangalore')).toBe('bengaluru');
    expect(canonicalLookupQuery('Bombay')).toBe('mumbai');
    expect(canonicalLookupQuery('Delhi')).toBe('Delhi');
    expect(canonicalLookupQuery('NDLS')).toBe('NDLS');
  });

  it('specific "Mumbai Central" / "BCT" is kept', () => {
    const stations = [S('CSTM', 'MUMBAI CST'), S('BCT', 'MUMBAI CENTRAL')];
    expect(stationFromLookup('Mumbai Central', stations).station?.code).toBe('BCT');
    expect(stationFromLookup('BCT', stations).station?.code).toBe('BCT');
  });

  it('BCT and MMCT collapse to one Mumbai Central (prefer MMCT)', () => {
    const stations = [
      S('CSTM', 'MUMBAI CST'),
      S('BCT', 'MUMBAI CENTRAL'),
      S('MMCT', 'MUMBAI CENTRAL'),
    ];
    expect(stationFromLookup('Mumbai Central', stations).station?.code).toBe('MMCT');
    expect(stationFromLookup('mumbai', stations).choiceNeeded?.map((s) => s.code).sort()).toEqual(['CSTM', 'MMCT']);
  });

  it('city field from provider groups Anand Vihar with Delhi — no name hardcode', () => {
    const result = stationFromLookup('delhi', [
      S('NDLS', 'New Delhi', { city: 'Delhi' }),
      S('ANVT', 'Anand Vihar Terminal', { city: 'Delhi' }),
    ]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.map((s) => s.code).sort()).toEqual(['ANVT', 'NDLS']);
  });

  it('genuine ambiguity (different bases, no signals) still asks — never guesses', () => {
    const result = stationFromLookup('harid', [S('HW', 'HARIDWAR JN'), S('HDS', 'HARIDASPUR')]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.length).toBe(2);
  });
});

describe('conversation: full name-based journey resolves without blocking', () => {
  it('"Mujhe Ludhiana se Haridwar jaana hai" → both stations filled, asks only the date', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Ludhiana se Haridwar jaana hai');

    expect(turn.context.origin?.code).toBe('LDH');  // "Ludhiana Jn" via junction-suffix
    expect(turn.context.destination?.code).toBe('HW'); // "Haridwar" single result
    expect(turn.reply).toMatch(/kis date/i);          // journey continues — NO station question
  });
});
