/**
 * WALLET SAFETY GUARDS.
 *
 * Rules:
 *   - The AI may only READ (balance / transactions). It can never debit,
 *     credit or refund — authorizeWalletOperation enforces this at the type
 *     system AND at runtime.
 *   - Users never mutate the ledger directly either; they act through booking
 *     flows executed by deterministic server code.
 *   - Every server-side mutation must pass deterministic validation
 *     (positive integer amount, idempotency key, sufficient balance).
 */

import type { Wallet, WalletActor, WalletMutationCommand, WalletOperationT } from './types.js';

export const WALLET_SAFETY_RULES: readonly string[] = [
  'The AI layer can READ the wallet but can NEVER debit, credit or refund.',
  'All money mutations run in deterministic server-side code only.',
  'Every mutation carries a unique idempotency key (retries never double-charge).',
  'Amounts are positive integers in paise; balance may never go negative.',
  'Users act through booking flows; no direct user-side ledger writes.',
];

export interface WalletAuthorization {
  allowed: boolean;
  reason?: string;
}

export function authorizeWalletOperation(actor: WalletActor, operation: WalletOperationT): WalletAuthorization {
  if (actor === 'AI') {
    if (operation === 'READ_BALANCE' || operation === 'READ_TRANSACTIONS') return { allowed: true };
    return { allowed: false, reason: 'AI_CANNOT_MOVE_MONEY — the AI may only read wallet state.' };
  }
  if (actor === 'USER') {
    return { allowed: false, reason: 'USER_CANNOT_MUTATE_LEDGER — users act via server-executed flows.' };
  }
  return { allowed: true }; // SERVER — still subject to deterministic validation below
}

export interface WalletCommandValidation {
  ok: boolean;
  errors: string[];
}

export function validateWalletMutation(wallet: Wallet, command: WalletMutationCommand): WalletCommandValidation {
  const errors: string[] = [];
  if (command.actor !== 'SERVER') errors.push('mutating commands must originate from SERVER code');
  if (!Number.isInteger(command.amountMinor) || command.amountMinor <= 0) {
    errors.push('amountMinor must be a positive integer (paise)');
  }
  if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim().length === 0) {
    errors.push('idempotencyKey is required');
  }
  if (command.relatedBookingId !== null && typeof command.relatedBookingId !== 'string') {
    errors.push('relatedBookingId must be a string or null');
  }
  if (command.reason !== null && typeof command.reason !== 'string') {
    errors.push('reason must be a string or null');
  }
  if (wallet.currency !== 'INR') errors.push('only INR wallets are supported');
  return { ok: errors.length === 0, errors };
}

export function validateDebit(wallet: Wallet, command: WalletMutationCommand): WalletCommandValidation {
  const base = validateWalletMutation(wallet, command);
  const errors = [...base.errors];
  if (Number.isInteger(command.amountMinor) && command.amountMinor > wallet.balanceMinor) {
    errors.push('insufficient balance — debit would overdraw the wallet');
  }
  return { ok: errors.length === 0, errors };
}

export function validateCredit(wallet: Wallet, command: WalletMutationCommand): WalletCommandValidation {
  return validateWalletMutation(wallet, command);
}
