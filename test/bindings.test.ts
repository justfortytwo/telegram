import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBindingStore } from '../src/bindings.js';

let dir: string;
let db: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-bind-')); db = join(dir, 'b.db'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('SqliteBindingStore challenge persistence (cross-process)', () => {
  it('a challenge persisted by one instance is redeemed by another, single-use', () => {
    new SqliteBindingStore(db).putChallenge({ code: '424242', owner: 'owner', expiresAt: 1_000_000 });
    // A separate instance == a separate process (the bridge) reading the shared file.
    expect(new SqliteBindingStore(db).takeChallenge('424242', 999_999)?.owner).toBe('owner');
    expect(new SqliteBindingStore(db).takeChallenge('424242', 999_999)).toBeNull(); // already consumed
  });

  it('does not return an expired challenge', () => {
    const s = new SqliteBindingStore(db);
    s.putChallenge({ code: '111111', owner: 'owner', expiresAt: 1000 });
    expect(s.takeChallenge('111111', 2000)).toBeNull(); // now (2000) > expiresAt (1000)
  });

  it('bindings still persist across instances (regression)', () => {
    new SqliteBindingStore(db).put({ channelType: 'telegram', channelUserId: '42', owner: 'owner', boundAt: 'now' });
    expect(new SqliteBindingStore(db).get('telegram', '42')?.owner).toBe('owner');
  });
});
