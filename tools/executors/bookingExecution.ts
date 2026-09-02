/**
 * DETERMINISTIC MOCK BOOKING EXECUTION (Step 5 §16-18).
 *
 * Path: recorded explicit confirmation → verified fare → server-side wallet
 * check → DEMO ledger debit → MOCK booking record (id "MOCK-…", pnr ALWAYS
 * null, isDemo true). No real ticket. No real payment. No PNR — real-looking
 * or otherwise. Failures are returned honestly and NEVER as success.
 */

import { newId } from '../../shared/index.js';
import type { Booking, BookingDraft, ToolResult } from '../../shared/index.js';
import type { WalletService } from '../../wallet/index.js';
import { totalPayableMinor } from '../../shared/serviceFee.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolSuccess } from '../results.js';
import type { BookingDraftStore } from './draftStore.js';

export interface BookingStore {
  record(booking: Booking): void;
  forUser(userId: string): Booking[];
}

export function createInMemoryBookingStore(): BookingStore {
  const bookings: Booking[] = [];
  return {
    record(booking) {
      bookings.push(booking);
    },
    forUser(userId) {
      return bookings.filter((booking) => booking.userId === userId).map((entry) => ({ ...entry }));
    },
  };
}

function callOf(context: ToolExecutionContext, tool: string): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool };
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function createMockBookingExecutors(
  draftStore: BookingDraftStore,
  wallet: WalletService,
  bookingStore: BookingStore,
): Record<string, ToolExecutor> {
  return {
    executeMockBooking: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'executeMockBooking');
      const draftId = stringInput(input, 'draftId');
      if (!draftId) return toolFailure(call, 'INVALID_INPUT', 'draftId is required.');
      const draft = draftStore.get(draftId);
      if (!draft) return toolFailure(call, 'NOT_FOUND', 'Draft not found.');

      // 1. Explicit confirmation MUST have been recorded (§14).
      if (!draft.confirmation || draft.confirmation.method !== 'EXPLICIT_USER_ACTION') {
        return toolFailure(call, 'CONFIRMATION_MISSING', 'No explicit user confirmation recorded — refusing to book.');
      }

      // 2. Verified provider fare MUST exist (§8 — never invented).
      const fare = draft.fareQuote;
      if (!fare || fare.breakdown.totalMinor === null || fare.breakdown.totalMinor <= 0) {
        return toolFailure(call, 'FARE_NOT_VERIFIED', 'No verified provider fare on the draft — refusing to book.');
      }

      const totalMinor = totalPayableMinor(fare.breakdown.totalMinor);
      const expectedTotal = typeof input.expectedTotalMinor === 'number' ? input.expectedTotalMinor : null;
      if (expectedTotal !== null && expectedTotal !== totalMinor) {
        return toolFailure(call, 'TOTAL_MISMATCH', 'The reviewed total does not match the draft — please review again.');
      }

      // 3. Deterministic server-side wallet check + DEMO debit (§19) — the AI never decides.
      let balance = 0;
      try {
        const walletSnapshot = await wallet.getWallet(draft.userId);
        balance = walletSnapshot.balanceMinor;
        if (balance < totalMinor) {
          return toolFailure(
            call,
            'INSUFFICIENT_BALANCE',
            `Wallet balance insufficient: ₹${(balance / 100).toFixed(2)} available, ₹${(totalMinor / 100).toFixed(2)} needed (demo ledger).`,
          );
        }
        await wallet.debit({
          actor: 'SERVER',
          userId: draft.userId,
          amountMinor: totalMinor,
          idempotencyKey: `mock-booking:${draft.id}`,
          reason: 'DEMO booking (mock)',
          relatedBookingId: draftId,
        });
      } catch (error) {
        return toolFailure(call, 'WALLET_ERROR', `Booking complete nahi ho paayi: ${error instanceof Error ? error.message : 'wallet error'}`);
      }

      // 4. MOCK booking record — clearly DEMO, pnr ALWAYS null (§17).
      const booking: Booking = {
        id: `MOCK-${newId().slice(0, 8).toUpperCase()}`,
        draftId: draft.id,
        userId: draft.userId,
        pnr: null,
        trainNumber: draft.trainNumber,
        journeyDate: draft.journeyDate,
        status: 'CONFIRMED',
        totalChargedMinor: totalMinor,
        currency: 'INR',
        providerSource: null,
        isDemo: true,
        createdAt: new Date().toISOString(),
      };
      bookingStore.record(booking);
      draftStore.update(draft.id, { stage: 'BOOKING_RESULT', status: 'EXECUTED' } as Partial<BookingDraft>);
      return toolSuccess(call, booking);
    },

    getBookings: async (_input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getBookings');
      const userId = ctx.userId ?? '';
      const bookings = bookingStore.forUser(userId);
      return toolSuccess(call, bookings);
    },
  };
}
