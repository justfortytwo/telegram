import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../src/adapter.js';
import { MemoryBindingStore } from '../src/bindings.js';
import { handleAuthCommand, isAuthorized, type AuthContext } from '../src/login.js';
import { interpretResult } from '../src/bridge.js';

function ctx(bootstrap: number[] = []): { auth: AuthContext; adapter: TelegramAdapter } {
  const adapter = new TelegramAdapter(new MemoryBindingStore());
  return { auth: { adapter, bootstrap: new Set(bootstrap) }, adapter };
}

describe('login / pairing binding flow', () => {
  it('unbound sender (no /login) gets NO response (lockdown)', () => {
    const { auth } = ctx();
    expect(isAuthorized(auth, 999)).toBe(false);
    expect(handleAuthCommand(auth, 999, 'hello?')).toEqual({ kind: 'ignore' });
  });

  it('a valid /login code binds the chat to the owner', () => {
    const { auth, adapter } = ctx();
    const { code } = adapter.issueChallenge('owner');
    const action = handleAuthCommand(auth, 42, `/login ${code}`);
    expect(action.kind).toBe('login_ok');
    expect(isAuthorized(auth, 42)).toBe(true);
  });

  it('codes are single-use', () => {
    const { auth, adapter } = ctx();
    const { code } = adapter.issueChallenge('owner');
    expect(handleAuthCommand(auth, 1, `/login ${code}`).kind).toBe('login_ok');
    // second chat presenting the same (now consumed) code is unbound -> ignored
    expect(handleAuthCommand(auth, 2, `/login ${code}`)).toEqual({ kind: 'ignore' });
    expect(isAuthorized(auth, 2)).toBe(false);
  });

  it('codes expire (short TTL)', () => {
    let t = 0;
    const adapter = new TelegramAdapter(new MemoryBindingStore(), { ttlSeconds: 60, now: () => t });
    const auth: AuthContext = { adapter, bootstrap: new Set() };
    const { code } = adapter.issueChallenge('owner');
    t = 61_000; // past TTL
    expect(handleAuthCommand(auth, 7, `/login ${code}`)).toEqual({ kind: 'ignore' });
  });

  it('/logout removes the binding', () => {
    const { auth, adapter } = ctx();
    const { code } = adapter.issueChallenge('owner');
    handleAuthCommand(auth, 5, `/login ${code}`);
    expect(isAuthorized(auth, 5)).toBe(true);
    expect(handleAuthCommand(auth, 5, '/logout').kind).toBe('logout');
    expect(isAuthorized(auth, 5)).toBe(false);
  });

  it('ALLOWED_CHAT_IDS bootstrap authorizes without a binding', () => {
    const { auth } = ctx([123]);
    expect(isAuthorized(auth, 123)).toBe(true);
  });
});

describe('interpretResult (pure turn-loop decision logic)', () => {
  it('reads a deferred tool from a tool_deferred result', () => {
    const r = interpretResult({ stop_reason: 'tool_deferred', deferred_tool_use: { id: 't1', name: 'Bash', input: { command: 'ls' } }, session_id: 's' });
    expect(r.deferred).toEqual({ id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(r.sessionId).toBe('s');
  });

  it('reads a reply from a normal result', () => {
    const r = interpretResult({ result: 'hi there', session_id: 's' });
    expect(r.reply).toBe('hi there');
    expect(r.deferred).toBeUndefined();
  });
});
