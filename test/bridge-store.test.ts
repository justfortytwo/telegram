import { describe, it, expect } from 'vitest';
import { mapChannelEventToMemoryInput } from '../src/bridge.js';

describe('bridge.ts import has no side-effects', () => {
  it('importing the module does not set CLAUDE_CODE_DISABLE_AUTO_MEMORY', () => {
    // The static import above already loaded bridge.ts. Lazy runner init means
    // the env var is only mutated on the first headless turn (getRunner), never
    // at module load — so importing for the pure helpers (interpretResult,
    // mapChannelEventToMemoryInput) leaves process.env untouched.
    expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});

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
