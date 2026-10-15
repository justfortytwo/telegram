import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createRunner: vi.fn(), write: vi.fn(), store: vi.fn(async () => 1) }));
vi.mock('@justfortytwo/runner', () => ({ createRunner: mocks.createRunner }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), writeFileSync: mocks.write, mkdirSync: vi.fn() }));
vi.mock('@justfortytwo/memory', () => ({
  openDb: () => ({ k: {} }), runMigrations: async () => {}, store: mocks.store,
  FakeEmbedder: class {}, enqueue: vi.fn(), existsPending: vi.fn(),
}));
import { createBridgeSessions, handleInbound, handleCallback, pollLoop, ingestMessageAttachments, loadMemoryEngine } from '../src/bridge.js';
import { TelegramAdapter } from '../src/adapter.js';
import { MemoryBindingStore } from '../src/bindings.js';

class Session extends EventEmitter {
  state = 'ready'; sessionId?: string;
  send = vi.fn(async (_prompt: string) => {});
  close = vi.fn(async () => {});
  result(text: string, raw: unknown = {}) { this.emit('event', { type: 'result', result: { ok: true, text, raw }, raw }); }
}
const managers: ReturnType<typeof createBridgeSessions>[] = [];
function setup() {
  const sessions: Session[] = [];
  const runner = { run: vi.fn(), createSession: vi.fn(async () => { const session = new Session(); sessions.push(session); return session; }) };
  mocks.createRunner.mockReturnValue(runner);
  const tg: any = { sendMessage: vi.fn(async () => ({ message_id: 77 })), editMessageText: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}), getUpdates: vi.fn() };
  const state = { sessions: {} as Record<number, string>, pending: {} as Record<number, any>, lastUpdateId: 0 };
  const adapter = new TelegramAdapter(new MemoryBindingStore());
  const auth = { adapter, bootstrap: new Set([1]) };
  const manager = createBridgeSessions(tg, state, null, null); managers.push(manager);
  const inbound = (text: string, chatId = 1) => handleInbound(tg, auth, state, null, null, chatId, { message_id: 9, chat: { id: chatId }, text }, manager);
  const approve = () => handleCallback(tg, state, null, null, 1, 'cb', 'approve:t', 77, manager);
  return { tg, state, auth, manager, sessions, runner, inbound, approve };
}
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.closeAll())); });

describe('bridge dispatch', () => {
  it('polls and dispatches B before result A, including across getUpdates calls', async () => {
    const f = setup(); const abort = new AbortController();
    f.tg.getUpdates.mockResolvedValueOnce([{ update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: 'A' } }]);
    f.tg.getUpdates.mockResolvedValueOnce([{ update_id: 2, message: { message_id: 2, chat: { id: 1 }, text: 'B' } }]);
    f.tg.getUpdates.mockImplementationOnce(async () => { abort.abort(); return []; });
    await pollLoop(f.tg, f.auth, f.state, null, null, f.manager, abort.signal);
    expect(f.sessions[0].send.mock.calls).toEqual([['A'], ['B']]);
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.runner.run).not.toHaveBeenCalled();
  });
  it('keeps pairing, lockdown, local commands and logout out of Claude', async () => {
    const f = setup();
    await f.inbound('unknown', 2); expect(f.runner.createSession).not.toHaveBeenCalled();
    const challenge = f.auth.adapter.issueChallenge('owner');
    await f.inbound(`/login ${challenge.code}`, 2);
    await f.inbound('hello', 2);
    await f.inbound('/logout', 2);
    expect(f.sessions[0].close).toHaveBeenCalledTimes(1);
    await f.inbound('denied', 2);
    expect(f.sessions[0].send).toHaveBeenCalledTimes(1);
    await f.inbound('/start'); expect(f.runner.createSession).toHaveBeenCalledTimes(1);
  });
  it.each(['approve', 'approve_once', 'approve_ttl', 'deny'])('legacy %s callbacks are inert, including after exit and shutdown', async action => {
    const f = setup(); await f.inbound('A');
    f.state.pending[1] = { toolUseId: 't', sessionId: 'pending-id' };
    const before = JSON.stringify(f.state);
    mocks.write.mockClear(); mocks.store.mockClear();
    const callback = () => handleCallback(f.tg, f.state, null, null, 1, 'cb', `${action}:t`, 77, f.manager);
    await callback();
    f.sessions[0].emit('event', { type: 'exit', code: 0, signal: null });
    await callback();
    await f.manager.closeAll();
    await callback();
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0].send.mock.calls).toEqual([['A']]);
    expect(JSON.stringify(f.state)).toBe(before);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(f.tg.editMessageText).not.toHaveBeenCalled();
    expect(f.tg.answerCallbackQuery).toHaveBeenCalledTimes(3);
    expect(f.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb', 'This approval control is no longer supported. No authorization was recorded.');
  });
  it('stops typing on deferral and late callbacks cannot restart it', async () => {
    vi.useFakeTimers(); const f = setup();
    try {
      await f.inbound('A');
      f.sessions[0].result('', { stop_reason: 'tool_deferred', deferred_tool_use: { id: 't', name: 'Bash', input: { command: 'ls' } } });
      await f.manager.drain(1);
      expect(vi.getTimerCount()).toBe(0);
      await f.approve();
      await vi.advanceTimersByTimeAsync(8000);
      expect(f.tg.sendChatAction).toHaveBeenCalledTimes(1);
      expect(f.sessions[0].send.mock.calls).toEqual([['A']]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.manager.closeAll(); vi.useRealTimers(); }
  });
  it('a deferred first turn keeps typing until the overlapping second turn completes', async () => {
    vi.useFakeTimers(); const f = setup();
    try {
      await f.inbound('A'); await f.inbound('B');
      f.sessions[0].result('', { stop_reason: 'tool_deferred' });
      await f.manager.drain(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(f.tg.sendChatAction).toHaveBeenCalledTimes(2);
      f.sessions[0].result('B reply'); await f.manager.drain(1);
      expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'B reply');
      await vi.advanceTimersByTimeAsync(8000);
      expect(f.tg.sendChatAction).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.manager.closeAll(); vi.useRealTimers(); }
  });
  it('preserves session IDs and reports deferrals without approval UI or pending state', async () => {
    const f = setup(); await f.inbound('A');
    f.sessions[0].sessionId = 'discovered';
    f.sessions[0].emit('event', { type: 'raw', data: {} });
    expect(f.state.sessions[1]).toBe('discovered');
    expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('bridge-state.json'), expect.stringContaining('discovered'));
    f.sessions[0].result('', { stop_reason: 'tool_deferred', deferred_tool_use: { id: 't', name: 'Bash', input: { command: 'ls' } } });
    await f.manager.drain(1);
    expect(f.state.pending).toEqual({});
    expect(f.tg.sendMessage.mock.calls).toEqual([[1, 'Claude deferred this action. Telegram cannot authorize it. Resolve it through the configured Claude/Gate approval workflow.']]);
  });
  it('reports a deferred outcome even without tool details', async () => {
    const f = setup(); await f.inbound('A');
    f.sessions[0].result('', { stop_reason: 'tool_deferred' });
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, expect.stringContaining('Telegram cannot authorize'));
    expect(f.state.pending).toEqual({});
  });
  it('passes the memory override through runner options without timeout or global mutation', () => {
    const before = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    process.env.FORTYTWO_TURN_TIMEOUT = '1'; process.env.FORD_TURN_TIMEOUT = '2';
    setup();
    expect(mocks.createRunner).toHaveBeenCalledWith({ bin: expect.any(String), cwd: expect.any(String), env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe(before);
    delete process.env.FORTYTWO_TURN_TIMEOUT; delete process.env.FORD_TURN_TIMEOUT;
  });
  it('journals inbound provenance and one completed outbound result with optional memory', async () => {
    const f = setup();
    const { h, embedder } = await loadMemoryEngine('/unused/test.db');
    const manager = createBridgeSessions(f.tg, f.state, h, embedder); managers.push(manager);
    await handleInbound(f.tg, f.auth, f.state, h, embedder, 1, { message_id: 8, chat: { id: 1 }, text: 'hello', forward_origin: {} }, manager);
    f.sessions[0].result('answer'); await manager.drain(1);
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(mocks.store.mock.calls[0][2]).toMatchObject({ content: 'hello', meta: { source_kind: 'quoted_text', direction: 'inbound' } });
    expect(mocks.store.mock.calls[1][2]).toMatchObject({ content: 'answer', meta: { direction: 'outbound' } });
  });
});

describe('attachment regression', () => {
  it('retains byte limits, paths and provenance before dispatch', async () => {
    const io = { download: vi.fn(async () => Buffer.from('hello')), write: vi.fn() };
    const message = { message_id: 3, chat: { id: 1 }, document: { file_id: 'doc', file_size: 5, mime_type: 'text/plain' } };
    const result = await ingestMessageAttachments(io, message, { maxBytes: 10, storeDir: 'inbox', channel: 'telegram' });
    expect(result.attachments[0]).toMatchObject({ storage_ref: 'inbox/1/3.txt', byte_size: 5, source_envelope: { source_kind: 'telegram_document' } });
    expect(io.write).toHaveBeenCalledWith('inbox/1/3.txt', Buffer.from('hello'));
    const oversized = await ingestMessageAttachments(io, message, { maxBytes: 4, storeDir: 'inbox', channel: 'telegram' });
    expect(oversized.skipped).toHaveLength(1);
    expect(io.download).toHaveBeenCalledTimes(1);
  });
});

describe('poll cancellation', () => {
  it('aborts an outstanding Telegram poll without dispatching new work', async () => {
    const f = setup(); const controller = new AbortController();
    f.tg.getUpdates.mockImplementation((_offset: number, _timeout: number, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const polling = pollLoop(f.tg, f.auth, f.state, null, null, f.manager, controller.signal);
    controller.abort(); await f.manager.closeAll(); await polling;
    expect(f.runner.createSession).not.toHaveBeenCalled();
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
  });
});
