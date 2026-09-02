/** Wallet operation vocabulary (re-exports shared wallet types for convenience). */

export type WalletOperationT = 'READ_BALANCE' | 'READ_TRANSACTIONS' | 'CREDIT' | 'DEBIT' | 'REFUND';

export type {
  Wallet,
  WalletActor,
  WalletMutationCommand,
  WalletReadSnapshot,
  WalletTransaction,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../shared/index.js';
