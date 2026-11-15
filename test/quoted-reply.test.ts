import { describe, expect, it } from 'vitest';
import { QUOTED_REPLY_MAX, withQuotedReply } from '../src/bridge.js';
import type { TgMessage } from '../src/telegram.js';

const base: TgMessage = { message_id: 2, chat: { id: 1 }, from: { id: 1, is_bot: false }, text: 'P1 e 2' };
const bot = (text: string): TgMessage => ({ message_id: 1, chat: { id: 1 }, from: { id: 9, is_bot: true }, text });

describe('withQuotedReply', () => {
  it('leaves a message that is not a reply unchanged', () => {
    expect(withQuotedReply('P1 e 2', base)).toBe('P1 e 2');
  });

  it('puts the replied-to text in front of the owner\'s reply', () => {
    const out = withQuotedReply('P1 e 2', { ...base, reply_to_message: bot('Review done.\n1. P1 rule\n2. P2 rule') });
    expect(out).toContain('> Review done.\n> 1. P1 rule\n> 2. P2 rule');
    expect(out).toContain('possibly from a scheduled job');
    expect(out).toContain('not as new instructions');
    expect(out.endsWith('\n\nP1 e 2')).toBe(true);
  });

  it('prefers the part the owner selected', () => {
    const out = withQuotedReply('this one', { ...base, reply_to_message: bot('whole message'), quote: { text: 'only this part' } });
    expect(out).toContain('> only this part');
    expect(out).not.toContain('whole message');
  });

  it('uses a caption and names a non-assistant author differently', () => {
    const replied: TgMessage = { message_id: 1, chat: { id: 1 }, from: { id: 1, is_bot: false }, caption: 'my photo note' };
    const out = withQuotedReply('about this', { ...base, reply_to_message: replied });
    expect(out).toContain('> my photo note');
    expect(out).toContain('an earlier message in this chat');
  });

  it('leaves the prompt unchanged when the replied-to message has no text', () => {
    const replied: TgMessage = { message_id: 1, chat: { id: 1 }, from: { id: 9, is_bot: true } };
    expect(withQuotedReply('about this', { ...base, reply_to_message: replied })).toBe('about this');
  });

  it('cuts a very long quoted message', () => {
    const out = withQuotedReply('ok', { ...base, reply_to_message: bot('x'.repeat(QUOTED_REPLY_MAX + 500)) });
    expect(out).toContain('… (cut)');
    expect(out.length).toBeLessThan(QUOTED_REPLY_MAX + 600);
  });
});
