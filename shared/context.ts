/**
 * ConversationContext operations — pure, immutable functions.
 *
 * Multi-turn memory: `setContextSlots(ctx, slots, 'FILL_MISSING')` fills ONLY
 * empty slots, so "Mujhe Amritsar se Ludhiana jaana hai" followed by "Kal"
 * preserves Amritsar + Ludhiana and fills just the date.
 *
 * Interrupt/resume: `savePausedBooking` snapshots an in-flight booking when
 * the user interrupts; `restorePausedBooking` brings it back later.
 */

import { ValidationError } from './errors.js';
import { newId } from './ids.js';
import type {
  ConversationContext,
  ConversationMessage,
  ConversationRole,
  ContextCorrection,
  ContextSlotField,
  PausedBookingSnapshot,
  PausedBookingSlots,
} from './types/core.js';
import type { Intent } from './types/intent.js';
import type { TrainSearchResult } from './types/railway.js';
import type { ToolName } from './types/tools.js';
import { isBookingStage } from './types/booking.js';

/** Journey slots fillable via setContextSlots (passenger detail fields are handled by the orchestrator). */
export type JourneySlotField = 'origin' | 'destination' | 'journeyDate' | 'passengerCount' | 'selectedTrain' | 'selectedClass';
const SLOT_KEYS: readonly JourneySlotField[] = [
  'origin',
  'destination',
  'journeyDate',
  'passengerCount',
  'selectedTrain',
  'selectedClass',
];

export type ContextSlots = Partial<PausedBookingSlots>;

export type SlotFillMode = 'FILL_MISSING' | 'CORRECT';

export interface CreateConversationContextInput {
  userId: string;
  id?: string;
  now?: string;
}

export function createConversationContext(input: CreateConversationContextInput): ConversationContext {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? newId('conv'),
    userId: input.userId,
    origin: null,
    destination: null,
    journeyDate: null,
    passengerCount: null,
    selectedTrain: null,
    selectedClass: null,
    selectedQuota: null,
    lastSearchResults: null,
    lastAskedField: null,
    bookingStage: 'IDLE',
    lastIntent: null,
    lastTool: null,
    pendingQuestion: null,
    userCorrections: [],
    pausedBooking: null,
    stationChoices: null,
    pendingSemanticPlan: null,
    pendingStationResolution: null,
    passengers: [],
    passengerDraft: null,
    lastAvailability: null,
    lastFareQuote: null,
    lastToolResult: null,
    lastReferencedTrain: null,
    pendingFastestHint: false,
    pendingDataRoute: null,
    pendingSearchFilter: null,
    waitlistAccepted: false,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** A name-only station placeholder: has a name but its code is empty/unresolved. */
function isStationPlaceholder(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const code = record['code'];
  const name = record['name'];
  // A Station with an empty code and a non-empty name is an unresolved placeholder.
  return typeof name === 'string' && name.trim().length > 0 && (code === '' || code === undefined || code === null);
}

/**
 * Fill journey slots.
 * - 'FILL_MISSING': only empty slots are filled — existing memory is preserved
 *   across turns (multi-turn slot filling).
 * - 'CORRECT': overwrite existing values AND record an audit entry in
 *   `userCorrections` (e.g. user says "nahi, Jalandhar se").
 */
export function setContextSlots(
  context: ConversationContext,
  slots: ContextSlots,
  mode: SlotFillMode,
  now: string = new Date().toISOString(),
): ConversationContext {
  const corrections: ContextCorrection[] = [...context.userCorrections];
  const next: ConversationContext = { ...context, updatedAt: now };

  for (const key of SLOT_KEYS) {
    const value = slots[key];
    if (value === undefined) continue;

    const current = context[key] as unknown;
    if (current === null || current === undefined) {
      (next as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (!valuesDiffer(current, value)) continue;
    // A name-only STATION PLACEHOLDER (code empty, name set) is unresolved — it is
    // NOT real knowledge. FILL_MISSING may overwrite it with the verified station
    // (e.g. "Ludhiana se Delhi kal" → origin is ambiguous → destination stored as
    // {code:'', name:'Delhi'}; when the destination choice later resolves, the
    // placeholder must be replaced). Verified stations (code present) are still
    // protected under FILL_MISSING.
    const currentIsStationPlaceholder = isStationPlaceholder(current);
    if (mode === 'FILL_MISSING' && !currentIsStationPlaceholder) continue; // preserve what we already know

    corrections.push({ field: key, previousValue: current, newValue: value, correctedAt: now });
    (next as unknown as Record<string, unknown>)[key] = value;
  }

  next.userCorrections = corrections;
  return next;
}

export interface ConversationMetaPatch {
  lastIntent?: Intent | null;
  lastTool?: ToolName | null;
  lastAskedField?: ContextSlotField | null;
  pendingQuestion?: string | null;
  bookingStage?: ConversationContext['bookingStage'];
}

export function updateConversationMeta(
  context: ConversationContext,
  patch: ConversationMetaPatch,
  now: string = new Date().toISOString(),
): ConversationContext {
  if (patch.bookingStage !== undefined && !isBookingStage(patch.bookingStage)) {
    throw new ValidationError(`Unknown booking stage: ${String(patch.bookingStage)}`);
  }
  return { ...context, ...patch, updatedAt: now };
}

export function setSearchResults(
  context: ConversationContext,
  results: readonly TrainSearchResult[],
  now: string = new Date().toISOString(),
): ConversationContext {
  return { ...context, lastSearchResults: results, updatedAt: now };
}

export interface AddMessageInput {
  role: ConversationRole;
  content: string;
  intent?: Intent | null;
  toolName?: ToolName | null;
}

export function addConversationMessage(
  context: ConversationContext,
  message: AddMessageInput,
  now: string = new Date().toISOString(),
): ConversationContext {
  const entry: ConversationMessage = {
    id: newId('msg'),
    role: message.role,
    content: message.content,
    createdAt: now,
    intent: message.intent ?? null,
    toolName: message.toolName ?? null,
  };
  return { ...context, messages: [...context.messages, entry], updatedAt: now };
}

/**
 * Interrupt/resume foundation: snapshot the current booking flow before the
 * conversation is diverted (e.g. a live-status question mid-booking).
 */
export function savePausedBooking(
  context: ConversationContext,
  reason: PausedBookingSnapshot['reason'],
  now: string = new Date().toISOString(),
): ConversationContext {
  if (context.pausedBooking) {
    throw new ValidationError('A paused booking snapshot already exists — restore it first.');
  }
  const snapshot: PausedBookingSnapshot = {
    pausedAtStage: context.bookingStage,
    pausedAt: now,
    reason,
    slots: {
      origin: context.origin,
      destination: context.destination,
      journeyDate: context.journeyDate,
      passengerCount: context.passengerCount,
      selectedTrain: context.selectedTrain,
      selectedClass: context.selectedClass,
    },
    lastSearchResults: context.lastSearchResults,
    pendingQuestion: context.pendingQuestion,
  };
  return { ...context, pausedBooking: snapshot, updatedAt: now };
}

/** Restore a previously paused booking so the flow can resume where it left off. */
export function restorePausedBooking(
  context: ConversationContext,
  now: string = new Date().toISOString(),
): ConversationContext {
  if (!context.pausedBooking) {
    throw new ValidationError('No paused booking to restore.');
  }
  const snapshot = context.pausedBooking;
  return {
    ...context,
    origin: snapshot.slots.origin,
    destination: snapshot.slots.destination,
    journeyDate: snapshot.slots.journeyDate,
    passengerCount: snapshot.slots.passengerCount,
    selectedTrain: snapshot.slots.selectedTrain,
    selectedClass: snapshot.slots.selectedClass,
    lastSearchResults: snapshot.lastSearchResults,
    pendingQuestion: snapshot.pendingQuestion,
    bookingStage: snapshot.pausedAtStage,
    pausedBooking: null,
    updatedAt: now,
  };
}
