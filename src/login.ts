// Login / pairing flow + inbound authorization.
//
// The lockdown rule (carried over from the monolith, spec §14) is: unbound
// senders get NO response. The ONLY exception is a sender presenting `/login
// <code>` — that is how an unknown chat earns a binding. Everything else from an
// unbound chat is silently dropped.
//
// Authorization set = persisted bindings  ∪  optional ALLOWED_CHAT_IDS bootstrap.
// The bootstrap set lets the very first owner chat reach the bridge before any
// binding exists (e.g. to issue the first challenge), without leaving the bot
// open. Once bindings exist, they are the durable source of truth.

import type { TelegramAdapter } from './adapter.js';
import type { Binding } from './bindings.js';

export type LoginAction =
  | { kind: 'login_ok'; binding: Binding; reply: string }
  | { kind: 'login_failed'; reply: string }
  | { kind: 'logout'; reply: string }
  | { kind: 'ignore' };            // lockdown: produce no response

const LOGIN_RE = /^\/login(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;
const LOGOUT_RE = /^\/logout(?:@[A-Za-z0-9_]+)?\s*$/;

export interface AuthContext {
  /** Telegram adapter that owns the challenge/verify + binding lookups. */
  adapter: TelegramAdapter;
  /** Static bootstrap allowlist (from ALLOWED_CHAT_IDS). May be empty. */
  bootstrap: Set<number>;
}

/**
 * Is this chat currently authorized to talk to the assistant?
 * True iff it has a persisted binding OR is in the bootstrap allowlist.
 */
export function isAuthorized(ctx: AuthContext, chatId: number): boolean {
  // Groups/channels (negative Telegram chat ids) are NEVER the owner: a group
  // chat id identifies the ROOM, not the speaker, so authorizing one would let
  // any member drive the assistant. Only private chats (chatId === the user id)
  // can be authorized/bound.
  if (chatId < 0) return false;
  if (ctx.bootstrap.has(chatId)) return true;
  return ctx.adapter.bindingFor(String(chatId)) !== null;
}

/**
 * Classify an inbound text from a chat and, for `/login` / `/logout`, perform
 * the binding mutation. Returns the action the bridge should take.
 *
 * Lockdown contract:
 *   - authorized chat: caller proceeds to the normal turn loop (this returns
 *     `ignore` for non-command text so the bridge handles it itself — callers
 *     should only consult this for command handling + the unbound gate).
 *   - unbound chat presenting `/login <code>`: verify + maybe bind.
 *   - unbound chat, anything else: `ignore` (NO response).
 */
export function handleAuthCommand(ctx: AuthContext, chatId: number, text: string): LoginAction {
  const trimmed = (text ?? '').trim();
  const chatKey = String(chatId);
  const authorized = isAuthorized(ctx, chatId);

  // Groups/channels can never pair or be authorized (see isAuthorized): the chat
  // id is the room, not a person. Drop silently.
  if (chatId < 0) return { kind: 'ignore' };

  const loginMatch = trimmed.match(LOGIN_RE);
  if (loginMatch) {
    const code = loginMatch[1];
    if (!code) {
      // Only hint at the format if the chat is already authorized; an unbound
      // chat that fat-fingers `/login` learns nothing about the bot's existence.
      return authorized
        ? { kind: 'login_failed', reply: 'Usage: /login <code>' }
        : { kind: 'ignore' };
    }
    // A chat that already holds a binding cannot re-point it with a fresh code:
    // that would be an owner-reassignment primitive (and would consume a code
    // minted for a different chat). Require an explicit /logout first.
    if (ctx.adapter.bindingFor(chatKey)) {
      return { kind: 'login_failed', reply: 'This chat is already paired. Send /logout first to re-pair.' };
    }
    const binding = ctx.adapter.verify(chatKey, code);
    if (binding) {
      return { kind: 'login_ok', binding, reply: `Paired. This chat is now bound to "${binding.owner}". Send /logout to unbind.` };
    }
    // Bad/expired/used code from an unbound chat: stay dark to avoid an oracle.
    return authorized
      ? { kind: 'login_failed', reply: 'That code is invalid or expired.' }
      : { kind: 'ignore' };
  }

  if (LOGOUT_RE.test(trimmed)) {
    if (!authorized) return { kind: 'ignore' };
    ctx.adapter.unbind(chatKey);
    return { kind: 'logout', reply: 'Unbound. This chat can no longer reach the assistant until you /login again.' };
  }

  // Not an auth command. Authorized chats fall through to the normal turn loop
  // (the bridge re-derives authorization); unbound chats are dropped (lockdown).
  return { kind: 'ignore' };
}

/** Convenience: does this inbound look like an auth command at all? */
export function isAuthCommand(text: string): boolean {
  const trimmed = (text ?? '').trim();
  return LOGIN_RE.test(trimmed) || LOGOUT_RE.test(trimmed);
}
