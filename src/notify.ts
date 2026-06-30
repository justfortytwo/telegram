/**
 * Telegram notifier adapter for @justfortytwo/scheduler's Notifier interface.
 *
 * Kept STRUCTURAL: this module does NOT import @justfortytwo/scheduler. The
 * Notifier shape `{ notify(n: { kind: string; text: string }): Promise<void> }`
 * is satisfied purely by duck-typing, so telegram does not gain a dependency on
 * scheduler. The scheduler daemon passes an instance of this at runtime.
 */

/** Minimal Notification shape (mirrors scheduler's Notification; structural). */
export interface Notification {
  kind: string;
  text: string;
}

/** Minimal Notifier shape (mirrors scheduler's Notifier; structural). */
export interface TelegramNotifierInstance {
  notify(n: Notification): Promise<void>;
}

/**
 * Create a Telegram notifier that forwards each scheduler notification to a
 * single Telegram chat. The `send` callback is injected so the notifier is
 * testable without a real bot token or network.
 */
export function telegramNotifier(opts: {
  send: (chatId: number, text: string) => Promise<void>;
  chatId: number;
}): TelegramNotifierInstance {
  return {
    async notify(n: Notification): Promise<void> {
      await opts.send(opts.chatId, n.text);
    },
  };
}

// ---------------------------------------------------------------------------
// enqueueReply — deduped reply enqueuer
// ---------------------------------------------------------------------------

/** Minimal deps interface: bound functions from memory's JobStore. */
export interface EnqueueReplyDeps {
  /**
   * Enqueue a new job. Matches memory's `enqueue(h, job)` signature when
   * partially applied: `(job) => enqueue(h, job)`.
   */
  enqueue(job: { kind: string; run_at: string; payload: unknown }): number;
  /**
   * Returns true if a pending/running job of `kind` exists with
   * `payload.$.id === idValue`. Partially applied from memory's
   * `existsPending(h, kind, idValue)`.
   */
  existsPending(kind: string, idValue: number): boolean;
}

/**
 * Enqueue a `reply` job for `chatId` ONLY if no pending/running reply for
 * that chat already exists (dedup via `existsPending`).
 *
 * Payload shape: `{ id: chatId, text }` — the `id` field is what
 * `existsPending(h, 'reply', chatId)` matches via `json_extract(payload, '$.id')`.
 *
 * @param deps  - DI'd `{ enqueue, existsPending }` bound to the bridge's DB handle.
 * @param chatId - Telegram chat id (used as the dedup key).
 * @param text  - Reply text to deliver.
 * @param now   - ISO timestamp for `run_at` (injectable for testability).
 */
export async function enqueueReply(
  deps: EnqueueReplyDeps,
  chatId: number,
  text: string,
  now: string,
): Promise<void> {
  if (deps.existsPending('reply', chatId)) return;
  deps.enqueue({ kind: 'reply', run_at: now, payload: { id: chatId, text } });
}
