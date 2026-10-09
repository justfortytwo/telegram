import { afterEach, expect, it, vi } from 'vitest';
import { Telegram } from '../src/telegram.js';
afterEach(() => vi.unstubAllGlobals());
it('passes the optional poll AbortSignal through to fetch', async () => {
  const fetch = vi.fn(async () => ({ json: async () => ({ ok: true, result: [] }) }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await new Telegram('fake-token', new Set()).getUpdates(7, 30, controller.signal);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/getUpdates'), expect.objectContaining({ signal: controller.signal, body: JSON.stringify({ offset: 7, timeout: 30, allowed_updates: ['message', 'callback_query'] }) }));
});
