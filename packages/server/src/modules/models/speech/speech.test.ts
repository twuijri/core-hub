/**
 * Long text for a provider with a small request limit (DECISIONS §87): cut at the best
 * boundary, in order, and the parts' audio joined into one file.
 */
import { describe, expect, it } from 'vitest';
import { joinAudio, readWav } from './audio.js';
import { splitForSpeech } from './split.js';

function wav(samples: number[], rate = 24_000): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  out.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
  return out;
}

describe('splitForSpeech', () => {
  it('leaves text within the limit whole', () => {
    expect(splitForSpeech('  Hello there.  ', 200)).toEqual(['Hello there.']);
    expect(splitForSpeech('   ', 200)).toEqual([]);
  });

  it('cuts at sentence ends first, in Arabic and Latin, keeping every word in order', () => {
    const text = 'الجملة الأولى هنا. هل هذه الثانية؟ نعم! And an English one. 最后一句。';
    const parts = splitForSpeech(text, 40);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(40);
    expect(parts[0]).toBe('الجملة الأولى هنا. هل هذه الثانية؟ نعم!');
    expect(parts.join(' ')).toBe(text);
  });

  it('falls back to clauses, then words, and cuts only a word longer than the limit', () => {
    const clauses = 'one two three, four five six, seven eight nine';
    expect(splitForSpeech(clauses, 16)).toEqual([
      'one two three,',
      'four five six,',
      'seven eight nine',
    ]);
    const words = 'alpha beta gamma delta epsilon';
    expect(splitForSpeech(words, 12)).toEqual(['alpha beta', 'gamma delta', 'epsilon']);
    expect(splitForSpeech('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps a long reply under Groq’s 200 characters', () => {
    const reply = Array.from(
      { length: 30 },
      (_, index) => `هذه الجملة رقم ${index + 1} في الرد.`,
    ).join(' ');
    const parts = splitForSpeech(reply, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(200);
    expect(parts.join(' ')).toBe(reply);
  });
});

describe('joinAudio', () => {
  it('lays WAV samples end to end under one header', () => {
    const joined = joinAudio([
      { audio: wav([1, 2]), contentType: 'audio/wav' },
      { audio: wav([3]), contentType: 'audio/wav' },
      { audio: wav([4, 5, 6]), contentType: 'audio/wav' },
    ]);
    expect(joined.contentType).toBe('audio/wav');
    const layout = readWav(joined.audio)!;
    const view = new DataView(layout.data.buffer, layout.data.byteOffset, layout.data.byteLength);
    const samples = Array.from({ length: layout.data.length / 2 }, (_, i) =>
      view.getInt16(i * 2, true),
    );
    expect(samples).toEqual([1, 2, 3, 4, 5, 6]);
    const header = new DataView(joined.audio.buffer);
    expect(header.getUint32(4, true)).toBe(joined.audio.length - 8);
  });

  it('refuses WAV parts in different formats rather than play them at the wrong speed', () => {
    expect(() =>
      joinAudio([
        { audio: wav([1], 24_000), contentType: 'audio/wav' },
        { audio: wav([2], 16_000), contentType: 'audio/wav' },
      ]),
    ).toThrow(/different formats/);
  });

  it('concatenates MP3 parts', () => {
    const joined = joinAudio([
      { audio: new Uint8Array([1, 2]), contentType: 'audio/mpeg' },
      { audio: new Uint8Array([3]), contentType: 'audio/mpeg' },
    ]);
    expect([...joined.audio]).toEqual([1, 2, 3]);
    expect(joined.contentType).toBe('audio/mpeg');
  });
});
