import { describe, expect, it, vi, beforeEach } from 'vitest';

const synth = vi.fn();
vi.mock('./api', () => ({ synthesizeSpeech: (text: string) => synth(text) }));

import { SentenceSpeaker, looksLikeEcho } from './voice-speaker';

beforeEach(() => {
  // Never resolves: we only check what gets sent to synthesis, not playback.
  synth.mockReset().mockImplementation(() => new Promise(() => {}));
});

describe('SentenceSpeaker', () => {
  it('speaks each finished sentence as the reply streams in', () => {
    const sp = new SentenceSpeaker();
    sp.update('はい。');
    expect(synth).toHaveBeenLastCalledWith('はい。');
    sp.update('はい。本日の東京は晴れ');
    expect(synth).toHaveBeenCalledTimes(1); // sentence not finished yet
    sp.update('はい。本日の東京は晴れの予報です。気温は');
    expect(synth).toHaveBeenLastCalledWith('本日の東京は晴れの予報です。');
    sp.finish('はい。本日の東京は晴れの予報です。気温は20度です');
    expect(synth).toHaveBeenLastCalledWith('気温は20度です');
    expect(synth).toHaveBeenCalledTimes(3);
  });

  it('merges very short later sentences with the next one', () => {
    const sp = new SentenceSpeaker();
    sp.update('最初の文はこれです。うん。そして次の文です。');
    expect(synth.mock.calls.map((c) => c[0])).toEqual([
      '最初の文はこれです。',
      'うん。そして次の文です。',
    ]);
  });

  it('splits English on ". " but not inside numbers', () => {
    const sp = new SentenceSpeaker();
    sp.finish('Pi is 3.14 roughly. That is all.');
    expect(synth.mock.calls.map((c) => c[0])).toEqual(['Pi is 3.14 roughly.', 'That is all.']);
  });

  it('stops queuing after stop()', async () => {
    const sp = new SentenceSpeaker();
    sp.update('一つ目の文です。');
    sp.stop();
    sp.update('一つ目の文です。二つ目の文です。');
    expect(synth).toHaveBeenCalledTimes(1);
    await expect(sp.idle).resolves.toBeUndefined();
  });
});

describe('looksLikeEcho', () => {
  it('flags a transcript of our own speech', () => {
    expect(looksLikeEcho('本日の東京は晴れの予報です', 'はい。本日の東京は晴れの予報です。')).toBe(true);
  });
  it('keeps a genuine interruption', () => {
    expect(looksLikeEcho('ちょっと待って、明日の予定は？', 'はい。本日の東京は晴れの予報です。')).toBe(false);
  });
});
