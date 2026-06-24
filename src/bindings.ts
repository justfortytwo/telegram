// Binding store: persists (channelType, channelUserId) -> owner.
//
// DESIGN DECISION (cross-repo reconciliation point): the telegram adapter must
// NOT assume the @justfortytwo/memory sqlite db exists. Authorization is the
// channel's own concern and must work even when memory is absent. So this file
// defines:
//   1. `BindingStore` — an injectable interface (the seam). Anyone can supply a
//      memory-backed implementation later without changing the login flow.
//   2. `SqliteBindingStore` — a small SELF-OWNED better-sqlite3 store (its own
//      tiny db file, default ./telegram-bindings.db) used by default.
//   3. `MemoryBindingStore` — an in-process Map store for tests / ephemeral use.
//
// If/when fortytwo standardizes a shared identity table, swap the default
// for a memory-backed BindingStore — the login flow is unaffected.

import { createRequire } from 'node:module';
import type DatabaseT from 'better-sqlite3';

export type ChannelType = 'telegram' | string;

export interface Binding {
  channelType: ChannelType;
  channelUserId: string;   // e.g. Telegram chat id, stringified
  owner: string;           // logical owner/actor this channel id maps to
  boundAt: string;         // ISO timestamp
}

/**
 * A pending pairing challenge. Persisted in the store (not in adapter memory) so
 * a code minted in one process (e.g. `fortytwo pair`) is redeemable in another
 * (the running bridge).
 */
export interface PendingChallenge {
  code: string;
  owner: string;
  expiresAt: number; // epoch ms
}

/** The seam. Persists channel-id -> owner bindings + pending challenges; everything else injects this. */
export interface BindingStore {
  get(channelType: ChannelType, channelUserId: string): Binding | null;
  put(binding: Binding): void;
  remove(channelType: ChannelType, channelUserId: string): void;
  list(channelType?: ChannelType): Binding[];
  /** Persist a pending pairing challenge so any process sharing the store can redeem it. */
  putChallenge(challenge: PendingChallenge): void;
  /** Fetch + CONSUME a challenge by code (single-use); null if absent or expired. */
  takeChallenge(code: string, now: number): PendingChallenge | null;
  /** Drop expired challenges. */
  sweepChallenges(now: number): void;
}

/** In-memory store — ideal for tests and ephemeral deployments. */
export class MemoryBindingStore implements BindingStore {
  private readonly map = new Map<string, Binding>();
  private readonly challenges = new Map<string, PendingChallenge>();
  private key(t: ChannelType, u: string): string { return `${t} ${u}`; }

  get(channelType: ChannelType, channelUserId: string): Binding | null {
    return this.map.get(this.key(channelType, channelUserId)) ?? null;
  }
  put(binding: Binding): void {
    this.map.set(this.key(binding.channelType, binding.channelUserId), binding);
  }
  remove(channelType: ChannelType, channelUserId: string): void {
    this.map.delete(this.key(channelType, channelUserId));
  }
  list(channelType?: ChannelType): Binding[] {
    const all = [...this.map.values()];
    return channelType ? all.filter((b) => b.channelType === channelType) : all;
  }

  putChallenge(challenge: PendingChallenge): void {
    this.challenges.set(challenge.code, challenge);
  }
  takeChallenge(code: string, now: number): PendingChallenge | null {
    const c = this.challenges.get(code);
    if (!c) return null;
    this.challenges.delete(code); // single-use: consume regardless of expiry
    return c.expiresAt > now ? c : null;
  }
  sweepChallenges(now: number): void {
    for (const [code, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(code);
  }
}

// Load the native sqlite driver via createRequire so this ESM module can pull a
// CommonJS addon without a top-level static import (which would force the native
// dependency on type-only consumers).
const nodeRequire = createRequire(import.meta.url);

/**
 * Self-owned sqlite-backed binding store. Uses its own small db file so it does
 * NOT depend on the memory package's schema or db existence. Lazily creates the
 * table on construction.
 */
export class SqliteBindingStore implements BindingStore {
  private readonly db: DatabaseT.Database;

  constructor(dbPath = 'telegram-bindings.db') {
    const Database = nodeRequire('better-sqlite3') as typeof DatabaseT;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_bindings (
        channel_type    TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        owner           TEXT NOT NULL,
        bound_at        TEXT NOT NULL,
        PRIMARY KEY (channel_type, channel_user_id)
      );
      CREATE TABLE IF NOT EXISTS pending_challenges (
        code       TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  get(channelType: ChannelType, channelUserId: string): Binding | null {
    const row = this.db
      .prepare('SELECT channel_type, channel_user_id, owner, bound_at FROM channel_bindings WHERE channel_type = ? AND channel_user_id = ?')
      .get(channelType, channelUserId) as
        | { channel_type: string; channel_user_id: string; owner: string; bound_at: string }
        | undefined;
    return row ? { channelType: row.channel_type, channelUserId: row.channel_user_id, owner: row.owner, boundAt: row.bound_at } : null;
  }

  put(binding: Binding): void {
    this.db
      .prepare(`
        INSERT INTO channel_bindings (channel_type, channel_user_id, owner, bound_at)
        VALUES (@channelType, @channelUserId, @owner, @boundAt)
        ON CONFLICT(channel_type, channel_user_id)
        DO UPDATE SET owner = excluded.owner, bound_at = excluded.bound_at
      `)
      .run(binding);
  }

  remove(channelType: ChannelType, channelUserId: string): void {
    this.db
      .prepare('DELETE FROM channel_bindings WHERE channel_type = ? AND channel_user_id = ?')
      .run(channelType, channelUserId);
  }

  list(channelType?: ChannelType): Binding[] {
    const rows = (channelType
      ? this.db.prepare('SELECT channel_type, channel_user_id, owner, bound_at FROM channel_bindings WHERE channel_type = ?').all(channelType)
      : this.db.prepare('SELECT channel_type, channel_user_id, owner, bound_at FROM channel_bindings').all()) as Array<{
        channel_type: string; channel_user_id: string; owner: string; bound_at: string;
      }>;
    return rows.map((r) => ({ channelType: r.channel_type, channelUserId: r.channel_user_id, owner: r.owner, boundAt: r.bound_at }));
  }

  putChallenge(challenge: PendingChallenge): void {
    this.db
      .prepare(`
        INSERT INTO pending_challenges (code, owner, expires_at)
        VALUES (@code, @owner, @expiresAt)
        ON CONFLICT(code) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      `)
      .run(challenge);
  }

  takeChallenge(code: string, now: number): PendingChallenge | null {
    // Fetch + delete in one transaction so a code is single-use even under a race.
    const consume = this.db.transaction((c: string): { code: string; owner: string; expires_at: number } | undefined => {
      const row = this.db.prepare('SELECT code, owner, expires_at FROM pending_challenges WHERE code = ?').get(c) as
        | { code: string; owner: string; expires_at: number }
        | undefined;
      this.db.prepare('DELETE FROM pending_challenges WHERE code = ?').run(c);
      return row;
    });
    const row = consume(code);
    if (!row) return null;
    return row.expires_at > now ? { code: row.code, owner: row.owner, expiresAt: row.expires_at } : null;
  }

  sweepChallenges(now: number): void {
    this.db.prepare('DELETE FROM pending_challenges WHERE expires_at <= ?').run(now);
  }
}
