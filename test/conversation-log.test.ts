import { describe, it, expect, vi } from 'vitest';
import { toConversationEvent, loadConversationLog, noopConversationLog } from '../src/conversation-log.js';

describe('toConversationEvent', () => {
  it('maps an inbound owner message', () => {
    const e = toConversationEvent({ channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', content: 'hello' });
    expect(e).toEqual({ channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', content: 'hello' });
  });
  it('lifts thread_id to threadId and approval_status into meta, keeping existing meta', () => {
    const e = toConversationEvent({
      channel: 'telegram', direction: 'internal', actor: 'assistant', kind: 'approval_decision',
      content: 'approved X', meta: { command_glob: 'ls' }, thread_id: 't1', approval_status: 'approved',
    });
    expect(e.threadId).toBe('t1');
    expect(e.meta).toEqual({ command_glob: 'ls', approval_status: 'approved' });
  });
});

describe('loadConversationLog', () => {
  it('returns the no-op when the import throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = await loadConversationLog({}, {}, async () => { throw new Error('missing'); });
    expect(log).toBe(noopConversationLog);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('returns the module log when the module loads', async () => {
    const created = { append: vi.fn(async () => 1) };
    const prepareTranscript = vi.fn(async () => {});
    const createTranscript = vi.fn(() => created);
    const h = {}; const emb = {};
    const log = await loadConversationLog(h, emb, async () => ({ prepareTranscript, createTranscript }));
    expect(log).toBe(created);
    expect(prepareTranscript).toHaveBeenCalledWith(h);
    expect(createTranscript).toHaveBeenCalledWith(h, emb);
  });
});
