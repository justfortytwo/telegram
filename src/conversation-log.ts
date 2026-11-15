// Telegram's own port for writing the conversation. Structural on purpose:
// no @justfortytwo/transcript (or memory) types are imported. The
// implementation is loaded dynamically and degrades to a no-op.

export interface ConversationEvent {
  channel: string;
  direction: 'inbound' | 'outbound' | 'internal';
  actor: string;
  kind: string;
  content: string;
  threadId?: string | null;
  meta?: Record<string, unknown>;
}

/** A position in the conversation log (mirrors transcript's `Cursor`; structural). */
export interface LogCursor {
  database: string;
  position: number;
}

/** A message a scheduled job produced for the owner (channel `scheduler`, outbound). */
export interface ScheduledMessage {
  /** The job kind, e.g. `daily_briefing`. */
  kind: string;
  content: string;
  /** When it was logged, as stored (UTC). */
  ts: string;
}

export interface ConversationLog {
  append(event: ConversationEvent): Promise<unknown>;
  /**
   * The scheduler's messages logged after `after`, oldest first, and the cursor
   * to pass next time. With no usable cursor (first call, another database) it
   * returns no messages and the current end of the log. Absent when the log
   * cannot be read back (no transcript, or one without the delta API).
   */
  scheduledSince?(after: LogCursor | undefined): { cursor: LogCursor; messages: ScheduledMessage[] };
}

export const noopConversationLog: ConversationLog = { append: async () => undefined };

/** Channel event shape the bridge carries (snake_case legacy fields). */
export interface ChannelEvent {
  channel: string; direction: string; actor: string; kind: string; content: string;
  meta?: Record<string, unknown>; thread_id?: string | null; approval_status?: string | null;
}

export function toConversationEvent(entry: ChannelEvent): ConversationEvent {
  const meta: Record<string, unknown> = { ...(entry.meta ?? {}) };
  if (entry.approval_status != null) meta.approval_status = entry.approval_status;
  const event: ConversationEvent = {
    channel: entry.channel,
    direction: entry.direction as ConversationEvent['direction'],
    actor: entry.actor,
    kind: entry.kind,
    content: entry.content,
  };
  if (entry.thread_id != null) event.threadId = entry.thread_id;
  if (Object.keys(meta).length) event.meta = meta;
  return event;
}

type DeltaRow = { channel?: unknown; direction?: unknown; kind?: unknown; content?: unknown; ts?: unknown };
type TranscriptModule = {
  prepareTranscript: (h: unknown) => Promise<unknown> | unknown;
  createTranscript: (h: unknown, embedder: unknown) => ConversationLog;
  transcriptHead?: (h: unknown) => LogCursor;
  transcriptDelta?: (h: unknown, cursor: LogCursor, limit?: number) => { cursor: LogCursor; entries: DeltaRow[] };
};

/** Rows read per page, and the most rows looked back over in one call. */
const DELTA_PAGE = 200;
export const SCHEDULED_SCAN_MAX = 2000;

/**
 * Build `scheduledSince` over transcript's cursor API (`transcriptHead` /
 * `transcriptDelta`). Undefined when the installed transcript lacks it.
 */
export function scheduledReader(mod: Pick<TranscriptModule, 'transcriptHead' | 'transcriptDelta'>, h: unknown): ConversationLog['scheduledSince'] {
  const { transcriptHead, transcriptDelta } = mod;
  if (typeof transcriptHead !== 'function' || typeof transcriptDelta !== 'function') return undefined;
  return (after) => {
    const head = transcriptHead(h);
    const usable = after !== undefined && after.database === head.database
      && Number.isSafeInteger(after.position) && after.position >= 0 && after.position <= head.position;
    if (!usable) return { cursor: head, messages: [] };
    // After a very long silence only the most recent stretch is looked at.
    let cursor: LogCursor = { database: head.database, position: Math.max(after.position, head.position - SCHEDULED_SCAN_MAX) };
    const messages: ScheduledMessage[] = [];
    while (cursor.position < head.position) {
      const page = transcriptDelta(h, cursor, DELTA_PAGE);
      for (const row of page.entries) {
        if (row.channel !== 'scheduler' || row.direction !== 'outbound') continue;
        if (typeof row.content !== 'string' || !row.content.trim()) continue;
        messages.push({ kind: typeof row.kind === 'string' ? row.kind : 'scheduled', content: row.content, ts: typeof row.ts === 'string' ? row.ts : '' });
      }
      if (page.cursor.position <= cursor.position) break;
      cursor = page.cursor;
    }
    return { cursor, messages };
  };
}

/**
 * Load the optional @justfortytwo/transcript peer. Any failure (not installed,
 * prepare/create throws) is logged and yields the no-op log.
 */
export async function loadConversationLog(
  h: unknown,
  embedder: unknown,
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<ConversationLog> {
  try {
    const mod = (await importer('@justfortytwo/transcript')) as TranscriptModule;
    await mod.prepareTranscript(h);
    const transcript = mod.createTranscript(h, embedder);
    const scheduledSince = scheduledReader(mod, h);
    if (!scheduledSince) return transcript;
    return { append: (event) => transcript.append(event), scheduledSince };
  } catch (e: unknown) {
    console.error(`[bridge] transcript unavailable (${(e as Error)?.message ?? e}) — messages will NOT be recorded.`);
    return noopConversationLog;
  }
}
