import { describe, expect, it } from 'vitest';
import {
  NotImplementedWalletService,
  WALLET_SAFETY_RULES,
  authorizeWalletOperation,
  createWalletService,
  validateCredit,
  validateDebit,
} from '../wallet/index.js';
import type { WalletService } from '../wallet/index.js';
import { NotImplementedError } from '../shared/index.js';
import type { Wallet, WalletMutationCommand } from '../shared/index.js';

const WALLET: Wallet = {
  id: 'wallet-1',
  userId: 'user-1',
  balanceMinor: 50000, // ₹500.00
  currency: 'INR',
  ledgerVersion: 7,
  updatedAt: '2026-08-26T00:00:00.000Z',
};

function command(overrides: Partial<WalletMutationCommand> = {}): WalletMutationCommand {
  return {
    actor: 'SERVER',
    userId: 'user-1',
    amountMinor: 10000,
    idempotencyKey: 'idem-001',
    reason: 'booking payment',
    relatedBookingId: 'booking-1',
    ...overrides,
  };
}

describe('wallet authorization: AI can read, never move money', () => {
  it('AI may read balance and transactions', () => {
    expect(authorizeWalletOperation('AI', 'READ_BALANCE').allowed).toBe(true);
    expect(authorizeWalletOperation('AI', 'READ_TRANSACTIONS').allowed).toBe(true);
  });

  it('AI is denied for every money-moving operation', () => {
    expect(authorizeWalletOperation('AI', 'DEBIT').allowed).toBe(false);
    expect(authorizeWalletOperation('AI', 'CREDIT').allowed).toBe(false);
    expect(authorizeWalletOperation('AI', 'REFUND').allowed).toBe(false);
    expect(authorizeWalletOperation('AI', 'DEBIT').reason).toMatch(/AI_CANNOT_MOVE_MONEY/);
  });

  it('users cannot mutate the ledger directly (flows execute server-side)', () => {
    expect(authorizeWalletOperation('USER', 'DEBIT').allowed).toBe(false);
    expect(authorizeWalletOperation('USER', 'CREDIT').allowed).toBe(false);
    expect(authorizeWalletOperation('USER', 'READ_BALANCE').allowed).toBe(false);
  });

  it('server operations are authorized but still validated deterministically', () => {
    expect(authorizeWalletOperation('SERVER', 'DEBIT').allowed).toBe(true);
    expect(authorizeWalletOperation('SERVER', 'CREDIT').allowed).toBe(true);
  });

  it('documents its safety rules', () => {
    expect(WALLET_SAFETY_RULES.length).toBeGreaterThanOrEqual(5);
    expect(WALLET_SAFETY_RULES.join(' ')).toMatch(/never/i);
  });
});

describe('deterministic mutation validation', () => {
  it('accepts a well-formed server debit within balance', () => {
    expect(validateDebit(WALLET, command()).ok).toBe(true);
  });

  it('rejects overdrawn debits', () => {
    const decision = validateDebit(WALLET, command({ amountMinor: 50001 }));
    expect(decision.ok).toBe(false);
    expect(decision.errors.join(' ')).toMatch(/insufficient balance/);
  });

  it('rejects zero, negative, non-integer and float amounts', () => {
    expect(validateDebit(WALLET, command({ amountMinor: 0 })).ok).toBe(false);
    expect(validateDebit(WALLET, command({ amountMinor: -100 })).ok).toBe(false);
    expect(validateDebit(WALLET, command({ amountMinor: 100.5 })).ok).toBe(false);
  });

  it('requires an idempotency key (retries never double-charge)', () => {
    const decision = validateDebit(WALLET, command({ idempotencyKey: '' }));
    expect(decision.ok).toBe(false);
    expect(decision.errors.join(' ')).toMatch(/idempotencyKey/);
  });

  it('rejects mutations whose claimed actor is not SERVER', () => {
    const aiDebit = validateDebit(WALLET, command({ actor: 'AI' }));
    expect(aiDebit.ok).toBe(false);
    expect(aiDebit.errors.join(' ')).toMatch(/SERVER/);
  });

  it('credits validate without a balance check', () => {
    expect(validateCredit(WALLET, command({ amountMinor: 999999 })).ok).toBe(true);
    expect(validateCredit(WALLET, command({ amountMinor: 0 })).ok).toBe(false);
  });
});

describe('Step 1 wallet implementation is deliberately inert', () => {
  it('no method can move or even read money — everything rejects NOT_IMPLEMENTED', async () => {
    const service = createWalletService();
    expect(service).toBeInstanceOf(NotImplementedWalletService);

    await expect(service.getWallet('user-1')).rejects.toThrowError(NotImplementedError);
    await expect(service.listTransactions('user-1')).rejects.toThrowError(NotImplementedError);
    await expect(service.credit(command())).rejects.toThrowError(NotImplementedError);
    await expect(service.debit(command())).rejects.toThrowError(/NOT IMPLEMENTED/);
  });

  it('there is no code path that debits a wallet in Step 1', async () => {
    const service: WalletService = new NotImplementedWalletService();
    const attempt = service.debit(command());
    await expect(attempt).rejects.toBeInstanceOf(NotImplementedError);
  });
});
