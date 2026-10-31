import { afterEach, describe, expect, it, vi } from 'vitest';
import { Telegram, messageAttachmentSpecs, type TgMessage } from '../src/telegram.js';
afterEach(() => vi.unstubAllGlobals());
it('passes the optional poll AbortSignal through to fetch', async () => {
  const fetch = vi.fn(async () => ({ json: async () => ({ ok: true, result: [] }) }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await new Telegram('fake-token', new Set()).getUpdates(7, 30, controller.signal);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/getUpdates'), expect.objectContaining({ signal: controller.signal, body: JSON.stringify({ offset: 7, timeout: 30, allowed_updates: ['message', 'callback_query'] }) }));
});

describe('messageAttachmentSpecs: voice notes and audio files', () => {
  const base = { message_id: 1, chat: { id: 1 } };
  it('maps a voice note to an audio/ogg spec without inventing a file name', () => {
    const specs = messageAttachmentSpecs({ ...base, voice: { file_id: 'AAAAAAAA12345678', mime_type: 'audio/ogg', file_size: 1234 } } as TgMessage);
    expect(specs).toEqual([{ file_id: 'AAAAAAAA12345678', mime: 'audio/ogg', file_size: 1234, source_kind: 'telegram_voice' }]);
  });
  it('maps an audio file, defaulting the mime type and keeping the given file name', () => {
    const specs = messageAttachmentSpecs({ ...base, audio: { file_id: 'BBBBBBBB87654321', file_name: 'song.mp3' } } as TgMessage);
    expect(specs).toEqual([{ file_id: 'BBBBBBBB87654321', mime: 'audio/mpeg', file_name: 'song.mp3', source_kind: 'telegram_audio' }]);
  });
  it('leaves the audio file name unset when Telegram sends none', () => {
    const specs = messageAttachmentSpecs({ ...base, audio: { file_id: 'abc', mime_type: 'audio/mp4' } } as TgMessage);
    expect(specs).toEqual([{ file_id: 'abc', mime: 'audio/mp4', source_kind: 'telegram_audio' }]);
  });
});
