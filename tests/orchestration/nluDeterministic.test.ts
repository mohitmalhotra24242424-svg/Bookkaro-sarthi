/**
 * Deterministic NLU: intent + entity detection battery (MOCK).
 * The deterministic NLU is the default provider and the AI-failure fallback.
 */

import { describe, expect, it } from 'vitest';
import { DeterministicNLUProvider } from '../../ai/providers/DeterministicNLUProvider.js';
import { INTENTS } from '../../shared/index.js';
import { freshContext, makeSearchResults } from './harness.js';

const provider = new DeterministicNLUProvider();

async function understand(message: string, context = freshContext()) {
  return provider.understand({ userMessage: message, conversation: context, availableIntents: INTENTS, availableTools: [] });
}

describe('deterministic NLU: intent detection', () => {
  it('live status variations', async () => {
    for (const message of ['12014 ka live status batao', '12014 abhi kaha hai', '12014 live status']) {
      const result = await understand(message);
      expect(result.intent, message).toBe('LIVE_TRAIN_STATUS');
      expect(result.slots.trainNumber, message).toBe('12014');
    }
  });

  it('availability vs fare discrimination', async () => {
    expect((await understand('12014 mein seat hai?')).intent).toBe('GET_AVAILABILITY');
    expect((await understand('Is train mein kitni seats hain?')).intent).toBe('GET_AVAILABILITY'); // selectedTrain from context
    expect((await understand('CC mein kitna fare hai?')).intent).toBe('GET_FARE');
    expect((await understand('12014 ka fare kitna hai')).intent).toBe('GET_FARE');
  });

  it('timetable / train info / bookings / wallet / cancelled / pnr / station lookup', async () => {
    expect((await understand('12014 ka timetable batao')).intent).toBe('GET_TIMETABLE');
    expect((await understand('12014 ke baare mein batao')).intent).toBe('GET_TRAIN_INFO');
    expect((await understand('meri last tickets dikhao')).intent).toBe('VIEW_BOOKINGS');
    expect((await understand('meri ticket history dikhao')).intent).toBe('VIEW_BOOKINGS');
    expect((await understand('wallet ka balance dikhao')).intent).toBe('VIEW_WALLET');
    expect((await understand('aaj ki cancelled trains batao')).intent).toBe('GET_CANCELLED_TRAINS');
    expect((await understand('PNR 1234567890 check karo')).intent).toBe('CHECK_PNR');
    expect((await understand('Ludhiana ka station code kya hai?')).intent).toBe('LOOKUP_STATION');
  });

  it('journey phrasing → BOOK_TRAIN with stations and missing date', async () => {
    const result = await understand('Mujhe Amritsar se Ludhiana jaana hai');
    expect(result.intent).toBe('BOOK_TRAIN');
    expect(result.slots.originQuery).toBe('Amritsar');
    expect(result.slots.destinationQuery).toBe('Ludhiana');
    expect(result.missingFields).toContain('journeyDate');
  });

  it('relative dates stay RAW (server resolves them deterministically)', async () => {
    expect((await understand('Mujhe Amritsar se Ludhiana jaana hai')).slots.dateText).toBeNull();
    expect((await understand('aaj')).slots.dateText).toBe('aaj');
    expect((await understand('kal jaana hai')).slots.dateText).toBe('kal');
    expect((await understand('parso jaana hai')).slots.dateText).toBe('parso');
    expect((await understand('2026-09-01 ko jaana hai')).slots.dateText).toBe('2026-09-01');
  });

  it('passenger counts (digits and Hindi number words)', async () => {
    expect((await understand('2 ticket chahiye')).slots.passengerCount).toBe(2);
    expect((await understand('do ticket chahiye')).slots.passengerCount).toBe(2);
    expect((await understand('teen passengers hain')).slots.passengerCount).toBe(3);
  });

  it('comparison extracts both train numbers', async () => {
    const result = await understand('12014 aur 14542 mein kaunsi better hai?');
    expect(result.intent).toBe('COMPARE_TRAINS');
    expect(result.slots.trainNumber).toBe('12014');
    expect(result.slots.secondTrainNumber).toBe('14542');
  });

  it('glossary questions detected as GENERAL_RAILWAY_QUERY', async () => {
    for (const message of ['CC kya hota hai?', 'SL kya hota hai?', 'RAC kya hota hai?', 'WL kya hota hai?']) {
      const result = await understand(message);
      expect(result.intent, message).toBe('GENERAL_RAILWAY_QUERY');
      expect(result.slots.glossaryTerm, message).toBeTruthy();
    }
  });

  it('live data question is NOT a glossary question (train number wins)', async () => {
    const result = await understand('12014 mein CC available hai?');
    expect(result.intent).toBe('GET_AVAILABILITY');
    expect(result.intent).not.toBe('GENERAL_RAILWAY_QUERY');
  });

  it('corrections flagged with stations mentioned', async () => {
    const correction = await understand('Nahi, Ludhiana se jaana hai');
    expect(correction.slots.isCorrection).toBe(true);
    expect(correction.slots.originQuery).toBe('Ludhiana');

    const destinationCorrection = await understand('Delhi nahi, Chandigarh');
    expect(destinationCorrection.slots.isCorrection).toBe(true);
    expect(destinationCorrection.slots.mentionedStations).toEqual(['Delhi', 'Chandigarh']);
  });

  it('result references: pehli / doosri / numbered / last / upar', async () => {
    const context = freshContext();
    const withResults = { ...context, lastSearchResults: makeSearchResults() };
    expect((await understand('pehli wali', withResults)).slots.resultReference).toBe('1');
    expect((await understand('doosri wali', withResults)).slots.resultReference).toBe('2');
    expect((await understand('12014 wali', withResults)).slots.resultReference).toBe('12014');
    expect((await understand('last wali', withResults)).slots.resultReference).toBe('last');
    expect((await understand('upar wali', withResults)).slots.resultReference).toBe('1');
  });

  it('selectedTrain from context backs "is train" questions', async () => {
    const context = freshContext();
    const withTrain = {
      ...context,
      selectedTrain: makeSearchResults()[0]!.train,
    };
    const result = await understand('is train ka live status batao', withTrain);
    expect(result.intent).toBe('LIVE_TRAIN_STATUS');
    expect(result.slots.trainNumber).toBe('12014');
  });
});
