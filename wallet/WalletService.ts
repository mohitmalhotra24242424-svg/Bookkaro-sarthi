/**
 * WALLET SERVICE — INTERFACES ONLY (NOT IMPLEMENTED in Step 1).
 *
 * The Step 1 implementation is deliberately inert: every method rejects with
 * NotImplementedError, so it is impossible to debit, credit or refund any
 * money in this codebase until the deterministic ledger is built in a later
 * step. The AI layer never imports or calls this service directly.
 */

import { NotImplementedError } from '../shared/index.js';
import type { Wallet, WalletMutationCommand, WalletReadSnapshot, WalletTransaction } from '../shared/index.js';

export interface WalletService {
  getWallet(userId: string): Promise<Wallet>;
  listTransactions(userId: string, limit?: number): Promise<WalletTransaction[]>;
  /** Deterministic, idempotent credit — SERVER-side only, fully validated. */
  credit(command: WalletMutationCommand): Promise<WalletTransaction>;
  /** Deterministic, idempotent debit — SERVER-side only, never overdrawn. */
  debit(command: WalletMutationCommand): Promise<WalletTransaction>;
}

export class NotImplementedWalletService implements WalletService {
  private reject(method: string): Promise<never> {
    return Promise.reject(
      new NotImplementedError(
        `Wallet ${method} is NOT IMPLEMENTED in Step 1 — no money can move in this codebase yet.`,
      ),
    );
  }

  getWallet(): Promise<never> {
    return this.reject('getWallet');
  }

  listTransactions(): Promise<never> {
    return this.reject('listTransactions');
  }

  credit(): Promise<never> {
    return this.reject('credit');
  }

  debit(): Promise<never> {
    return this.reject('debit');
  }
}

export function createWalletService(): WalletService {
  return new NotImplementedWalletService();
}

export type { Wallet, WalletMutationCommand, WalletReadSnapshot, WalletTransaction };
