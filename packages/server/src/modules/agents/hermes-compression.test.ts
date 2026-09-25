/**
 * A profile's automatic compression in Hermes's own `config.yaml` (decision §57): the keys
 * Hermes reads, its defaults when they are absent, and a write that leaves the rest of the
 * file as it was.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  HERMES_COMPRESSION_DEFAULTS,
  HermesCompressionError,
  readHermesCompression,
  writeHermesCompression,
} from './hermes-compression.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hermes-compression-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = () => path.join(home, 'config.yaml');

describe("Hermes's compression keys", () => {
  it("reads Hermes's defaults when the file names none, or does not exist", () => {
    expect(readHermesCompression(home)).toEqual(HERMES_COMPRESSION_DEFAULTS);
    writeFileSync(file(), '');
    expect(readHermesCompression(home)).toEqual(HERMES_COMPRESSION_DEFAULTS);
  });

  it('reads the keys Hermes reads, as Hermes reads them', () => {
    writeFileSync(
      file(),
      [
        'model:',
        '  default: gpt-5',
        '  context_length: 131072',
        'compression:',
        '  enabled: "no"',
        '  threshold: 0.8',
        '  target_ratio: "0.3"',
        '  protect_first_n: 2',
        '  protect_last_n: 12',
        '',
      ].join('\n'),
    );
    expect(readHermesCompression(home)).toEqual({
      enabled: false,
      threshold: 0.8,
      targetRatio: 0.3,
      protectFirst: 2,
      protectLast: 12,
      contextLength: 131_072,
    });
  });

  it('writes only its keys, keeping comments and everything else', () => {
    writeFileSync(
      file(),
      [
        '# the owner wrote this',
        'model:',
        '  default: gpt-5',
        '  provider: openai',
        'compression:',
        '  tail_mode: lean # keep',
        'mcp_servers: {}',
        '',
      ].join('\n'),
    );
    writeHermesCompression(home, {
      enabled: true,
      threshold: 0.7,
      targetRatio: 0.25,
      protectFirst: 3,
      protectLast: 30,
      contextLength: 64_000,
    });
    const text = readFileSync(file(), 'utf8');
    expect(text).toContain('# the owner wrote this');
    expect(text).toContain('tail_mode: lean # keep');
    const config = parse(text) as Record<string, Record<string, unknown>>;
    expect(config.model).toEqual({ default: 'gpt-5', provider: 'openai', context_length: 64_000 });
    expect(config.compression).toEqual({
      tail_mode: 'lean',
      enabled: true,
      threshold: 0.7,
      target_ratio: 0.25,
      protect_first_n: 3,
      protect_last_n: 30,
    });
    expect(config.mcp_servers).toEqual({});

    // Clearing the window removes Hermes's key, which means "the model's own".
    writeHermesCompression(home, { ...readHermesCompression(home), contextLength: null });
    expect((parse(readFileSync(file(), 'utf8')) as { model: unknown }).model).toEqual({
      default: 'gpt-5',
      provider: 'openai',
    });
  });

  it("keeps a one-line model as Hermes's own default, and starts an empty file", () => {
    writeFileSync(file(), 'model: claude-sonnet\n');
    writeHermesCompression(home, { ...HERMES_COMPRESSION_DEFAULTS, contextLength: 100_000 });
    expect((parse(readFileSync(file(), 'utf8')) as { model: unknown }).model).toEqual({
      default: 'claude-sonnet',
      context_length: 100_000,
    });

    writeFileSync(file(), '');
    writeHermesCompression(home, HERMES_COMPRESSION_DEFAULTS);
    expect(readHermesCompression(home)).toEqual(HERMES_COMPRESSION_DEFAULTS);
  });

  it('never rewrites a file that is not YAML Hermes could read', () => {
    writeFileSync(file(), 'model: [unclosed\n');
    expect(() => readHermesCompression(home)).toThrow(HermesCompressionError);
    expect(() => writeHermesCompression(home, HERMES_COMPRESSION_DEFAULTS)).toThrow(
      HermesCompressionError,
    );
    expect(readFileSync(file(), 'utf8')).toBe('model: [unclosed\n');
  });
});
