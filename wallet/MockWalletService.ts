/**
 * DETERMINISTIC DEMO WALLET (Step 5 §19) — an in-memory ledger used ONLY by the
 * mock booking boundary. Real money does not exist in this system.
 *
 * Safety (unchanged from Step 1):
 *  - every mutation runs authorizeWalletOperation + validateDebit/validateCredit
 *    (SERVER actor, idempotency key, positive integer paise, no overdraft);
 *  - the AI layer never touches this service — only deterministic tool executors do;
 *  - balances are DEMO values seeded per server process, never invented by the AI.
 */

import { newId } from '../shared/index.js';
import type { Wallet, WalletMutationCommand, WalletReadSnapshot, WalletTransaction } from '../shared/index.js';
import { authorizeWalletOperation, validateCredit, validateDebit } from './guards.js';
import type { WalletService } from './WalletService.js';

export interface MockWalletOptions {
  /** Seed balance per user, in paise. Default ₹5,000 (500_000) — clearly a demo value. */
  seedBalanceMinor?: number;
}

export class MockWalletService implements WalletService {
  private readonly seedBalanceMinor: number;
  private readonly wallets = new Map<string, Wallet>();
  private readonly transactions = new Map<string, WalletTransaction[]>();
  private readonly idempotencyKeys = new Set<string>();

  constructor(options: MockWalletOptions = {}) {
    this.seedBalanceMinor = options.seedBalanceMinor ?? 500_000;
  }

  private walletFor(userId: string): Wallet {
    let wallet = this.wallets.get(userId);
    if (!wallet) {
      wallet = {
        id: newId('wallet'),
        userId,
        balanceMinor: this.seedBalanceMinor,
        currency: 'INR',
        ledgerVersion: 0,
        updatedAt: new Date().toISOString(),
      };
      this.wallets.set(userId, wallet);
    }
    return wallet;
  }

  async getWallet(userId: string): Promise<Wallet> {
    return { ...this.walletFor(userId) };
  }

  async listTransactions(userId: string, limit = 10): Promise<WalletTransaction[]> {
    return (this.transactions.get(userId) ?? []).slice(-limit).map((entry) => ({ ...entry }));
  }

  async getWalletSnapshot(userId: string): Promise<WalletReadSnapshot> {
    const wallet = await this.getWallet(userId);
    const recentTransactions = await this.listTransactions(userId, 5);
    return { wallet, recentTransactions };
  }

  private async mutate(command: WalletMutationCommand, kind: 'DEBIT' | 'CREDIT'): Promise<WalletTransaction> {
    const authorization = authorizeWalletOperation(command.actor, kind);
    if (!authorization.allowed) {
      throw new Error(authorization.reason ?? 'wallet operation not allowed');
    }
    if (this.idempotencyKeys.has(command.idempotencyKey)) {
      const existing = (this.transactions.get(command.userId) ?? []).find(
        (entry) => entry.idempotencyKey === command.idempotencyKey,
      );
      if (existing) return { ...existing };
    }
    const wallet = this.walletFor(command.userId);
    const validation = kind === 'DEBIT' ? validateDebit(wallet, command) : validateCredit(wallet, command);
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }
    const balanceAfterMinor = kind === 'DEBIT' ? wallet.balanceMinor - command.amountMinor : wallet.balanceMinor + command.amountMinor;
    wallet.balanceMinor = balanceAfterMinor;
    wallet.ledgerVersion += 1;
    wallet.updatedAt = new Date().toISOString();
    const transaction: WalletTransaction = {
      id: newId('wltx'),
      walletId: wallet.id,
      type: kind,
      amountMinor: command.amountMinor,
      status: 'COMPLETED',
      idempotencyKey: command.idempotencyKey,
      reason: command.reason,
      relatedBookingId: command.relatedBookingId,
      balanceAfterMinor,
      createdAt: new Date().toISOString(),
    };
    this.idempotencyKeys.add(command.idempotencyKey);
    this.transactions.set(command.userId, [...(this.transactions.get(command.userId) ?? []), transaction]);
    return { ...transaction };
  }

  async credit(command: WalletMutationCommand): Promise<WalletTransaction> {
    return this.mutate(command, 'CREDIT');
  }

  async debit(command: WalletMutationCommand): Promise<WalletTransaction> {
    return this.mutate(command, 'DEBIT');
  }
}

export function createMockWalletService(options?: MockWalletOptions): WalletService {
  return new MockWalletService(options);
}
