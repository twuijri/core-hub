// What every command receives. Streams and env are injected so tests run `main()` in-process.
import type { Readable, Writable } from 'node:stream';
import type { ConfigStore } from './config.js';
import type { Language, Translator } from './i18n/index.js';
import type { Printer } from './output.js';
import type { Prompter } from './prompt.js';

export interface Io {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
}

export interface GlobalValues {
  server: string | undefined;
  profile: string | undefined;
  json: boolean;
  strict: boolean;
  lang: string | undefined;
  config: string | undefined;
  noColor: boolean;
  help: boolean;
  version: boolean;
}

export type OptionValue = string | boolean | undefined;

export interface CommandContext {
  options: Record<string, OptionValue>;
  positionals: string[];
  globals: GlobalValues;
  language: Language;
  t: Translator;
  io: Io;
  out: Printer;
  store: ConfigStore;
  prompter: Prompter;
  version: string;
}
