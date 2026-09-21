import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Prompter } from '../src/prompt.js';

describe('Prompter on a non-TTY', () => {
  it('reads answers line by line, hidden or not, and reports end of input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString();
    });
    const prompter = new Prompter({ input, output });
    input.write('admin\nsecret\n');
    input.end();
    expect(await prompter.ask('Username: ')).toBe('admin');
    expect(await prompter.ask('Password: ', { hidden: true })).toBe('secret');
    expect(await prompter.ask('More: ')).toBeNull();
    // Nothing is asked once the input has ended.
    expect(written).toBe('Username: Password: ');
    expect(prompter.isTTY).toBe(false);
    prompter.close();
  });
});
