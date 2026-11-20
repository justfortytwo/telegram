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

/** Minimal deps interface: bound functions from the scheduler's job API. */
export interface EnqueueReplyDeps {
  /**
   * Enqueue a new job. Matches scheduler's `enqueue(h, job)` signature when
   * partially applied: `(job) => enqueue(h, job)`.
   */
  enqueue(job: { kind: string; run_at: string; payload: unknown }): number;
  /**
   * Returns true if a pending/running job of `kind` exists with
   * `payload.$.id === idValue`. Partially applied from scheduler's
   * `existsPending(h, kind, idValue)`.
   */
  existsPending(kind: string, idValue: number): boolean;
}

/** The part of @justfortytwo/scheduler the reply queue uses (structural, no import). */
interface SchedulerJobsModule {
  runSchedulerMigrations(k: unknown): Promise<void>;
  enqueue(h: unknown, job: { kind: string; run_at: string; payload: unknown }): number;
  existsPending(h: unknown, kind: string, idValue: number): boolean;
}

/**
 * Bind the reply queue to the bridge's DB handle `h` (opened with memory's
 * `openDb` and already migrated by memory's `runMigrations`). The jobs table
 * and the job API belong to the optional peer `@justfortytwo/scheduler`: this
 * runs its migrations (`runSchedulerMigrations`, so the table exists on a
 * fresh DB) and returns `{ enqueue, existsPending }` bound to `h`.
 *
 * Returns null, and the bridge just drops queued replies, when the scheduler is
 * not installed, predates the job API, or its migration fails. The import is
 * dynamic and typed structurally, so telegram takes no scheduler dependency.
 */
export async function loadReplyQueue(
  h: { k: unknown },
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<EnqueueReplyDeps | null> {
  let mod: Partial<SchedulerJobsModule>;
  try {
    mod = (await importer('@justfortytwo/scheduler')) as Partial<SchedulerJobsModule>;
  } catch {
    console.error('[bridge] @justfortytwo/scheduler not installed — undelivered replies will NOT be queued.');
    return null;
  }
  const { runSchedulerMigrations, enqueue, existsPending } = mod;
  if (typeof runSchedulerMigrations !== 'function' || typeof enqueue !== 'function' || typeof existsPending !== 'function') {
    console.error('[bridge] @justfortytwo/scheduler has no job API (needs a newer scheduler) — undelivered replies will NOT be queued.');
    return null;
  }
  try {
    await runSchedulerMigrations(h.k);
  } catch (e: unknown) {
    console.error(`[bridge] scheduler migrations failed (${(e as Error)?.message ?? e}) — undelivered replies will NOT be queued.`);
    return null;
  }
  return {
    enqueue: (job) => enqueue(h, job),
    existsPending: (kind, idValue) => existsPending(h, kind, idValue),
  };
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
