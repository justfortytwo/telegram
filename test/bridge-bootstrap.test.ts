// Fresh-install bootstrap: no ALLOWED_CHAT_IDS and zero bindings.
//
// The bridge must start locked down in that state, drop every unbound sender,
// and let the first chat in only via `/login <code>` with a pending challenge
// minted by a separate process (the installer's `fortytwo pair`) in the shared
// bindings DB.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createRunner: vi.fn(), write: vi.fn() }));
vi.mock('@justfortytwo/runner', () => ({ createRunner: mocks.createRunner }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), writeFileSync: mocks.write }));
vi.mock('@justfortytwo/memory', () => ({
  openDb: () => ({ k: {} }), runMigrations: async () => {}, store: vi.fn(async () => 1),
  FakeEmbedder: class {}, enqueue: vi.fn(), existsPending: vi.fn(),
}));
import { noopConversationLog } from '../src/conversation-log.js';
import { createBridgeSessions, handleInbound, pairingOnlyStartupNotice, pollLoop } from '../src/bridge.js';
import { TelegramAdapter } from '../src/adapter.js';
import { SqliteBindingStore } from '../src/bindings.js';
import { isAuthorized, type AuthContext } from '../src/login.js';

class Session extends EventEmitter {
  state = 'ready'; sessionId?: string;
  send = vi.fn(async (_prompt: string) => {});
  close = vi.fn(async () => {});
}

const managers: ReturnType<typeof createBridgeSessions>[] = [];
const dirs: string[] = [];

function freshInstall(bootstrap: number[] = [], now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-bootstrap-')); dirs.push(dir);
  const dbPath = join(dir, 'telegram-bindings.db');
  const sessions: Session[] = [];
  const runner = { run: vi.fn(), createSession: vi.fn(async () => { const s = new Session(); sessions.push(s); return s; }) };
  mocks.createRunner.mockReturnValue(runner);
  const tg: any = { sendMessage: vi.fn(async () => ({ message_id: 77 })), editMessageText: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}), getUpdates: vi.fn() };
  const state = { sessions: {} as Record<number, string>, pending: {} as Record<number, any>, lastUpdateId: 0 };
  // The bridge's own store/adapter, exactly as main() builds them.
  const store = new SqliteBindingStore(dbPath);
  const auth: AuthContext = { adapter: new TelegramAdapter(store, now ? { now } : {}), bootstrap: new Set(bootstrap) };
  const manager = createBridgeSessions(tg, state, null, noopConversationLog); managers.push(manager);
  const inbound = (text: string, chatId = 5) => handleInbound(tg, auth, state, null, noopConversationLog, chatId, { message_id: 9, chat: { id: chatId }, text }, manager);
  // Separate store + adapter on the same file ~ the installer's `fortytwo pair` process.
  const pair = (opts: { ttlSeconds?: number; now?: () => number } = {}) =>
    new TelegramAdapter(new SqliteBindingStore(dbPath), opts).issueChallenge('owner').code;
  return { tg, state, auth, store, manager, sessions, runner, inbound, pair };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.closeAll()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('fresh-install bootstrap (no ALLOWED_CHAT_IDS, zero bindings)', () => {
  it('zero bindings + no ALLOWED_CHAT_IDS is not fatal: startup gets a notice, not an exit', () => {
    expect(pairingOnlyStartupNotice(0, 0)).toMatch(/locked down.*\/login/);
    expect(pairingOnlyStartupNotice(1, 0)).toBeNull();
    expect(pairingOnlyStartupNotice(0, 1)).toBeNull();
  });

  it('the bridge polls with an empty store and no pending challenge, dropping unbound traffic', async () => {
    const f = freshInstall(); const abort = new AbortController();
    expect(f.store.list('telegram')).toHaveLength(0);
    f.tg.getUpdates.mockResolvedValueOnce([{ update_id: 1, message: { message_id: 1, chat: { id: 5 }, text: 'hi' } }]);
    f.tg.getUpdates.mockImplementationOnce(async () => { abort.abort(); return []; });
    await pollLoop(f.tg, f.auth, f.state, null, noopConversationLog, f.manager, abort.signal);
    expect(f.state.lastUpdateId).toBe(1);
    expect(f.runner.createSession).not.toHaveBeenCalled();
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
  });

  it('an unbound normal message never reaches the runner and gets no reply', async () => {
    const f = freshInstall();
    f.pair(); // a pending challenge exists, but this chat has not redeemed it
    await f.inbound('hello claude');
    expect(f.runner.createSession).not.toHaveBeenCalled();
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
    expect(f.store.list('telegram')).toHaveLength(0);
  });

  it('a valid /login code minted by another process creates the binding and confirms', async () => {
    const f = freshInstall();
    const code = f.pair();
    await f.inbound(`/login ${code}`);
    expect(f.store.list('telegram')).toEqual([expect.objectContaining({ channelUserId: '5', owner: 'owner' })]);
    expect(isAuthorized(f.auth, 5)).toBe(true);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(5, expect.stringContaining('Paired. This chat is now bound to "owner"'));
    expect(f.runner.createSession).not.toHaveBeenCalled();
  });

  it('an invalid /login code creates no binding and stays silent', async () => {
    const f = freshInstall();
    f.pair();
    await f.inbound('/login NOT-A-CODE');
    expect(f.store.list('telegram')).toHaveLength(0);
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
    expect(f.runner.createSession).not.toHaveBeenCalled();
  });

  it('an expired /login code creates no binding and stays silent', async () => {
    let t = 1_000_000;
    const f = freshInstall([], () => t);
    const code = f.pair({ ttlSeconds: 60, now: () => t });
    t += 61_000;
    await f.inbound(`/login ${code}`);
    expect(f.store.list('telegram')).toHaveLength(0);
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
    expect(f.runner.createSession).not.toHaveBeenCalled();
  });

  it('after pairing, a normal message reaches the bound chat session', async () => {
    const f = freshInstall();
    await f.inbound(`/login ${f.pair()}`);
    await f.inbound('hello claude');
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0]!.send).toHaveBeenCalledWith('hello claude');
    // Another unbound chat is still locked out.
    await f.inbound('me too', 6);
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
  });

  it('ALLOWED_CHAT_IDS bootstrap still authorizes without a binding', async () => {
    const f = freshInstall([5]);
    await f.inbound('hello claude');
    expect(f.store.list('telegram')).toHaveLength(0);
    expect(f.sessions[0]!.send).toHaveBeenCalledWith('hello claude');
    await f.inbound('not allowed', 6);
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
  });
});
