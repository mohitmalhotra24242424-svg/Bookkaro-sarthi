/** Wallet contracts. Interfaces only — NO implementation in Step 1. */

export type WalletActor = 'AI' | 'USER' | 'SERVER';

export interface Wallet {
  id: string;
  userId: string;
  /** Integer paise. Never a float. */
  balanceMinor: number;
  currency: 'INR';
  /** Optimistic-concurrency version for deterministic ledger writes. */
  ledgerVersion: number;
  updatedAt: string;
}

export type WalletTransactionType = 'CREDIT' | 'DEBIT' | 'REFUND';

export type WalletTransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

export interface WalletTransaction {
  id: string;
  walletId: string;
  type: WalletTransactionType;
  amountMinor: number;
  status: WalletTransactionStatus;
  /** All money mutations MUST carry a unique idempotency key. */
  idempotencyKey: string;
  reason: string | null;
  relatedBookingId: string | null;
  balanceAfterMinor: number | null;
  createdAt: string;
}

export interface WalletReadSnapshot {
  wallet: Wallet;
  recentTransactions: readonly WalletTransaction[];
}

export interface WalletMutationCommand {
  actor: WalletActor;
  userId: string;
  amountMinor: number;
  idempotencyKey: string;
  reason: string | null;
  relatedBookingId: string | null;
}
