/**
 * Conversation store — survives process restarts / instances via a durable
 * backend, with graceful fallbacks that never 500.
 *
 * WHY DURABLE: conversation memory must be available across turns AND across
 * process restarts / instances, so the AI can answer a follow-up about an
 * earlier question instead of treating every message as a brand-new chat. The
 * transcript (and all journey slots) live in `ConversationContext`, which we
 * serialize into SQLite keyed by `conversationId`.
 *
 * BACKENDS (chosen by `createDefaultConversationStore`, in priority order):
 *
 *   1. HOSTED SQLite-over-network  — `@libsql/client` (Turso/libSQL). Durable
 *      across instances AND restarts on any host (Render free tier included,
 *      where the filesystem is ephemeral). Configured with
 *      `CONVERSATION_DB_URL` + `CONVERSATION_DB_AUTH_TOKEN` (or the Turso-native
 *      `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`). This is the primary store.
 *   2. LOCAL sql.js (WASM) file — a real SQLite engine compiled to WebAssembly,
 *      no native addon to compile, persisted to a file. Used when no hosted URL
 *      is configured. Good for single long-running hosts with a persistent disk.
 *   3. IN-MEMORY — last resort, single process only. Never 500s.
 *
 * All three expose the same async `ConversationStore` interface.
 *
 * PRIVACY/SAFETY: the stored context contains only the user↔assistant transcript
 * and journey state — no API keys, no secrets, no raw money movements.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { createClient } from '@libsql/client';
import type { Client, ResultSet } from '@libsql/client';
import { createConversationContext } from '../shared/index.js';
import type { ConversationContext } from '../shared/index.js';

const MAX_CONVERSATIONS = 5_000;

export interface ConversationStore {
  getOrCreate(conversationId: string | null, userId: string): Promise<ConversationContext>;
  save(context: ConversationContext): Promise<void>;
}

/** Create a fresh conversation context, honouring an explicit id when given. */
function newContext(userId: string, id: string | null): ConversationContext {
  const created = createConversationContext({ userId });
  return id && id.trim().length > 0 ? { ...created, id: id.trim() } : created;
}

/** Trim + bound an optional conversationId; returns null when empty. */
function normalizeId(conversationId: string | null | undefined): string | null {
  if (typeof conversationId !== 'string') return null;
  const trimmed = conversationId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Normalise a row's context payload back into a ConversationContext. */
function hydrateContext(raw: unknown, id: string, userId: string): ConversationContext | null {
  try {
    const parsed = JSON.parse(String(raw)) as ConversationContext;
    if (!parsed || parsed.id !== id) return null;
    return {
      ...parsed,
      userId,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. IN-MEMORY (fallback)
// ─────────────────────────────────────────────────────────────────────────────
export function createInMemoryConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationContext>();

  return {
    async getOrCreate(conversationId, userId) {
      const id = normalizeId(conversationId);
      if (id) {
        const existing = conversations.get(id);
        if (existing && existing.userId === userId) return existing;
      }
      const created = newContext(userId, id);
      conversations.set(created.id, created);
      if (conversations.size > MAX_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest !== undefined) conversations.delete(oldest);
      }
      return created;
    },
    async save(context) {
      conversations.set(context.id, context);
    },
  };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOCAL sql.js (WASM) — synchronous engine, async surface
// ─────────────────────────────────────────────────────────────────────────────
/** Walk up from this module to the project root (where package.json lives). */
function findProjectRoot(): string {
  let dir = new URL('.', import.meta.url).pathname;
  for (let i = 0; i < 8; i += 1) {
    try {
      if (existsSync(join(dir, 'package.json'))) return dir;
    } catch {
      // ignore — keep walking
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/** Path to the SQLite file. Prefer the env override, else a writable location. */
export function resolveConversationDbPath(): string {
  if (process.env.CONVERSATION_DB_PATH && process.env.CONVERSATION_DB_PATH.trim().length > 0) {
    return process.env.CONVERSATION_DB_PATH.trim();
  }
  // A project-relative `.data/` dir persists on a host with a persistent disk.
  return join(findProjectRoot(), '.data', 'bookkro-conversations.db');
}

export interface SqliteConversationStoreOptions {
  /** Absolute path to the SQLite file. Defaults to resolveConversationDbPath(). */
  dbPath?: string;
}

// The SQL.js engine is a real SQLite compiled to WebAssembly (no native addon to
// compile). Its init is async (WASM load), so we load it LAZILY on first use —
// there is no top-level await, which also lets this module bundle cleanly under
// Vercel's `@vercel/node` CJS build (top-level await is unsupported in CJS).
let sqlJsLoaded: SqlJsStatic | null | undefined;
async function loadSqlJs(): Promise<SqlJsStatic | null> {
  if (sqlJsLoaded !== undefined) return sqlJsLoaded;
  try {
    sqlJsLoaded = await initSqlJs();
  } catch {
    sqlJsLoaded = null;
  }
  return sqlJsLoaded;
}

/** Open (or create) the on-disk SQLite DB as a sql.js Database. Null on failure. */
async function openLocalDb(dbPath: string): Promise<Database | null> {
  const SQL = await loadSqlJs();
  if (!SQL) return null;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // read-only FS — the open below will fail and we degrade
  }
  let db: Database;
  try {
    db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  } catch {
    db = new SQL.Database();
  }
  try {
    db.run(SCHEMA);
    return db;
  } catch {
    return null;
  }
}

function selectLocal(db: Database, id: string, userId: string): ConversationContext | null {
  try {
    const stmt = db.prepare('SELECT context_json FROM conversations WHERE id = ? AND user_id = ?');
    stmt.bind([id, userId]);
    const hasRow = stmt.step();
    const row = hasRow ? (stmt.getAsObject() as { context_json: string }) : null;
    stmt.free();
    if (!row) return null;
    return hydrateContext(row.context_json, id, userId);
  } catch {
    return null;
  }
}

function pruneLocal(db: Database): void {
  try {
    const stmt = db.prepare('SELECT COUNT(*) AS c FROM conversations');
    stmt.bind([]);
    const hasRow = stmt.step();
    const count = hasRow ? (stmt.getAsObject() as { c: number }).c : 0;
    stmt.free();
    if (count > MAX_CONVERSATIONS) {
      db.run(
        'DELETE FROM conversations WHERE id IN (SELECT id FROM conversations ORDER BY updated_at ASC LIMIT ?)',
        [count - MAX_CONVERSATIONS],
      );
    }
  } catch {
    // pruning is best-effort
  }
}

export function createSqliteConversationStore(options: SqliteConversationStoreOptions = {}): ConversationStore {
  const fallback = createInMemoryConversationStore();
  const dbPath = options.dbPath ?? resolveConversationDbPath();
  let db: Database | null = null;
  let opening = false;

  const getDb = async (): Promise<Database | null> => {
    if (db) return db;
    if (opening) return null; // concurrent open → degrade to in-memory for this call
    opening = true;
    try {
      db = await openLocalDb(dbPath);
    } finally {
      opening = false;
    }
    return db;
  };

  const persist = (live: Database): void => {
    try {
      writeFileSync(dbPath, Buffer.from(live.export()));
    } catch {
      // read-only FS — degrade gracefully (still works for this process)
    }
  };

  return {
    async getOrCreate(conversationId, userId) {
      const live = await getDb();
      if (!live) return await fallback.getOrCreate(conversationId, userId);

      const id = normalizeId(conversationId);
      if (id) {
        const existing = selectLocal(live, id, userId);
        if (existing) return existing;
      }
      const created = newContext(userId, id);
      try {
        live.run(
          'INSERT OR IGNORE INTO conversations (id, user_id, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [created.id, userId, JSON.stringify(created), created.createdAt, created.updatedAt],
        );
        pruneLocal(live);
        persist(live);
      } catch {
        return await fallback.getOrCreate(conversationId, userId);
      }
      return created;
    },
    async save(context) {
      const live = await getDb();
      if (!live) {
        await fallback.save(context);
        return;
      }
      const now = new Date().toISOString();
      try {
        live.run(
          `INSERT INTO conversations (id, user_id, context_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id,
             context_json = excluded.context_json,
             updated_at = excluded.updated_at`,
          [context.id, context.userId, JSON.stringify(context), context.createdAt, now],
        );
        pruneLocal(live);
        persist(live);
      } catch {
        await fallback.save(context);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HOSTED libSQL (Turso / any libSQL endpoint) — durable across instances
// ─────────────────────────────────────────────────────────────────────────────
export interface HostedConversationStoreOptions {
  /** libSQL URL (e.g. libsql://<db>.turso.io). Defaults to CONVERSATION_DB_URL / TURSO_DATABASE_URL. */
  url?: string;
  /** Auth token. Defaults to CONVERSATION_DB_AUTH_TOKEN / TURSO_AUTH_TOKEN. */
  authToken?: string;
}

async function ensureHostedSchema(client: Client): Promise<void> {
  try {
    await client.execute(SCHEMA);
  } catch {
    // best-effort; individual queries still fail-safe
  }
}

async function pruneHosted(client: Client): Promise<void> {
  try {
    const rs: ResultSet = await client.execute('SELECT COUNT(*) AS c FROM conversations');
    const count = Number(rs.rows[0]?.c ?? 0);
    if (count > MAX_CONVERSATIONS) {
      await client.execute({
        sql: 'DELETE FROM conversations WHERE id IN (SELECT id FROM conversations ORDER BY updated_at ASC LIMIT ?)',
        args: [count - MAX_CONVERSATIONS],
      });
    }
  } catch {
    // pruning is best-effort
  }
}

export function createHostedConversationStore(options: HostedConversationStoreOptions = {}): ConversationStore {
  const url = options.url ?? process.env.CONVERSATION_DB_URL ?? process.env.TURSO_DATABASE_URL ?? '';
  const authToken = options.authToken ?? process.env.CONVERSATION_DB_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
  if (!url) return createSqliteConversationStore(); // graceful local fallback

  const fallback = createInMemoryConversationStore();
  let client: Client;
  try {
    client = createClient({ url, authToken: authToken || undefined });
  } catch {
    return createSqliteConversationStore();
  }

  let schemaReady: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (!schemaReady) schemaReady = ensureHostedSchema(client);
    return schemaReady;
  };

  return {
    async getOrCreate(conversationId, userId) {
      await ensure();
      const id = normalizeId(conversationId);
      if (id) {
        try {
          const rs = await client.execute({
            sql: 'SELECT context_json FROM conversations WHERE id = ? AND user_id = ?',
            args: [id, userId],
          });
          if (rs.rows.length > 0 && rs.rows[0]) {
            const existing = hydrateContext(rs.rows[0].context_json, id, userId);
            if (existing) return existing;
          }
        } catch {
          // read error → recreate below (never crash on bad data)
        }
      }
      const created = newContext(userId, id);
      try {
        await client.execute({
          sql: 'INSERT OR IGNORE INTO conversations (id, user_id, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          args: [created.id, userId, JSON.stringify(created), created.createdAt, created.updatedAt],
        });
        await pruneHosted(client);
      } catch {
        // bad write → surface the in-memory copy so the turn still completes
        return await fallback.getOrCreate(conversationId, userId);
      }
      return created;
    },
    async save(context) {
      await ensure();
      const now = new Date().toISOString();
      try {
        await client.execute({
          sql: `INSERT INTO conversations (id, user_id, context_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  user_id = excluded.user_id,
                  context_json = excluded.context_json,
                  updated_at = excluded.updated_at`,
          args: [context.id, context.userId, JSON.stringify(context), context.createdAt, now],
        });
        await pruneHosted(client);
      } catch {
        await fallback.save(context);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT: hosted if configured, else local sql.js, else in-memory.
// ─────────────────────────────────────────────────────────────────────────────
export function createDefaultConversationStore(): ConversationStore {
  return createHostedConversationStore();
}
