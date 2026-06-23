import { describe, it, expect } from 'vitest';
import { mapChannelEventToMemoryInput } from '../src/bridge.js';

describe('mapChannelEventToMemoryInput', () => {
  it('maps an inbound owner message to a MemoryInput with channel provenance', () => {
    const m = mapChannelEventToMemoryInput({
      channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', content: 'hello',
    });
    expect(m.content).toBe('hello');
    expect(m.source).toBe('telegram:owner');     // provenance the gate/recall can filter on
    expect(m.observed).toBe('stated');
    expect(m.tags).toEqual(['telegram', 'inbound', 'message']);
    expect(m.meta).toMatchObject({ direction: 'inbound', kind: 'message', actor: 'owner' });
  });

  it('preserves existing meta and lifts thread_id / approval_status into meta', () => {
    const m = mapChannelEventToMemoryInput({
      channel: 'telegram', direction: 'internal', actor: 'assistant', kind: 'approval_decision',
      content: 'approved X', meta: { command_glob: 'ls' }, thread_id: 't1', approval_status: 'approved',
    });
    expect(m.source).toBe('telegram:assistant');
    expect(m.meta).toMatchObject({ command_glob: 'ls', thread_id: 't1', approval_status: 'approved', kind: 'approval_decision' });
  });
});
