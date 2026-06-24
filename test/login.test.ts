import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../src/adapter.js';
import { MemoryBindingStore } from '../src/bindings.js';
import { handleAuthCommand, isAuthorized, type AuthContext } from '../src/login.js';
import { interpretResult } from '../src/bridge.js';

function ctx(bootstrap: number[] = []): { auth: AuthContext; adapter: TelegramAdapter } {
  const adapter = new TelegramAdapter(new MemoryBindingStore());
  return { auth: { adapter, bootstrap: new Set(bootstrap) }, adapter };
}

describe('cross-process pairing (persisted challenges)', () => {
  it('a code issued by one adapter is redeemable by another sharing the store', () => {
    // Simulates the real split: the CLI (`fortytwo pair`) mints the code in one
    // process; the running bridge redeems it in another. They share a store.
    const store = new MemoryBindingStore();
    const cli = new TelegramAdapter(store);
    const { code } = cli.issueChallenge('owner');

    const bridge = new TelegramAdapter(store); // separate instance ~ separate process
    const auth: AuthContext = { adapter: bridge, bootstrap: new Set() };
    expect(handleAuthCommand(auth, 42, `/login ${code}`).kind).toBe('login_ok');
    expect(isAuthorized(auth, 42)).toBe(true);
  });

  it('a consumed code cannot be reused by a third instance (single-use across the store)', () => {
    const store = new MemoryBindingStore();
    const { code } = new TelegramAdapter(store).issueChallenge('owner');
    const a: AuthContext = { adapter: new TelegramAdapter(store), bootstrap: new Set() };
    expect(handleAuthCommand(a, 1, `/login ${code}`).kind).toBe('login_ok');
    const b: AuthContext = { adapter: new TelegramAdapter(store), bootstrap: new Set() };
    expect(handleAuthCommand(b, 2, `/login ${code}`)).toEqual({ kind: 'ignore' });
  });
});

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

describe('login / pairing — security hardening', () => {
  it('a group chat id (negative) is never authorized and cannot pair', () => {
    const { auth, adapter } = ctx();
    const { code } = adapter.issueChallenge('owner');
    expect(isAuthorized(auth, -100123)).toBe(false);
    expect(handleAuthCommand(auth, -100123, `/login ${code}`)).toEqual({ kind: 'ignore' });
    expect(isAuthorized(auth, -100123)).toBe(false);
    // the group attempt did NOT consume the code — a real private chat still can
    expect(handleAuthCommand(auth, 42, `/login ${code}`).kind).toBe('login_ok');
  });

  it('a bound chat cannot re-point its binding with a fresh code (no reassignment)', () => {
    const { auth, adapter } = ctx();
    expect(handleAuthCommand(auth, 7, `/login ${adapter.issueChallenge('alice').code}`).kind).toBe('login_ok');
    expect(adapter.bindingFor('7')?.owner).toBe('alice');
    const bobCode = adapter.issueChallenge('bob').code;             // a code for bob
    expect(handleAuthCommand(auth, 7, `/login ${bobCode}`).kind).toBe('login_failed'); // refused
    expect(adapter.bindingFor('7')?.owner).toBe('alice');           // owner unchanged
    // bob's code was NOT consumed by the reassignment attempt — bob's real chat can use it
    expect(handleAuthCommand(auth, 8, `/login ${bobCode}`).kind).toBe('login_ok');
    expect(adapter.bindingFor('8')?.owner).toBe('bob');
  });

  it('gives an unbound chat the SAME response regardless of input (no oracle)', () => {
    const { auth } = ctx();
    const ignore = { kind: 'ignore' };
    expect(handleAuthCommand(auth, 5, 'hello')).toEqual(ignore);         // plain text
    expect(handleAuthCommand(auth, 5, '/login')).toEqual(ignore);        // malformed
    expect(handleAuthCommand(auth, 5, '/login 000000')).toEqual(ignore); // wrong code (no pending)
    expect(handleAuthCommand(auth, 5, '/logout')).toEqual(ignore);       // not bound
  });

  it('re-pair after /logout works', () => {
    const { auth, adapter } = ctx();
    handleAuthCommand(auth, 9, `/login ${adapter.issueChallenge('owner').code}`);
    handleAuthCommand(auth, 9, '/logout');
    expect(isAuthorized(auth, 9)).toBe(false);
    expect(handleAuthCommand(auth, 9, `/login ${adapter.issueChallenge('owner').code}`).kind).toBe('login_ok');
    expect(isAuthorized(auth, 9)).toBe(true);
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
