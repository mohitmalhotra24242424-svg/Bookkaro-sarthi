/**
 * CONVERSATION MEMORY STORE — SQLite durability + in-memory fallback.
 *
 * Proves the conversation context (with its transcript) survives a save→reopen
 * round-trip, and that the in-memory store still works standalone.
 * No network, no real credentials; temp file only.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  createInMemoryConversationStore,
  createSqliteConversationStore,
  createHostedConversationStore,
} from '../api/conversations.js';
import { addConversationMessage } from '../shared/index.js';

const tmpDbs: string[] = [];

function tempDbPath(): string {
  const p = join(tmpdir(), `bookkro-conv-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  tmpDbs.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpDbs.splice(0)) {
    try {
      rmSync(p, { force: true });
      rmSync(`${p}-wal`, { force: true });
      rmSync(`${p}-shm`, { force: true });
      rmSync(`${p}-journal`, { force: true });
    } catch {
      // ignore
    }
  }
});

describe('ConversationStore', () => {
  it('in-memory store creates + returns the same context for the same conversationId+userId', async () => {
    const store = createInMemoryConversationStore();
    const a = await store.getOrCreate('conv-1', 'user-1');
    const a2 = await store.getOrCreate('conv-1', 'user-1');
    expect(a2.id).toBe(a.id);
    expect(a2).toBe(a); // same stored object → real memory
    // different userId → fresh, isolated context (same id, separate user row)
    const b = await store.getOrCreate('conv-1', 'user-2');
    expect(b.id).toBe(a.id);
    expect(b).not.toBe(a);
    expect(b.journeyDate).toBeNull();
  });

  it('SQLite store persists messages across a save→reopen round-trip (durable memory)', async () => {
    const dbPath = tempDbPath();
    const store1 = createSqliteConversationStore({ dbPath });
    const ctx = await store1.getOrCreate('conv-42', 'user-9');
    const withMsg = addConversationMessage(
      { ...ctx, origin: { code: 'ASR', name: 'Amritsar Jn', zone: null, state: 'PB', latitude: null, longitude: null } as never,
        destination: { code: 'LDH', name: 'Ludhiana Jn', zone: null, state: 'PB', latitude: null, longitude: null } as never,
        journeyDate: '2026-08-27', selectedClass: '3A' as never },
      { role: 'user', content: 'amritsar se ludhiana kal subah ki train', intent: 'BOOK_TRAIN' },
      '2026-08-26T10:00:00.000Z',
    );
    await store1.save(withMsg);

    // Fresh store instance on the SAME file → memory must have survived.
    const store2 = createSqliteConversationStore({ dbPath });
    const reload = await store2.getOrCreate('conv-42', 'user-9');
    expect(reload.id).toBe('conv-42');
    expect(reload.origin?.code).toBe('ASR');
    expect(reload.destination?.code).toBe('LDH');
    expect(reload.journeyDate).toBe('2026-08-27');
    expect(reload.selectedClass).toBe('3A');
    // The transcript survived too.
    expect(reload.messages.some((m) => m.content.includes('amritsar se ludhiana'))).toBe(true);
  });

  it('SQLite store does not leak into a different userId (keyed per user)', async () => {
    const dbPath = tempDbPath();
    const store = createSqliteConversationStore({ dbPath });
    const a = await store.getOrCreate('conv-shared', 'user-1');
    a.journeyDate = '2026-08-27';
    await store.save(a);
    const b = await store.getOrCreate('conv-shared', 'user-2');
    expect(b.journeyDate).toBeNull(); // isolated — not the same user's data
  });

  it('hosted libSQL store (file: URL) persists + isolates across a fresh store instance', async () => {
    const dbPath = join(tmpdir(), `bookkro-hosted-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
    tmpDbs.push(dbPath);
    const url = `file:${dbPath}`;

    const store1 = createHostedConversationStore({ url });
    const ctx = await store1.getOrCreate('host-1', 'u-5');
    ctx.journeyDate = '2026-09-05';
    await store1.save(ctx);

    // A brand new client/store on the SAME underlying db → memory survives (restart).
    const store2 = createHostedConversationStore({ url });
    const reload = await store2.getOrCreate('host-1', 'u-5');
    expect(reload.journeyDate).toBe('2026-09-05');

    // Isolation across userId.
    const other = await store2.getOrCreate('host-1', 'u-6');
    expect(other.journeyDate).toBeNull();
  });
});
