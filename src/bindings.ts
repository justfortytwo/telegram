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
// If/when justfortytwo standardizes a shared identity table, swap the default
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

/** The seam. Persists channel-id -> owner bindings; everything else injects this. */
export interface BindingStore {
  get(channelType: ChannelType, channelUserId: string): Binding | null;
  put(binding: Binding): void;
  remove(channelType: ChannelType, channelUserId: string): void;
  list(channelType?: ChannelType): Binding[];
}

/** In-memory store — ideal for tests and ephemeral deployments. */
export class MemoryBindingStore implements BindingStore {
  private readonly map = new Map<string, Binding>();
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
}
