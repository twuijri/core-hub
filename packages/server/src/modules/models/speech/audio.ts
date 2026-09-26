/**
 * The audio of several speech requests, joined into one file in order (DECISIONS §92).
 *
 * - **WAV** (Groq's only format): every part is a RIFF file with its own header. The samples
 *   of each part's `data` chunk are laid end to end under the first part's `fmt ` chunk, and
 *   the sizes in the header are rewritten. Parts in a different sample format cannot be
 *   joined that way; they are refused rather than played at the wrong speed.
 * - **MP3** and the other frame-based formats: the parts are concatenated. An MP3 stream is a
 *   run of self-describing frames, and players read two files back to back as one.
 */

export interface AudioPart {
  audio: Uint8Array;
  contentType: string;
}

interface WavLayout {
  /** The `fmt ` chunk, header included. */
  fmt: Uint8Array;
  data: Uint8Array;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** The `fmt ` and `data` chunks of a RIFF/WAVE file, or null when it is not one. */
export function readWav(bytes: Uint8Array): WavLayout | null {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at);
    let size = view.getUint32(at + 4, true);
    const body = at + 8;
    // A streamed WAV may carry 0 or 0xFFFFFFFF as the data size: it runs to the end.
    if (id === 'data' && (size === 0 || size === 0xffffffff || body + size > bytes.length)) {
      size = bytes.length - body;
    }
    if (id === 'fmt ') fmt = bytes.subarray(at, body + size);
    if (id === 'data') data = bytes.subarray(body, body + size);
    at = body + size + (size % 2);
  }
  return fmt && data ? { fmt, data } : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function joinWav(parts: readonly Uint8Array[]): Uint8Array | null {
  const layouts = parts.map(readWav);
  if (layouts.some((layout) => layout === null)) return null;
  const read = layouts as WavLayout[];
  const fmt = read[0]!.fmt;
  if (read.some((layout) => !sameBytes(layout.fmt, fmt))) return null;
  const dataSize = read.reduce((total, layout) => total + layout.data.length, 0);
  const out = new Uint8Array(12 + fmt.length + 8 + dataSize);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  out.set(fmt, 12);
  const dataAt = 12 + fmt.length;
  out.set([0x64, 0x61, 0x74, 0x61], dataAt); // data
  view.setUint32(dataAt + 4, dataSize, true);
  let at = dataAt + 8;
  for (const layout of read) {
    out.set(layout.data, at);
    at += layout.data.length;
  }
  return out;
}

function isWav(contentType: string): boolean {
  return /wav|wave/i.test(contentType);
}

/**
 * The parts as one file. Throws when WAV parts disagree on their sample format — a joined
 * file that plays at the wrong speed is worse than an error that says so.
 */
export function joinAudio(parts: readonly AudioPart[]): AudioPart {
  if (parts.length === 0) throw new Error('no audio to join');
  if (parts.length === 1) return parts[0]!;
  const contentType = parts[0]!.contentType;
  if (isWav(contentType) || parts.every((part) => readWav(part.audio) !== null)) {
    const joined = joinWav(parts.map((part) => part.audio));
    if (!joined) throw new Error('the audio parts are WAV files in different formats');
    return { audio: joined, contentType: 'audio/wav' };
  }
  const total = parts.reduce((sum, part) => sum + part.audio.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part.audio, at);
    at += part.audio.length;
  }
  return { audio: out, contentType };
}
