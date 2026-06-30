import { describe, it, expect, vi } from 'vitest';
import { telegramNotifier, enqueueReply } from '../src/notify.js';

// ---------------------------------------------------------------------------
// telegramNotifier
// ---------------------------------------------------------------------------

describe('telegramNotifier', () => {
  it('calls send(chatId, text) when notify is invoked', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = telegramNotifier({ send, chatId: 42 });
    await notifier.notify({ kind: 'wake', text: 'hello from scheduler' });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(42, 'hello from scheduler');
  });

  it('forwards the notification text exactly', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = telegramNotifier({ send, chatId: 7 });
    await notifier.notify({ kind: 'daily_briefing', text: 'Good morning!' });
    expect(send).toHaveBeenCalledWith(7, 'Good morning!');
  });
});

// ---------------------------------------------------------------------------
// enqueueReply — dependency-injected fakes
// ---------------------------------------------------------------------------

describe('enqueueReply', () => {
  function makeDeps(alreadyPending = false) {
    const enqueue = vi.fn().mockReturnValue(1);
    const existsPending = vi.fn().mockReturnValue(alreadyPending);
    return { enqueue, existsPending };
  }

  it('enqueues a reply job when no pending reply exists for the chatId', async () => {
    const deps = makeDeps(false);
    await enqueueReply(deps, 42, 'hi', '2026-01-01T00:00:00.000Z');
    expect(deps.existsPending).toHaveBeenCalledWith('reply', 42);
    expect(deps.enqueue).toHaveBeenCalledOnce();
    const job = deps.enqueue.mock.calls[0][0];
    expect(job.kind).toBe('reply');
    expect(job.run_at).toBe('2026-01-01T00:00:00.000Z');
    expect(job.payload).toMatchObject({ id: 42, text: 'hi' });
  });

  it('does NOT enqueue when a pending reply for the same chatId already exists (dedup)', async () => {
    const deps = makeDeps(true);
    await enqueueReply(deps, 42, 'hi again', '2026-01-01T00:00:00.000Z');
    expect(deps.existsPending).toHaveBeenCalledWith('reply', 42);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues independently per chatId (dedup is per-chat)', async () => {
    // Chat 42 already has a pending reply; chat 99 does not.
    const enqueue = vi.fn().mockReturnValue(1);
    const existsPending = vi.fn().mockImplementation((_kind: string, id: number) => id === 42);
    const deps = { enqueue, existsPending };

    await enqueueReply(deps, 42, 'duplicate', '2026-01-01T00:00:00.000Z');
    await enqueueReply(deps, 99, 'new', '2026-01-01T00:00:00.000Z');

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0].payload).toMatchObject({ id: 99 });
  });
});
