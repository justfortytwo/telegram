// Channel-agnostic binding contract.
//
// A ChannelAdapter knows how to pair a channel identity (e.g. a Telegram chat
// id) with a logical `owner`. Pairing is a two-step challenge/verify:
//
//   1. issueChallenge(owner) -> { code, ttl }
//      Owner-side: mint a single-use, short-TTL code. The owner relays this code
//      out-of-band to the channel they want to bind (e.g. "DM the bot
//      `/login 482913`").
//   2. verify(channelUserId, proof) -> binding | null
//      Channel-side: when an inbound message presents the code, confirm it is
//      valid + unexpired + unused, then mint and persist a Binding.
//
// This keeps authorization independent of any single channel: a future Slack /
// email / SMS adapter implements the same contract.

import { randomInt } from 'node:crypto';
import type { Binding, BindingStore, ChannelType } from './bindings.js';

export interface Challenge {
  /** The single-use pairing code the owner relays to the channel. */
  code: string;
  /** Seconds until the code expires. */
  ttl: number;
}

export interface ChannelAdapter {
  /** The channel this adapter binds (e.g. 'telegram'). */
  readonly channelType: ChannelType;
  /** Mint a single-use, short-TTL pairing code for `owner`. */
  issueChallenge(owner: string): Challenge;
  /**
   * Verify `proof` (a presented code) for `channelUserId`. On success, persist
   * and return the Binding; on failure (bad/expired/used code) return null.
   */
  verify(channelUserId: string, proof: string): Binding | null;
}

interface PendingChallenge {
  code: string;
  owner: string;
  expiresAt: number; // epoch ms
}

export interface ChallengeOptions {
  /** Code lifetime in seconds. Default 300 (5 min). Short by design. */
  ttlSeconds?: number;
  /** Number of digits in the generated code. Default 6. */
  digits?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Telegram implementation of ChannelAdapter. Codes live in-process (a wedged
 * bridge restart drops outstanding codes — acceptable for a short-TTL,
 * owner-initiated flow). Verified bindings persist via the injected BindingStore.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'telegram';
  private readonly pending = new Map<string, PendingChallenge>(); // code -> challenge
  private readonly ttlSeconds: number;
  private readonly digits: number;
  private readonly now: () => number;

  constructor(private readonly store: BindingStore, opts: ChallengeOptions = {}) {
    this.ttlSeconds = opts.ttlSeconds ?? 300;
    this.digits = opts.digits ?? 6;
    this.now = opts.now ?? (() => Date.now());
  }

  issueChallenge(owner: string): Challenge {
    this.sweepExpired();
    const max = 10 ** this.digits;
    const code = String(randomInt(0, max)).padStart(this.digits, '0');
    this.pending.set(code, { code, owner, expiresAt: this.now() + this.ttlSeconds * 1000 });
    return { code, ttl: this.ttlSeconds };
  }

  verify(channelUserId: string, proof: string): Binding | null {
    this.sweepExpired();
    const code = proof.trim();
    const challenge = this.pending.get(code);
    if (!challenge) return null;
    if (challenge.expiresAt <= this.now()) { this.pending.delete(code); return null; }

    // Single-use: consume the code regardless of downstream outcome.
    this.pending.delete(code);

    const binding: Binding = {
      channelType: this.channelType,
      channelUserId,
      owner: challenge.owner,
      boundAt: new Date(this.now()).toISOString(),
    };
    this.store.put(binding);
    return binding;
  }

  /** Look up the persisted binding for a channel id (no proof needed). */
  bindingFor(channelUserId: string): Binding | null {
    return this.store.get(this.channelType, channelUserId);
  }

  /** Remove a persisted binding (logout). */
  unbind(channelUserId: string): void {
    this.store.remove(this.channelType, channelUserId);
  }

  private sweepExpired(): void {
    const t = this.now();
    for (const [code, c] of this.pending) {
      if (c.expiresAt <= t) this.pending.delete(code);
    }
  }
}
