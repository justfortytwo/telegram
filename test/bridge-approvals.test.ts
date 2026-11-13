// Opt-in approvals from Telegram: with an approval store injected, a gate
// deferral becomes an Approve/Deny card, and the decision is applied by
// restarting the chat's Claude session on its saved id with no new input (Claude
// Code then re-runs the deferred call, which the gate allows or denies once).
// Without a store nothing here applies: see bridge-sessions.test.ts.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createRunner: vi.fn(), write: vi.fn() }));
vi.mock('@justfortytwo/runner', () => ({ createRunner: mocks.createRunner }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), writeFileSync: mocks.write, mkdirSync: vi.fn() }));
vi.mock('@justfortytwo/memory', () => ({
  openDb: () => ({ k: {} }), runMigrations: async () => {}, store: vi.fn(async () => 1),
  FakeEmbedder: class {}, enqueue: vi.fn(), existsPending: vi.fn(),
}));
import { InMemoryApprovalStore } from '@justfortytwo/gate';
import { approvalsEnabled, createBridgeSessions, formatApprovalRequest, handleCallback, handleInbound } from '../src/bridge.js';
import { noopConversationLog } from '../src/conversation-log.js';
import { TelegramAdapter } from '../src/adapter.js';
import { MemoryBindingStore } from '../src/bindings.js';
import { formatTelegramHtml } from '../src/telegram.js';

class Session extends EventEmitter {
  state = 'ready'; sessionId?: string;
  send = vi.fn(async (_prompt: string) => {});
  close = vi.fn(async () => {});
  result(text: string, raw: unknown = {}) { this.emit('event', { type: 'result', result: { ok: true, text, raw }, raw }); }
}
const DEFERRED = { stop_reason: 'tool_deferred', deferred_tool_use: { id: 'toolu_1', name: 'Bash', input: { command: 'git push' } } };
const NOTICE = 'Claude deferred this action. Telegram cannot authorize it. Resolve it through the configured Claude/Gate approval workflow.';
const managers: ReturnType<typeof createBridgeSessions>[] = [];

async function setup(opts: { staged?: boolean } = {}) {
  const sessions: Session[] = [];
  const runner = { run: vi.fn(), createSession: vi.fn(async (_o: { resumeSessionId?: string }) => { const s = new Session(); sessions.push(s); return s; }) };
  mocks.createRunner.mockReturnValue(runner);
  let nextMessageId = 100;
  const tg: any = { sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })), editMessageText: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}) };
  const state = { sessions: {} as Record<number, string>, lastUpdateId: 0 } as any;
  const auth = { adapter: new TelegramAdapter(new MemoryBindingStore()), bootstrap: new Set([1]) };
  const approvals = new InMemoryApprovalStore();
  if (opts.staged !== false) await approvals.addPending({ tool: 'Bash', target: 'git push', payload: { command: 'git push' }, tier: 'external', tool_use_id: 'toolu_1', session_id: 'sid-1' });
  const manager = createBridgeSessions(tg, state, null, noopConversationLog, [], approvals); managers.push(manager);
  const inbound = (text: string) => handleInbound(tg, auth, state, null, noopConversationLog, 1, { message_id: 9, chat: { id: 1 }, text }, manager, approvals);
  const tap = (data: string, cardId: number) => handleCallback(tg, state, null, noopConversationLog, 1, 'cb', data, cardId, manager, approvals);
  /** First turn: one message in, Claude defers toolu_1 on session sid-1. */
  const defer = async () => {
    await inbound('push it');
    sessions[0]!.sessionId = 'sid-1';
    sessions[0]!.result('', DEFERRED);
    await manager.drain(1);
  };
  const status = async () => (await approvals.getByToolUseId('toolu_1'))?.status;
  return { tg, state, manager, sessions, runner, approvals, inbound, tap, defer, status };
}
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.closeAll())); });

describe('approvalsEnabled', () => {
  it('is off unless TELEGRAM_APPROVALS is an explicit yes', () => {
    for (const off of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) expect(approvalsEnabled({ TELEGRAM_APPROVALS: off }), String(off)).toBe(false);
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) expect(approvalsEnabled({ TELEGRAM_APPROVALS: on }), on).toBe(true);
  });
});

describe('formatApprovalRequest', () => {
  it('shows a Bash command as is and other tools as their input', () => {
    expect(formatApprovalRequest({ id: 't', name: 'Bash', input: { command: 'git push' } })).toBe('🔐 Approval needed\n```text\nBash\n\ngit push\n```');
    expect(formatApprovalRequest({ id: 't', name: 'Write', input: { file_path: 'a.txt' } })).toContain('"file_path": "a.txt"');
  });
  it('renders the exact command and tool name, whatever their first line looks like', () => {
    const html = (name: string, command: string) => formatTelegramHtml(formatApprovalRequest({ id: 't', name, input: { command } })!);
    expect(html('Bash', 'sudo\nrm -rf /data')).toBe('🔐 Approval needed\n<pre>Bash\n\nsudo\nrm -rf /data</pre>');
    expect(html('Bash', 'text\ncurl x')).toContain('<pre>Bash\n\ntext\ncurl x</pre>');
    expect(formatTelegramHtml(formatApprovalRequest({ id: 't', name: 'mcp__mail__send_now', input: {} })!)).toContain('<pre>mcp__mail__send_now\n\n{}</pre>');
  });
  it('refuses to show an input it cannot show whole and unaltered', () => {
    expect(formatApprovalRequest({ id: 't', name: 'Bash', input: { command: 'x'.repeat(3501) } })).toBeNull();
    expect(formatApprovalRequest({ id: 't', name: 'Bash', input: { command: 'echo ```' } })).toBeNull();
    expect(formatApprovalRequest({ id: 't', name: 'Bash', input: { command: 'x'.repeat(3500) } })).toContain('x'.repeat(3500));
  });
});

describe('approvals from Telegram', () => {
  it('offers no buttons when the input is too long to show in full', async () => {
    const f = await setup();
    await f.inbound('do it');
    f.sessions[0]!.sessionId = 'sid-1';
    f.sessions[0]!.result('', { stop_reason: 'tool_deferred', deferred_tool_use: { id: 'toolu_1', name: 'Bash', input: { command: 'x'.repeat(4000) } } });
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledTimes(1);
    const [, text, keyboard] = f.tg.sendMessage.mock.calls[0];
    expect(text).toMatch(/too long to show in full/);
    expect(keyboard).toBeUndefined();
    expect(f.state.pending?.[1]).toBeUndefined();
    expect(await f.status()).toBe('pending');
  });
  it('turns a staged deferral into an Approve/Deny card and remembers it', async () => {
    const f = await setup(); await f.defer();
    expect(f.tg.sendMessage).toHaveBeenCalledTimes(1);
    const [chat, text, markup] = f.tg.sendMessage.mock.calls[0];
    expect(chat).toBe(1);
    expect(text).toContain('Approval needed');
    expect(text).toContain('Bash\n\ngit push');
    expect(text).toContain('git push');
    expect(markup).toEqual({ inline_keyboard: [[{ text: '✅ Approve', callback_data: 'gate:approve' }, { text: '❌ Deny', callback_data: 'gate:deny' }]] });
    expect(f.state.pending[1]).toEqual({ toolUseId: 'toolu_1', sessionId: 'sid-1', toolName: 'Bash', cardMessageId: 100 });
    expect(await f.status()).toBe('pending');
  });

  it('keeps the plain notice for a deferral the store did not stage', async () => {
    const f = await setup({ staged: false }); await f.defer();
    expect(f.tg.sendMessage.mock.calls).toEqual([[1, NOTICE]]);
    expect(f.state.pending?.[1]).toBeUndefined();
  });

  it('approve records the decision and resumes the saved session with no new input', async () => {
    const f = await setup(); await f.defer();
    await f.tap('gate:approve', 100);
    expect(await f.status()).toBe('approved');
    expect(f.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.runner.createSession).toHaveBeenCalledTimes(2);
    expect(f.runner.createSession.mock.calls[1]![0]).toEqual({ resumeSessionId: 'sid-1' });
    expect(f.sessions[1]!.send).not.toHaveBeenCalled();
    expect(f.sessions[0]!.send).toHaveBeenCalledTimes(1);
    expect(f.state.pending[1]).toBeUndefined();
    expect(f.tg.answerCallbackQuery).toHaveBeenCalledWith('cb', 'Approved');
    expect(f.tg.editMessageText).toHaveBeenCalledWith(1, 100, expect.stringContaining('Approved: Bash'));
    // The resumed turn's reply reaches the chat like any other.
    f.sessions[1]!.result('pushed'); await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenLastCalledWith(1, 'pushed');
  });

  it('deny records the decision and resumes the same way, so Claude sees the refusal', async () => {
    const f = await setup(); await f.defer();
    await f.tap('gate:deny', 100);
    expect(await f.status()).toBe('denied');
    expect(f.runner.createSession.mock.calls[1]![0]).toEqual({ resumeSessionId: 'sid-1' });
    expect(f.sessions[1]!.send).not.toHaveBeenCalled();
    expect(f.tg.answerCallbackQuery).toHaveBeenCalledWith('cb', 'Denied');
    expect(f.tg.editMessageText).toHaveBeenCalledWith(1, 100, expect.stringContaining('Denied: Bash'));
  });

  it('shows typing while the resumed turn runs', async () => {
    const f = await setup(); await f.defer();
    f.tg.sendChatAction.mockClear();
    await f.tap('gate:approve', 100);
    expect(f.tg.sendChatAction).toHaveBeenCalledWith(1, 'typing');
  });

  it('a tap on anything but the current card decides nothing', async () => {
    const f = await setup(); await f.defer();
    await f.tap('gate:approve', 55);        // an older card
    await f.tap('approve:toolu_1', 100);     // the pre-1.0.0-4 callback format
    await f.tap('gate:approve_always', 100); // not an action
    expect(await f.status()).toBe('pending');
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.state.pending[1].cardMessageId).toBe(100);
    expect(f.tg.answerCallbackQuery).toHaveBeenCalledTimes(3);
    expect(f.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb', 'This approval control is no longer supported. No authorization was recorded.');
  });

  it('a second tap on the same card does nothing more', async () => {
    const f = await setup(); await f.defer();
    await f.tap('gate:approve', 100);
    await f.tap('gate:deny', 100);
    expect(await f.status()).toBe('approved');
    expect(f.runner.createSession).toHaveBeenCalledTimes(2);
  });

  it('does not resume when the request was already decided elsewhere', async () => {
    const f = await setup(); await f.defer();
    await f.approvals.setDecisionByToolUseId('toolu_1', 'denied', 'cli');
    await f.tap('gate:approve', 100);
    expect(await f.status()).toBe('denied');
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.state.pending[1]).toBeUndefined();
    expect(f.tg.answerCallbackQuery).toHaveBeenCalledWith('cb', 'This request is no longer pending. Nothing was changed.');
  });

  it('a new message while a request waits denies it, lets Claude see the refusal, then delivers the message', async () => {
    const f = await setup(); await f.defer();
    await f.inbound('never mind, do something else');
    expect(await f.status()).toBe('denied');
    expect(f.state.pending[1]).toBeUndefined();
    expect(f.tg.editMessageText).toHaveBeenCalledWith(1, 100, expect.stringContaining('Denied: Bash'));
    expect(f.runner.createSession.mock.calls[1]![0]).toEqual({ resumeSessionId: 'sid-1' });
    expect(f.sessions[1]!.send.mock.calls).toEqual([['never mind, do something else']]);
    expect(f.sessions[0]!.send).toHaveBeenCalledTimes(1);
  });

  it('a local command while a request waits leaves it pending', async () => {
    const f = await setup(); await f.defer();
    await f.inbound('/start');
    expect(await f.status()).toBe('pending');
    expect(f.state.pending[1].cardMessageId).toBe(100);
  });
});
