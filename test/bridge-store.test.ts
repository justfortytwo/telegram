import { describe, it, expect } from 'vitest';
import '../src/bridge.js';

describe('bridge.ts import has no side-effects', () => {
  it('importing the module does not set CLAUDE_CODE_DISABLE_AUTO_MEMORY', () => {
    // The static import above already loaded bridge.ts. Lazy runner init means
    // the env override is passed only to runner configuration, never mutated
    // globally — so importing for the pure helpers (interpretResult) leaves process.env untouched.
    expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});
