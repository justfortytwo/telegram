import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSessions } from '../src/chat-sessions.js';

class FakeSession extends EventEmitter {
  sessionId?: string;
  state = 'ready';
  lastActivityAt = Date.now();
  send = vi.fn(async (_text: string) => {});
  close = vi.fn(async () => { this.emit('event', { type: 'exit', code: 0, signal: null }); });
  event(event: any) { this.emit('event', event); }
}
function setup(ids: Record<number, string> = {}) {
  const sessions: FakeSession[] = [];
  const runner = { run: vi.fn(), createSession: vi.fn(async () => { const s = new FakeSession(); sessions.push(s); return s; }) };
  const tg = { sendMessage: vi.fn(async () => ({ message_id: 42 })), editMessageText: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}) };
  const onResult = vi.fn(async () => {});
  const persist = vi.fn();
  const manager = new ChatSessions(runner as any, tg, { ids, persist, onResult });
  return { manager, runner, sessions, tg, onResult, persist, ids };
}
const result = (text = 'done') => ({ type: 'result', result: { ok: true, text, raw: {} }, raw: {} });
const input = { type: 'input', raw: {} };
afterEach(() => vi.useRealTimers());
describe('persistent chat sessions', () => {
  it('creates once and delivers B before any result of A, including concurrent sends', async () => {
    const f = setup();
    await Promise.all([f.manager.send(1, 'A'), f.manager.send(1, 'B')]);
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    expect(f.sessions[0].send.mock.calls).toEqual([['A'], ['B']]);
    expect(f.runner.run).not.toHaveBeenCalled();
    await f.manager.closeAll();
  });
  it('coalesces complete assistant messages, finalizes once, and resets for the next result', async () => {
    vi.useFakeTimers();
    const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].event({ type: 'assistant', text: 'Hello', raw: {} });
    f.sessions[0].event({ type: 'assistant', text: 'World', raw: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'Hello\n\nWorld');
    f.sessions[0].event(result('Final'));
    await f.manager.drain(1);
    // The final result is appended to, never replaces, already streamed messages.
    expect(f.tg.editMessageText).toHaveBeenCalledWith(1, 42, 'Hello\n\nWorld\n\nFinal');
    expect(f.onResult).toHaveBeenCalledWith(1, expect.anything(), 'Final');
    expect(f.onResult).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.send(1, 'B'); f.sessions[0].event(result('Second'));
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenLastCalledWith(1, 'Second');
    await f.manager.closeAll();
  });
  it('persists discovered IDs, removes exited sessions and lazily resumes', async () => {
    const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].sessionId = 'claude-id'; f.sessions[0].event({ type: 'raw', data: {} });
    expect(f.ids[1]).toBe('claude-id'); expect(f.persist).toHaveBeenCalled();
    f.sessions[0].event({ type: 'exit', code: 1, signal: null });
    await f.manager.send(1, 'B');
    expect(f.runner.createSession).toHaveBeenLastCalledWith({ resumeSessionId: 'claude-id' });
    expect(f.sessions).toHaveLength(2);
    await f.manager.closeAll();
    const restarted = setup(f.ids); await restarted.manager.send(1, 'C');
    expect(restarted.runner.createSession).toHaveBeenCalledWith({ resumeSessionId: 'claude-id' });
    await restarted.manager.closeAll();
  });
  it('isolates chats and stops typing on error and shutdown', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A'); await f.manager.send(2, 'B');
    expect(vi.getTimerCount()).toBe(2);
    f.sessions[0].state = 'failed';
    f.sessions[0].event({ type: 'error', error: new Error('broken') });
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, expect.stringContaining('broken'));
    expect(vi.getTimerCount()).toBe(1);
    f.sessions[1].event(result('chat two')); await f.manager.drain(2);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(2, 'chat two');
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
    expect(f.sessions.every(s => s.close.mock.calls.length === 1)).toBe(true);
    await expect(f.manager.send(3, 'no')).rejects.toThrow('closed');
  });
});

describe('lifecycle races and Telegram limits', () => {
  it('does not let a late exit from a failed session evict its replacement', async () => {
    const f = setup(); await f.manager.send(1, 'A');
    const old = f.sessions[0]; old.state = 'failed';
    old.close.mockImplementation(async () => {});
    old.event({ type: 'error', error: new Error('stdin closed') });
    await f.manager.send(1, 'B');
    old.event({ type: 'exit', code: 1, signal: null });
    await f.manager.send(1, 'C');
    expect(f.runner.createSession).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
  });
  it('splits emoji output within Telegram UTF-16 limits', async () => {
    const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].event(result('😀'.repeat(3000)));
    await f.manager.drain(1);
    const texts = f.tg.sendMessage.mock.calls.map(call => call[1]);
    expect(texts.every(text => text.length <= 4000)).toBe(true);
    expect(texts.join('')).toBe('😀'.repeat(3000));
    await f.manager.closeAll();
  });
  it('closes a session that finishes creation during shutdown, without sending', async () => {
    const f = setup(); let resolve!: (s: FakeSession) => void;
    const session = new FakeSession();
    f.runner.createSession.mockImplementation(() => new Promise(r => { resolve = r; }));
    const send = f.manager.send(1, 'A');
    const rejected = expect(send).rejects.toThrow('closed');
    const closing = f.manager.closeAll(); resolve(session);
    await rejected; await closing;
    expect(session.send).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });
  it('stops typing when one steered result answers several submitted inputs', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A'); await f.manager.send(1, 'B'); await f.manager.send(1, 'C');
    f.sessions[0].event(input); f.sessions[0].event(input); f.sessions[0].event(input);
    f.sessions[0].event(result('ABC')); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    await f.manager.closeAll();
  });
  it('restarts typing when Claude picks up an input queued after the turn ended', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A'); await f.manager.send(1, 'B');
    f.sessions[0].event(input);
    f.sessions[0].event(result('A')); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    const count = f.tg.sendChatAction.mock.calls.length;
    f.sessions[0].event(input);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count + 1);
    f.sessions[0].event(result('B')); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });
});

describe('close cancels queued output', () => {
  it.each(['logout', 'shutdown'])('suppresses retired output on %s', async mode => {
    const f = setup(); await f.manager.send(1, 'A');
    let release!: () => void;
    f.onResult.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    f.sessions[0].event(result('late answer'));
    // Start the result hook, then retire the process while its delivery is blocked.
    await Promise.resolve(); await Promise.resolve();
    f.sessions[0].event({ type: 'exit', code: 0, signal: null });
    const closing = mode === 'logout' ? f.manager.close(1) : f.manager.closeAll();
    release(); await closing;
    await Promise.resolve(); await Promise.resolve();
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
    await f.manager.closeAll();
  });
  it('does not orphan a process when persisting its initial ID fails', async () => {
    const f = setup(); const session = new FakeSession(); session.sessionId = 'id';
    f.runner.createSession.mockResolvedValueOnce(session);
    f.persist.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await f.manager.send(1, 'A');
    session.event({ type: 'raw', data: {} });
    expect(f.persist).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
    expect(session.close).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe('input failures', () => {
  it('does not stop typing for an existing turn when a later input is rejected', async () => {
    vi.useFakeTimers(); const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].send.mockRejectedValueOnce(new TypeError('invalid prompt'));
    await expect(f.manager.send(1, '')).rejects.toThrow('invalid prompt');
    expect(vi.getTimerCount()).toBe(1);
    f.sessions[0].event(result()); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });
  it('discards a session that already exited before createSession resolved', async () => {
    const f = setup(); const dead = new FakeSession(); dead.state = 'closed';
    f.runner.createSession.mockResolvedValueOnce(dead);
    await expect(f.manager.send(1, 'A')).rejects.toThrow('startup');
    expect(dead.send).not.toHaveBeenCalled();
    expect(dead.close).toHaveBeenCalledTimes(1);
    await f.manager.send(1, 'B');
    expect(f.runner.createSession).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
  });
});

describe('repaired edge cases', () => {
  it('does not duplicate a final result already streamed as an assistant message', async () => {
    const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].event({ type: 'assistant', text: 'Checking', raw: {} });
    f.sessions[0].event({ type: 'assistant', text: 'Answer', raw: {} });
    f.sessions[0].event(result('Answer'));
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'Checking\n\nAnswer');
    expect(f.onResult).toHaveBeenCalledWith(1, expect.anything(), 'Answer');
    await f.manager.closeAll();
  });
  it('keeps the turn alive on a non-fatal runner error', async () => {
    vi.useFakeTimers(); const f = setup(); await f.manager.send(1, 'A');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.sessions[0].event({ type: 'error', error: new Error('Malformed Claude JSONL output') });
    await f.manager.drain(1);
    expect(f.tg.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    f.sessions[0].event(result('still fine')); await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'still fine');
    expect(f.runner.createSession).toHaveBeenCalledTimes(1);
    log.mockRestore(); await f.manager.closeAll();
  });
  it('resumes once when the process died before its exit event arrived', async () => {
    const f = setup(); await f.manager.send(1, 'A');
    const dead = f.sessions[0]; dead.sessionId = 'claude-id'; dead.event({ type: 'raw', data: {} });
    dead.send.mockRejectedValueOnce(Object.assign(new Error('Session input is closed'), { name: 'RunnerClosedError' }));
    await f.manager.send(1, 'B');
    expect(dead.close).toHaveBeenCalledTimes(1);
    expect(f.runner.createSession).toHaveBeenLastCalledWith({ resumeSessionId: 'claude-id' });
    expect(f.sessions[1].send).toHaveBeenCalledWith('B');
    await f.manager.closeAll();
  });
  it('closes a chat whose session creation failed', async () => {
    const f = setup();
    f.runner.createSession.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(f.manager.send(1, 'A')).rejects.toThrow('spawn failed');
    await expect(f.manager.close(1)).resolves.toBeUndefined();
  });
  it('keeps refreshing a genuinely pending silent turn until its terminal result', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A');
    (f.sessions[0] as any).lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    (f.sessions[0] as any).lastActivityAt = Date.now();
    f.sessions[0].event({ type: 'assistant', text: 'late', raw: {} });
    expect(vi.getTimerCount()).toBe(2);
    f.sessions[0].event(result('late')); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });
});

describe('overlapping turns', () => {
  it('send A, send B before result(A): each turn finalizes its own reply; typing follows the active turn', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A');
    await f.manager.send(1, 'B');
    const session = f.sessions[0];
    expect(session.send.mock.calls).toEqual([['A'], ['B']]);

    session.event(input);
    session.event(result('reply A')); await f.manager.drain(1);
    // Turn A ended; B has not been consumed yet, so nothing is visibly working.
    expect(vi.getTimerCount()).toBe(0);
    const actions = f.tg.sendChatAction.mock.calls.length;

    session.event(input);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.tg.sendChatAction.mock.calls.length).toBe(actions + 2);

    session.event(result('reply B')); await f.manager.drain(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.tg.sendChatAction.mock.calls.length).toBe(actions + 2);
    expect(f.tg.sendMessage.mock.calls.map(c => c[1])).toEqual(['reply A', 'reply B']);
    expect(f.onResult).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
  });
});


describe('typing ownership', () => {
  it('stops refreshes at the final result before delivery finishes; late events cannot restart it', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A');
    expect(f.tg.sendChatAction).toHaveBeenCalledWith(1, 'typing');
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(2);
    let release!: () => void;
    f.onResult.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    f.sessions[0].event(result('delivered'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(2);
    release(); await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'delivered');
    f.sessions[0].event({ type: 'assistant', text: 'late output', raw: {} });
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
  });

  it('cancels the old typing owner on closed-input retry, including after it leaves the retired set', async () => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A');
    const old = f.sessions[0];
    old.send.mockRejectedValueOnce(Object.assign(new Error('input closed'), { name: 'RunnerClosedError' }));
    await f.manager.send(1, 'B');
    expect(f.sessions).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1); // only replacement owns typing
    f.sessions[1].event(result('reply B'));
    await f.manager.drain(1);
    expect(f.tg.sendMessage).toHaveBeenCalledWith(1, 'reply B');
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave an old timer when replacement creation fails', async () => {
    vi.useFakeTimers(); const f = setup(); await f.manager.send(1, 'A');
    f.sessions[0].send.mockRejectedValueOnce(Object.assign(new Error('input closed'), { name: 'RunnerClosedError' }));
    f.runner.createSession.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(f.manager.send(1, 'B')).rejects.toThrow('spawn failed');
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });

  it('retires a closed replacement even when the one retry is exhausted', async () => {
    vi.useFakeTimers(); const f = setup(); await f.manager.send(1, 'A');
    const closed = () => Object.assign(new Error('input closed'), { name: 'RunnerClosedError' });
    f.sessions[0].send.mockRejectedValueOnce(closed());
    const replacement = new FakeSession();
    replacement.send.mockRejectedValueOnce(closed());
    f.runner.createSession.mockResolvedValueOnce(replacement);
    await expect(f.manager.send(1, 'B')).rejects.toThrow('input closed');
    expect(replacement.close).toHaveBeenCalledTimes(1);
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });

  it.each(['error', 'exit', 'rejected', 'failed result'])('stops refreshing after %s', async terminal => {
    vi.useFakeTimers(); const f = setup();
    if (terminal === 'rejected') {
      const session = new FakeSession();
      session.send.mockRejectedValueOnce(new TypeError('invalid'));
      f.runner.createSession.mockResolvedValueOnce(session);
      await expect(f.manager.send(1, 'A')).rejects.toThrow('invalid');
    } else {
      await f.manager.send(1, 'A');
      if (terminal === 'error') {
        f.sessions[0].state = 'failed';
        f.sessions[0].event({ type: 'error', error: new Error('failed') });
      } else if (terminal === 'exit') f.sessions[0].event({ type: 'exit', code: 1 });
      else f.sessions[0].event({ type: 'result', result: { ok: false, text: '', raw: {} } });
    }
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await f.manager.closeAll();
  });

  it.each(['logout', 'shutdown'])('stops refreshing during %s even while session close is blocked', async mode => {
    vi.useFakeTimers(); const f = setup();
    await f.manager.send(1, 'A'); await f.manager.send(1, 'B');
    let release!: () => void;
    f.sessions[0].close.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    const closing = mode === 'shutdown' ? f.manager.closeAll() : f.manager.close(1);
    const count = f.tg.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.tg.sendChatAction).toHaveBeenCalledTimes(count);
    f.sessions[0].event({ type: 'assistant', text: 'late', raw: {} });
    f.sessions[0].event(result());
    expect(vi.getTimerCount()).toBe(0);
    release(); await closing; await f.manager.closeAll();
  });
});
