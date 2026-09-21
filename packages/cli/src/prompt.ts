// Interactive input on top of one readline interface per process: line prompts, hidden
// (password) prompts, and Ctrl+C as an event instead of a crash. On a non-TTY stdin the same
// calls read lines, so scripts and tests can pipe answers.
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface PromptStreams {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
}

export class Prompter {
  private rl: Interface | undefined;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private readonly interruptHandlers: Array<() => void> = [];
  private closed = false;
  private muted = false;
  readonly isTTY: boolean;

  constructor(private readonly streams: PromptStreams) {
    this.isTTY = streams.input.isTTY === true && streams.output.isTTY === true;
  }

  /** Register a Ctrl+C handler (readline's SIGINT on a terminal). Returns the remover. */
  onInterrupt(handler: () => void): () => void {
    this.interruptHandlers.push(handler);
    this.interface();
    return () => {
      const i = this.interruptHandlers.indexOf(handler);
      if (i >= 0) this.interruptHandlers.splice(i, 1);
    };
  }

  /** Ask one line. Resolves `null` at end of input. */
  ask(question: string, options: { hidden?: boolean } = {}): Promise<string | null> {
    const rl = this.interface();
    // Input already ended: lines that arrived before the end are still answers.
    if (this.closed && this.lines.length === 0) return Promise.resolve(null);
    if (this.isTTY) {
      rl.setPrompt(question);
      rl.prompt();
      this.muted = options.hidden === true;
    } else {
      this.streams.output.write(question);
    }
    return this.nextLine().finally(() => {
      if (this.muted) {
        this.muted = false;
        this.streams.output.write('\n');
      }
    });
  }

  close(): void {
    this.closed = true;
    this.rl?.close();
    this.rl = undefined;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  private interface(): Interface {
    if (this.rl) return this.rl;
    const rl = createInterface({
      input: this.streams.input,
      ...(this.isTTY ? { output: this.streams.output, terminal: true } : { terminal: false }),
      historySize: 0,
    });
    // Hidden input: keep readline's editing but swallow its echo while a password is typed.
    const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = internal._writeToOutput;
    if (original) {
      internal._writeToOutput = (text: string) => {
        if (!this.muted) original.call(rl, text);
      };
    }
    rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
    rl.on('SIGINT', () => {
      if (this.interruptHandlers.length === 0) {
        this.close();
        return;
      }
      for (const handler of [...this.interruptHandlers]) handler();
    });
    this.rl = rl;
    return rl;
  }

  private nextLine(): Promise<string | null> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
