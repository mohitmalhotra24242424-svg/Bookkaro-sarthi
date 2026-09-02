import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  addConversationMessage,
  createConversationContext,
  restorePausedBooking,
  savePausedBooking,
  setSearchResults,
  setContextSlots,
  updateConversationMeta,
} from '../shared/index.js';
import type { Station, Train, TrainSearchResult } from '../shared/index.js';

const T0 = '2026-08-26T10:00:00.000Z';
const T1 = '2026-08-26T10:00:01.000Z';
const T2 = '2026-08-26T10:00:02.000Z';
const T3 = '2026-08-26T10:00:03.000Z';
const T4 = '2026-08-26T10:00:04.000Z';

const ASR: Station = { code: 'ASR', name: 'Amritsar Jn', zone: 'NR', state: 'Punjab', latitude: null, longitude: null };
const LDH: Station = { code: 'LDH', name: 'Ludhiana Jn', zone: 'NR', state: 'Punjab', latitude: null, longitude: null };
const JUC: Station = { code: 'JUC', name: 'Jalandhar City', zone: 'NR', state: 'Punjab', latitude: null, longitude: null };
const DLI_STATION: Station = { code: 'DLI', name: 'DELHI', zone: 'NR', state: 'Delhi', latitude: null, longitude: null };
const NDLS_STATION: Station = { code: 'NDLS', name: 'NEW DELHI', zone: 'NR', state: 'Delhi', latitude: null, longitude: null };

const SHATABDI: Train = {
  number: '12014',
  name: 'Amritsar - New Delhi Shatabdi Express',
  originStation: ASR,
  destinationStation: null,
  departureTime: null,
  arrivalTime: null,
  runsOn: null,
  travelClasses: null,
  pantryCar: null,
};

const SEARCH: TrainSearchResult[] = [
  { train: SHATABDI, fromStation: ASR, toStation: LDH, departureTime: '05:00', arrivalTime: '06:55', durationMinutes: 115 },
];

describe('createConversationContext defaults', () => {
  it('starts with every required field empty/honest', () => {
    const ctx = createConversationContext({ userId: 'user-1', now: T0 });
    expect(ctx.userId).toBe('user-1');
    expect(ctx.origin).toBeNull();
    expect(ctx.destination).toBeNull();
    expect(ctx.journeyDate).toBeNull();
    expect(ctx.passengerCount).toBeNull();
    expect(ctx.selectedTrain).toBeNull();
    expect(ctx.selectedClass).toBeNull();
    expect(ctx.lastSearchResults).toBeNull();
    expect(ctx.lastAskedField).toBeNull();
    expect(ctx.bookingStage).toBe('IDLE');
    expect(ctx.lastIntent).toBeNull();
    expect(ctx.lastTool).toBeNull();
    expect(ctx.pendingQuestion).toBeNull();
    expect(ctx.userCorrections).toEqual([]);
    expect(ctx.pausedBooking).toBeNull();
    expect(ctx.messages).toEqual([]);
    expect(ctx.createdAt).toBe(T0);
    expect(ctx.updatedAt).toBe(T0);
  });
});

describe('multi-turn slot filling', () => {
  it('preserves Amritsar + Ludhiana across turns and fills only the date ("Kal")', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });

    // Turn 1: "Mujhe Amritsar se Ludhiana jaana hai"
    ctx = setContextSlots(ctx, { origin: ASR, destination: LDH }, 'FILL_MISSING', T1);
    // Turn 2: "Kal" — only the date arrives
    ctx = setContextSlots(ctx, { journeyDate: '2026-08-27', passengerCount: 2 }, 'FILL_MISSING', T2);

    expect(ctx.origin).toEqual(ASR);
    expect(ctx.destination).toEqual(LDH);
    expect(ctx.journeyDate).toBe('2026-08-27');
    expect(ctx.passengerCount).toBe(2);
    expect(ctx.userCorrections).toHaveLength(0);
    expect(ctx.updatedAt).toBe(T2);
  });

  it('FILL_MISSING never overwrites an existing slot', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { origin: ASR }, 'FILL_MISSING', T1);
    ctx = setContextSlots(ctx, { origin: JUC }, 'FILL_MISSING', T2);
    expect(ctx.origin).toEqual(ASR);
    expect(ctx.userCorrections).toHaveLength(0);
  });

  it('CORRECT mode overwrites and records an audit entry in userCorrections', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { origin: ASR, destination: LDH }, 'FILL_MISSING', T1);
    ctx = setContextSlots(ctx, { origin: JUC }, 'CORRECT', T2);

    expect(ctx.origin).toEqual(JUC);
    expect(ctx.userCorrections).toHaveLength(1);
    expect(ctx.userCorrections[0]?.field).toBe('origin');
    expect(ctx.userCorrections[0]?.previousValue).toEqual(ASR);
    expect(ctx.userCorrections[0]?.newValue).toEqual(JUC);
    expect(ctx.userCorrections[0]?.correctedAt).toBe(T2);
  });

  it('setting the same value twice is not a correction', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { origin: ASR }, 'FILL_MISSING', T1);
    ctx = setContextSlots(ctx, { origin: ASR }, 'CORRECT', T2);
    expect(ctx.userCorrections).toHaveLength(0);
  });

  it('FILL_MISSING overwrites a NAME-ONLY station placeholder with the verified station (city-choice bug fix)', () => {
    // "Ludhiana se Delhi kal" → origin is ambiguous (multi-station) → the system
    // stashes destination as an unresolved name-only placeholder before asking
    // about origin. When the destination choice later resolves, the placeholder
    // must be replaced — otherwise the user's pick (DLI) is dropped and it re-asks.
    const DELHI_PLACEHOLDER: Station = { code: '', name: 'Delhi', zone: null, state: null, latitude: null, longitude: null };
    const DLI: Station = { code: 'DLI', name: 'DELHI', zone: 'NR', state: 'Delhi', latitude: null, longitude: null };

    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { origin: LDH, destination: DELHI_PLACEHOLDER }, 'FILL_MISSING', T1);
    // User picks DLI → FILL_MISSING must replace the unresolved placeholder.
    ctx = setContextSlots(ctx, { destination: DLI }, 'FILL_MISSING', T2);

    expect(ctx.destination).toEqual(DLI);
    expect(ctx.origin).toEqual(LDH); // origin untouched
  });

  it('FILL_MISSING still protects a VERIFIED station (code present) from a later fill attempt', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { destination: DLI_STATION }, 'FILL_MISSING', T1);
    ctx = setContextSlots(ctx, { destination: NDLS_STATION }, 'FILL_MISSING', T2);
    expect(ctx.destination).toEqual(DLI_STATION);
    expect(ctx.userCorrections).toHaveLength(0);
  });
});

describe('conversation meta, messages and search results', () => {
  it('updates meta fields and validates the booking stage', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = updateConversationMeta(ctx, {
      lastIntent: 'BOOK_TRAIN',
      lastTool: 'searchTrains',
      lastAskedField: 'journeyDate',
      pendingQuestion: 'Kab jaana hai?',
      bookingStage: 'COLLECT_JOURNEY',
    }, T1);

    expect(ctx.lastIntent).toBe('BOOK_TRAIN');
    expect(ctx.lastTool).toBe('searchTrains');
    expect(ctx.lastAskedField).toBe('journeyDate');
    expect(ctx.pendingQuestion).toBe('Kab jaana hai?');
    expect(ctx.bookingStage).toBe('COLLECT_JOURNEY');

    expect(() => updateConversationMeta(ctx, { bookingStage: 'NOT_A_STAGE' as never }, T2)).toThrowError(ValidationError);
  });

  it('appends messages with role and intent metadata', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = addConversationMessage(ctx, { role: 'user', content: 'PNR check karo' }, T1);
    ctx = addConversationMessage(ctx, { role: 'assistant', content: 'PNR bataiye?', intent: 'CHECK_PNR' }, T2);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]?.role).toBe('user');
    expect(ctx.messages[1]?.intent).toBe('CHECK_PNR');
    expect(ctx.messages[1]?.id.startsWith('msg_')).toBe(true);
  });

  it('stores last search results for follow-up questions', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setSearchResults(ctx, SEARCH, T1);
    expect(ctx.lastSearchResults).toEqual(SEARCH);
  });
});

describe('interrupt/resume foundation', () => {
  it('pauses a booking, handles a side quest, and restores the original context', () => {
    let ctx = createConversationContext({ userId: 'user-1', now: T0 });
    ctx = setContextSlots(ctx, { origin: ASR, destination: LDH }, 'FILL_MISSING', T1);
    ctx = setSearchResults(ctx, SEARCH, T1);
    ctx = updateConversationMeta(ctx, { bookingStage: 'SEARCH_RESULTS', pendingQuestion: 'Kaunsi train?' }, T1);

    // User interrupts: "12014 ka live status batao"
    ctx = savePausedBooking(ctx, 'USER_INTERRUPTION', T2);
    expect(ctx.pausedBooking?.pausedAtStage).toBe('SEARCH_RESULTS');
    expect(ctx.pausedBooking?.reason).toBe('USER_INTERRUPTION');
    expect(ctx.pausedBooking?.slots.origin).toEqual(ASR);

    // Side quest mutates the live context
    ctx = updateConversationMeta(ctx, { bookingStage: 'IDLE', lastIntent: 'LIVE_TRAIN_STATUS', pendingQuestion: null }, T3);
    ctx = setContextSlots(ctx, { passengerCount: 5, selectedTrain: SHATABDI }, 'FILL_MISSING', T3);
    expect(ctx.lastIntent).toBe('LIVE_TRAIN_STATUS');
    expect(ctx.passengerCount).toBe(5);

    // "Kal jaana hai" → resume the original booking context
    ctx = restorePausedBooking(ctx, T4);
    expect(ctx.bookingStage).toBe('SEARCH_RESULTS');
    expect(ctx.origin).toEqual(ASR);
    expect(ctx.destination).toEqual(LDH);
    expect(ctx.passengerCount).toBeNull(); // side-quest value did not leak in
    expect(ctx.selectedTrain).toBeNull();
    expect(ctx.lastSearchResults).toEqual(SEARCH);
    expect(ctx.pendingQuestion).toBe('Kaunsi train?');
    expect(ctx.pausedBooking).toBeNull();
  });

  it('refuses double-pause and restore-without-pause', () => {
    const ctx = createConversationContext({ userId: 'user-1', now: T0 });
    expect(() => restorePausedBooking(ctx, T1)).toThrowError(ValidationError);

    const paused = savePausedBooking(ctx, 'USER_INTERRUPTION', T1);
    expect(() => savePausedBooking(paused, 'USER_INTERRUPTION', T2)).toThrowError(ValidationError);
  });
});
