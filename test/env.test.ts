import { describe, it, expect } from 'vitest';
import { envCompat } from '../src/env.js';

describe('envCompat', () => {
  it('returns the current var when it is set', () => {
    expect(envCompat({ FORTYTWO_ROOT: '/a', FORD_ROOT: '/b' }, 'FORTYTWO_ROOT', 'FORD_ROOT')).toBe('/a');
  });

  it('falls back to the legacy alias when the current var is unset', () => {
    expect(envCompat({ FORD_ROOT: '/b' }, 'FORTYTWO_ROOT', 'FORD_ROOT')).toBe('/b');
  });

  it('prefers the current var over the legacy alias', () => {
    expect(envCompat({ FORTYTWO_ROOT: '/new', FORD_ROOT: '/old' }, 'FORTYTWO_ROOT', 'FORD_ROOT')).toBe('/new');
  });

  it('treats an empty current var as unset and uses the legacy alias', () => {
    expect(envCompat({ FORTYTWO_ROOT: '', FORD_ROOT: '/b' }, 'FORTYTWO_ROOT', 'FORD_ROOT')).toBe('/b');
  });

  it('returns undefined when neither is set', () => {
    expect(envCompat({}, 'FORTYTWO_ROOT', 'FORD_ROOT')).toBeUndefined();
  });
});
