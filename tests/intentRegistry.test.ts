import { describe, expect, it } from 'vitest';
import {
  INTENT_REGISTRY,
  INTENTS,
  getIntentDefinition,
  intentsThatSuggestTool,
  isKnownIntent,
  suggestedToolsForIntent,
} from '../shared/index.js';
import { createDefaultToolRegistry } from '../tools/index.js';

const EXPECTED_INTENTS = [
  'NORMAL_CHAT',
  'BOOK_TRAIN',
  'SEARCH_TRAIN',
  'LIVE_TRAIN_STATUS',
  'GET_AVAILABILITY',
  'GET_FARE',
  'GET_TRAIN_INFO',
  'GET_TIMETABLE',
  'LOOKUP_STATION',
  'CHECK_PNR',
  'VIEW_BOOKINGS',
  'VIEW_WALLET',
  'GET_CANCELLED_TRAINS',
  'COMPARE_TRAINS',
  'GENERAL_RAILWAY_QUERY',
  'HELP',
  'UNKNOWN',
];

describe('intent registry', () => {
  it('contains exactly the 16 specified intents', () => {
    expect([...INTENTS].sort()).toEqual([...EXPECTED_INTENTS].sort());
  });

  it('every intent has a complete, useful definition', () => {
    for (const intent of INTENTS) {
      const definition = INTENT_REGISTRY[intent];
      expect(definition, intent).toBeDefined();
      expect(definition.title.length, intent).toBeGreaterThan(0);
      expect(definition.description.length, intent).toBeGreaterThan(10);
      expect(definition.examplePhrases.length, intent).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(definition.suggestedTools), intent).toBe(true);
    }
  });

  it('covers the flagship example phrases from the product brief', () => {
    const allPhrases = INTENTS.flatMap((intent) => INTENT_REGISTRY[intent].examplePhrases).join(' | ').toLowerCase();
    for (const phrase of ['amritsar', 'ludhiana', '12014', 'pnr', 'ticket history', 'cc kya hota hai', '14542']) {
      expect(allPhrases).toContain(phrase);
    }
  });

  it('isKnownIntent accepts registry keys and rejects everything else', () => {
    expect(isKnownIntent('BOOK_TRAIN')).toBe(true);
    expect(isKnownIntent('UNKNOWN')).toBe(true);
    expect(isKnownIntent('BOOK_FLIGHT')).toBe(false);
    expect(isKnownIntent(42)).toBe(false);
    expect(isKnownIntent(null)).toBe(false);
  });

  it('getIntentDefinition returns definitions or null', () => {
    expect(getIntentDefinition('HELP')?.title).toBeTruthy();
    expect(getIntentDefinition('BOOK_TRAIN')?.requiresExplicitConfirmation).toBe(true);
    expect(getIntentDefinition('SEARCH_TRAIN')?.requiresExplicitConfirmation).toBe(false);
  });

  it('every suggested tool actually exists in the tool registry (cross-consistency)', () => {
    const registry = createDefaultToolRegistry();
    for (const intent of INTENTS) {
      for (const tool of INTENT_REGISTRY[intent].suggestedTools) {
        expect(registry.has(tool), `${intent} → ${tool}`).toBe(true);
      }
    }
  });

  it('tool→intents reverse lookup works', () => {
    expect(intentsThatSuggestTool('checkPNR')).toContain('CHECK_PNR');
    expect(intentsThatSuggestTool('getLiveStatus')).toContain('LIVE_TRAIN_STATUS');
    expect(suggestedToolsForIntent('BOOK_TRAIN')).toContain('confirmBooking');
    expect(suggestedToolsForIntent('GENERAL_RAILWAY_QUERY')).toEqual([]);
  });
});
