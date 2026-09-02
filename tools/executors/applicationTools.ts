/**
 * APPLICATION TOOL EXECUTORS (bookings, wallet, booking DRAFTS).
 *
 * Safety: nothing here can move money or finalize a booking.
 *  - getBookings: honest — no booking executor exists, so no user has bookings.
 *  - getWallet: honest unavailable (wallet ledger is not implemented).
 *  - createBookingDraft / reviewFare: data-only booking flow.
 *  - confirmBooking: deliberately NOT here — no executor exists for it.
 */

import { isZeroResult } from '../../shared/index.js';
import type { Booking, BookingDraft, ToolResult, TravelClassCode } from '../../shared/index.js';
import type { RailwayProviderRouter } from '../../railway/index.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolSuccess, toolUnavailable } from '../results.js';
import type { BookingDraftStore } from './draftStore.js';

function callOf(context: ToolExecutionContext, tool: string): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool };
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function intInput(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function createApplicationToolExecutors(draftStore: BookingDraftStore, router?: RailwayProviderRouter): Record<string, ToolExecutor> {
  return {
    getBookings: async (_input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getBookings');
      // Booking execution does not exist yet, so a user's booking list is genuinely empty.
      const bookings: Booking[] = [];
      return toolSuccess(call, bookings);
    },

    getWallet: async (_input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getWallet');
      // Honest unavailable — the wallet ledger is not implemented in this step.
      return toolUnavailable(call, 'NO_DATA', 'The wallet system is not implemented yet — balance is unavailable.');
    },

    createBookingDraft: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'createBookingDraft');
      if (!ctx.conversationId || !ctx.userId) {
        return toolFailure(call, 'TOOL_CONTEXT_MISSING', 'Draft creation requires a signed-in conversation.');
      }
      const draft = draftStore.create({ conversationId: ctx.conversationId, userId: ctx.userId });
      let updated: BookingDraft =
        draftStore.update(draft.id, {
          originCode: stringInput(input, 'originCode')?.toUpperCase() ?? null,
          destinationCode: stringInput(input, 'destinationCode')?.toUpperCase() ?? null,
          journeyDate: stringInput(input, 'journeyDate'),
          trainNumber: stringInput(input, 'trainNumber'),
          travelClass: (stringInput(input, 'travelClass')?.toUpperCase() as TravelClassCode | undefined) ?? null,
          passengerCount: intInput(input, 'passengerCount'),
          stage: 'CLASS_SELECTED',
          status: 'OPEN',
        }) ?? draft;

      // Attach a VERIFIED provider fare quote when the route is known — fares are
      // never invented. Unavailable fare keeps the draft honest (no review yet).
      if (router && updated.originCode && updated.destinationCode && updated.trainNumber) {
        const fareResult = await router.fare({
          trainNumber: updated.trainNumber,
          fromStationCode: updated.originCode,
          toStationCode: updated.destinationCode,
          journeyDate: updated.journeyDate,
          travelClass: updated.travelClass,
          quota: 'GN',
        });
        if (fareResult.ok && fareResult.data !== null && !isZeroResult(fareResult)) {
          updated = draftStore.update(draft.id, { fareQuote: fareResult.data, stage: 'FARE_REVIEW', status: 'AWAITING_CONFIRMATION' }) ?? updated;
        }
      }
      return toolSuccess(call, updated);
    },

    acknowledgeBookingConfirmation: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'acknowledgeBookingConfirmation');
      const draftId = stringInput(input, 'draftId');
      if (!draftId) return toolFailure(call, 'INVALID_INPUT', 'draftId is required.');
      const draft = draftStore.get(draftId);
      if (!draft) return toolFailure(call, 'NOT_FOUND', 'Draft not found.');
      if (draft.status !== 'AWAITING_CONFIRMATION' || draft.stage !== 'FARE_REVIEW') {
        return toolFailure(call, 'NOT_AWAITING_CONFIRMATION', 'No complete fare review is pending for this draft — confirmation is not accepted.');
      }
      if (!draft.fareQuote || draft.fareQuote.breakdown.totalMinor === null) {
        return toolFailure(call, 'FARE_NOT_VERIFIED', 'Refusing to record confirmation without a verified provider fare.');
      }
      const confirmed = draftStore.update(draftId, {
        confirmation: {
          method: 'EXPLICIT_USER_ACTION',
          confirmedByUserId: ctx.userId ?? draft.userId,
          confirmedAt: new Date().toISOString(),
          utterance: stringInput(input, 'utterance'),
        },
      }) ?? draft;
      // NOTE: this records the user's YES only. Booking execution does NOT exist.
      return toolSuccess(call, confirmed);
    },

    reviewFare: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'reviewFare');
      const draftId = stringInput(input, 'draftId');
      if (!draftId) return toolFailure(call, 'INVALID_INPUT', 'draftId is required.');
      const draft = draftStore.get(draftId);
      if (!draft) return toolFailure(call, 'NOT_FOUND', 'Draft not found — it may have expired.');
      // The actual fare quote is fetched by the orchestrator through the fare
      // tool (provider data); this executor only attaches provider-verified
      // quotes handed in via the railway layer — never an invented number.
      return toolUnavailable(call, 'NOT_IMPLEMENTED', 'Fare review is attached by the orchestrator via the provider fare tool.');
    },
  };
}

