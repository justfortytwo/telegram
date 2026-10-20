import type { Runner, RunnerEvent, RunnerSession, RunResult } from '@justfortytwo/runner';
import type { Telegram } from './telegram.js';

type Transport = Pick<Telegram, 'sendMessage' | 'editMessageText' | 'sendChatAction'>;
interface Output { text: string; messages: { id: number; text: string }[] }
interface ChatSession {
  session: RunnerSession;
  output: Output;
  /** Claude is working on submitted input: on at send and consumed input, off at result. */
  active: boolean;
  persistedId?: string;
  termination?: Promise<void>;
  typing?: ReturnType<typeof setInterval>;
  flush?: ReturnType<typeof setTimeout>;
  delivery: Promise<void>;
  closed: boolean;
  listener: (event: RunnerEvent) => void;
}
interface Hooks {
  ids: Record<number, string>;
  persist(): void;
  /** Journaling and deferred notices stay in the bridge. Return true if already delivered. */
  onResult(chatId: number, result: RunResult, text: string): Promise<boolean | void>;
}

/** Telegram chat identity and presentation only; runner owns process and input transport. */
export class ChatSessions {
  private readonly chats = new Map<number, Promise<ChatSession>>();
  private stopped = false;
  private shutdown?: Promise<void>;
  private readonly retired = new Map<number, Set<ChatSession>>();
  private readonly closing = new Set<number>();
  constructor(private runner: Pick<Runner, 'createSession'>, private tg: Transport, private hooks: Hooks) {}

  private getOrCreate(chatId: number, fallbackId?: string): Promise<ChatSession> {
    if (this.stopped || this.closing.has(chatId)) return Promise.reject(new Error('Chat sessions are closed'));
    const existing = this.chats.get(chatId);
    if (existing) return existing;
    const creating = this.runner.createSession({ resumeSessionId: this.hooks.ids[chatId] ?? fallbackId }).then(async session => {
      const chat: ChatSession = { session, output: { text: '', messages: [] }, active: false, persistedId: this.hooks.ids[chatId], delivery: Promise.resolve(), closed: false, listener: () => {} };
      chat.listener = event => {
        if (this.chats.get(chatId) === creating) this.event(chatId, chat, event);
      };
      session.on('event', chat.listener);
      this.remember(chatId, chat);
      if (session.state === 'closed' || session.state === 'failed') {
        session.off('event', chat.listener);
        await session.close();
        throw new Error('Claude session exited during startup. Send another message to resume.');
      }
      return chat;
    }).catch(error => {
      if (this.chats.get(chatId) === creating) this.chats.delete(chatId);
      throw error;
    });
    this.chats.set(chatId, creating);
    return creating;
  }

  async send(chatId: number, prompt: string, fallbackId?: string, retry = true): Promise<void> {
    const entry = this.getOrCreate(chatId, fallbackId);
    const chat = await entry;
    if (this.stopped || this.closing.has(chatId) || chat.closed) throw new Error('Chat sessions are closed');
    const wasActive = chat.active;
    this.activate(chatId, chat);
    try { await chat.session.send(prompt); }
    catch (error) {
      // A rejected input releases typing only if it was the one that started it.
      if (!wasActive) { chat.active = false; this.stopTimers(chat); }
      // The process died before its exit event was observed: retire it and resume once.
      // Matched by name so tests can mock the runner module without its error classes.
      if ((error as Error)?.name === 'RunnerClosedError' && !this.stopped && !this.closing.has(chatId) && !chat.closed) {
        if (this.chats.get(chatId) === entry) this.retire(chatId, chat, true);
        if (retry) return this.send(chatId, prompt, fallbackId, false);
      }
      // Dispatch reports a rejected send. Events report asynchronous failures.
      throw error;
    }
  }

  private remember(chatId: number, chat: ChatSession): void {
    const id = chat.session.sessionId;
    if (id && chat.persistedId !== id) {
      this.hooks.ids[chatId] = id;
      try { this.hooks.persist(); chat.persistedId = id; }
      catch (error) { console.error('[bridge] session ID persistence failed:', error); }
    }
  }

  private queue(chat: ChatSession, task: () => Promise<void>): void {
    chat.delivery = chat.delivery.then(async () => { if (!chat.closed) await task(); }).catch(error => {
      console.error('[bridge] asynchronous delivery failed:', error);
    });
  }

  private event(chatId: number, chat: ChatSession, event: RunnerEvent): void {
    if (chat.closed) return;
    this.remember(chatId, chat);
    switch (event.type) {
      case 'assistant': {
        // Runner emits complete assistant messages, not token deltas or cumulative snapshots.
        const output = chat.output;
        output.text += (output.text ? '\n\n' : '') + event.text;
        if (!chat.flush) chat.flush = setTimeout(() => {
          chat.flush = undefined;
          this.queue(chat, () => this.render(chatId, chat, output));
        }, 1000);
        break;
      }
      case 'result': {
        clearTimeout(chat.flush); chat.flush = undefined;
        const output = chat.output;
        chat.output = { text: '', messages: [] };
        // Every result ends Claude's turn, including steered inputs answered together.
        // Inputs queued after it restart typing when Claude consumes them ('input').
        chat.active = false;
        this.stopTimers(chat);
        // Shown text keeps every assistant message already streamed; result.text is the
        // final message, so it is only appended when no assistant event carried it.
        const final = event.result.text;
        if (final && !output.text.includes(final)) output.text += (output.text ? '\n\n' : '') + final;
        if (!event.result.ok) output.text += (output.text ? '\n\n' : '') + '⚠️ Claude could not complete the turn.';
        if (!output.text) output.text = '(no reply)';
        // Journal the authoritative final reply, as the one-shot bridge did.
        const reply = final || output.text;
        this.queue(chat, async () => {
          const handled = await this.hooks.onResult(chatId, event.result, reply);
          if (!handled) await this.render(chatId, chat, output);
        });
        break;
      }
      case 'error':
        // Only a failed session ends the turn; e.g. one malformed JSONL line does not.
        if (chat.session.state !== 'failed') { console.error(`[bridge] Claude chat ${chatId}: ${event.error.message}`); break; }
        this.fail(chatId, chat, `Claude session error: ${event.error.message}`);
        this.retire(chatId, chat, true);
        break;
      case 'exit':
        this.fail(chatId, chat, `Claude exited (${event.signal ?? event.code ?? 'unknown'}). Send another message to resume.`);
        this.retire(chatId, chat);
        break;
      case 'input': this.activate(chatId, chat); break;
      case 'stderr': console.error(`[bridge] Claude chat ${chatId}: ${event.text}`); break;
      case 'raw': break; // ID is read from the normalized session property, never parsed here.
    }
  }

  private retire(chatId: number, chat: ChatSession, terminate = false): void {
    // Detached sessions cannot receive terminal events. Cancel their pending
    // presentation work before removing the listener, including closed-input retry.
    chat.active = false;
    this.stopTimers(chat);
    this.chats.delete(chatId);
    chat.session.off('event', chat.listener);
    chat.termination = terminate ? chat.session.close() : Promise.resolve();
    const retired = this.retired.get(chatId) ?? new Set<ChatSession>();
    this.retired.set(chatId, retired);
    retired.add(chat);
    // Keep queued output reachable by logout/shutdown until both sides settle.
    void Promise.allSettled([chat.delivery, chat.termination]).then(results => {
      for (const result of results) if (result.status === 'rejected') console.error('[bridge] close failed:', result.reason);
      retired.delete(chat);
      if (!retired.size && this.retired.get(chatId) === retired) this.retired.delete(chatId);
    });
  }

  private fail(chatId: number, chat: ChatSession, message: string): void {
    const active = chat.active;
    chat.active = false;
    this.stopTimers(chat);
    chat.output = { text: '', messages: [] };
    if (active) this.queue(chat, async () => { await this.tg.sendMessage(chatId, `⚠️ ${message}`); });
  }

  private activate(chatId: number, chat: ChatSession): void {
    chat.active = true;
    if (chat.typing) return;
    const refresh = () => {
      // Only submitted work owns typing. Late output and detached sessions must
      // not refresh it; an in-flight Telegram action may still expire naturally.
      if (!chat.active || chat.closed || chat.termination || this.stopped || this.closing.has(chatId)) {
        this.stopTyping(chat);
        return;
      }
      void this.tg.sendChatAction(chatId, 'typing').catch(() => {});
    };
    chat.typing = setInterval(refresh, 4000);
    refresh();
  }
  private stopTyping(chat: ChatSession): void {
    clearInterval(chat.typing); chat.typing = undefined;
  }
  private stopTimers(chat: ChatSession): void {
    this.stopTyping(chat);
    clearTimeout(chat.flush); chat.flush = undefined;
  }

  private async render(chatId: number, chat: ChatSession, output: Output): Promise<void> {
    // Keep each Telegram message below 4096 UTF-16 units, including surrogate pairs.
    const chunks: string[] = [];
    for (let start = 0; start < output.text.length;) {
      let end = Math.min(start + 4000, output.text.length);
      if (end < output.text.length && /[\uD800-\uDBFF]/.test(output.text[end - 1])) end--;
      chunks.push(output.text.slice(start, end));
      start = end;
    }
    for (let i = 0; i < Math.max(chunks.length, output.messages.length); i++) {
      if (chat.closed) return;
      const text = chunks[i] ?? '…';
      const previous = output.messages[i];
      if (!previous) {
        const sent = await this.tg.sendMessage(chatId, text);
        output.messages.push({ id: sent.message_id, text });
      } else if (previous.text !== text) {
        await this.tg.editMessageText(chatId, previous.id, text);
        previous.text = text;
      }
    }
  }

  /** Wait for already queued Telegram delivery, never for a Claude result. */
  async drain(chatId: number): Promise<void> { await (await this.chats.get(chatId))?.delivery; }

  async close(chatId: number): Promise<void> {
    this.closing.add(chatId);
    const creating = this.chats.get(chatId);
    const retiring = [...(this.retired.get(chatId) ?? [])];
    for (const chat of retiring) chat.closed = true;
    try {
      // A failed creation has nothing to close; logout must still succeed.
      const live = await creating?.catch(() => undefined);
      const chats = live ? [...retiring, live] : retiring;
      await Promise.all(chats.map(async chat => {
        chat.closed = true;
        chat.active = false;
        this.stopTimers(chat);
        chat.session.off('event', chat.listener);
        chat.termination ??= chat.session.close();
        await chat.termination;
        await chat.delivery;
      }));
    } finally {
      if (this.chats.get(chatId) === creating) this.chats.delete(chatId);
      this.closing.delete(chatId);
    }
  }
  closeAll(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    this.shutdown = (async () => {
      const ids = new Set([...this.chats.keys(), ...this.retired.keys()]);
      const results = await Promise.allSettled([...ids].map(id => this.close(id)));
      for (const result of results) if (result.status === 'rejected') console.error('[bridge] close failed:', result.reason);
    })();
    return this.shutdown;
  }
}
