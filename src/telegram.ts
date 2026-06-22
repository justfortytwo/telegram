// Minimal Telegram Bot API client (long-poll + send) for the bridge. No SDK —
// just fetch against https://api.telegram.org/bot<token>/. The bridge is the
// ONLY long-poller; nothing else may call getUpdates on this bot.

const API = (token: string) => `https://api.telegram.org/bot${token}`;

async function tg(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API(token)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; description?: string; result?: any };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>');
}

function formatMarkdownBlock(text: string): string {
  return text.split(/\r?\n/).map((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) return `<b>${formatInlineMarkdown(heading[1])}</b>`;
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) return `${bullet[1]}• ${formatInlineMarkdown(bullet[2])}`;
    return formatInlineMarkdown(line);
  }).join('\n');
}

export function formatTelegramHtml(text: string): string {
  return text.split('```').map((part, index) => {
    if (index % 2 === 0) return formatMarkdownBlock(part);
    return `<pre>${escapeHtml(part.replace(/^\s*\w+\n/, '').trim())}</pre>`;
  }).join('');
}

export interface PhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number; }
export interface TgDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number; }

export interface AttachmentSpec {
  file_id: string;
  mime: string;
  file_name?: string;
  file_size?: number;
  source_kind: 'telegram_photo' | 'telegram_document';
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; is_bot: boolean };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: TgDocument;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: { message_id: number; chat: { id: number } } };
}

export function largestPhoto(sizes: PhotoSize[]): PhotoSize | undefined {
  const score = (p: PhotoSize) => p.file_size ?? p.width * p.height;
  return sizes.reduce<PhotoSize | undefined>((best, s) => (!best || score(s) > score(best) ? s : best), undefined);
}

export function messageAttachmentSpecs(message: TgMessage): AttachmentSpec[] {
  const specs: AttachmentSpec[] = [];
  if (message.photo && message.photo.length) {
    const p = largestPhoto(message.photo);
    if (p) specs.push({ file_id: p.file_id, mime: 'image/jpeg', file_size: p.file_size, source_kind: 'telegram_photo' });
  }
  if (message.document) {
    specs.push({
      file_id: message.document.file_id,
      mime: message.document.mime_type ?? 'application/octet-stream',
      file_name: message.document.file_name,
      file_size: message.document.file_size,
      source_kind: 'telegram_document',
    });
  }
  return specs;
}

export class Telegram {
  constructor(private token: string, private allowedChatIds: Set<number>) {}

  /**
   * True if the chat is on the static bootstrap allowlist (ALLOWED_CHAT_IDS).
   *
   * NOTE (post-extraction): in the monolith this was the sole authorization
   * check (lockdown). In @justfortytwo/babelfish, authorization is owned by the
   * login/binding flow (see src/login.ts `authorize`). This allowlist is now a
   * BOOTSTRAP set unioned with persisted bindings, not the only gate. The poller
   * no longer hard-filters on it; see the bridge poll loop.
   */
  allowed(chatId: number): boolean {
    return this.allowedChatIds.has(chatId);
  }

  /** Long-poll for updates. Pass offset = lastUpdateId + 1 to acknowledge. */
  getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
    return tg(this.token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
  }

  sendMessage(chatId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text: formatTelegramHtml(text), parse_mode: 'HTML' };
    if (replyMarkup) body['reply_markup'] = replyMarkup;
    return tg(this.token, 'sendMessage', body);
  }

  editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    return tg(this.token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: formatTelegramHtml(text), parse_mode: 'HTML' }).then(() => undefined);
  }

  react(chatId: number, messageId: number, emoji: string): Promise<void> {
    return tg(this.token, 'setMessageReaction', {
      chat_id: chatId, message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }).then(() => undefined);
  }

  /** Native "Bot is typing…" chat action (shows ~5s in the header; refresh to keep alive). */
  sendChatAction(chatId: number, action = 'typing'): Promise<void> {
    return tg(this.token, 'sendChatAction', { chat_id: chatId, action }).then(() => undefined);
  }

  /** Answer a callback_query (button tap) — stops the button's loading spinner. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) body['text'] = text;
    return tg(this.token, 'answerCallbackQuery', body).then(() => undefined);
  }

  /** Resolve a file_id to a downloadable file_path (Bot API getFile). */
  async getFilePath(fileId: string): Promise<string> {
    const r = await tg(this.token, 'getFile', { file_id: fileId });
    if (!r || typeof r.file_path !== 'string') throw new Error('telegram getFile returned no file_path');
    return r.file_path;
  }

  /** Download raw file bytes from the Telegram file API. */
  async downloadFile(filePath: string): Promise<Buffer> {
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export interface ApprovalKeyboardOptions {
  bashTtlHours?: number;
}

/** Inline approval keyboard, keyed by tool_use_id. Bash gets a TTL allowlist option. */
export function approvalKeyboard(toolUseId: string, opts: ApprovalKeyboardOptions = {}): Record<string, unknown> {
  const row = opts.bashTtlHours
    ? [
      { text: 'Run once', callback_data: `approve_once:${toolUseId}` },
      { text: `Allow ${opts.bashTtlHours}h`, callback_data: `approve_ttl:${toolUseId}` },
      { text: 'Deny', callback_data: `deny:${toolUseId}` },
    ]
    : [
      { text: 'Approve', callback_data: `approve_once:${toolUseId}` },
      { text: 'Deny', callback_data: `deny:${toolUseId}` },
    ];
  return { inline_keyboard: [row] };
}

/** Parse "12345, -100999" → Set<number>. */
export function parseAllowed(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)));
}
