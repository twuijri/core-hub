// The entry point behind `bin.ts`: parse, dispatch, translate errors, return the exit code.
// Streams and env are injected so the integration test runs the CLI in-process.
import { readFileSync } from 'node:fs';
import { parseInvocation, renderHelp, type CommandSpec } from './args.js';
import {
  agentsGetCommand,
  agentsInstallCommand,
  agentsListCommand,
  agentsRemoveCommand,
} from './commands/agents.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/auth.js';
import { chatCommand } from './commands/chat.js';
import { pairClaimCommand, pairCommand } from './commands/pair.js';
import {
  sessionsDeleteCommand,
  sessionsListCommand,
  sessionsNewCommand,
  sessionsShowCommand,
} from './commands/sessions.js';
import { ConfigStore, defaultConfigPath } from './config.js';
import type { CommandContext, Io } from './context.js';
import { EXIT_OK, EXIT_USAGE, UsageError, describeError, exitCodeOf } from './errors.js';
import { createTranslator, resolveLanguage } from './i18n/index.js';
import { Printer, detectColor } from './output.js';
import { Prompter } from './prompt.js';

const helpCommand: CommandSpec = {
  path: ['help'],
  description: 'cmd.help',
  positionals: [{ name: 'COMMAND', description: 'arg.command', required: false }],
  async run() {
    return EXIT_OK;
  },
};

export const COMMANDS: readonly CommandSpec[] = [
  loginCommand,
  logoutCommand,
  whoamiCommand,
  pairCommand,
  pairClaimCommand,
  agentsListCommand,
  agentsGetCommand,
  agentsInstallCommand,
  agentsRemoveCommand,
  sessionsListCommand,
  sessionsNewCommand,
  sessionsShowCommand,
  sessionsDeleteCommand,
  chatCommand,
  helpCommand,
];

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function processIo(): Io {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env };
}

export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  let language = resolveLanguage(undefined, io.env);
  let t = createTranslator(language);
  let out = new Printer(io.stdout, io.stderr, { color: detectColor(io.env, io.stderr, false) });
  let prompter: Prompter | undefined;
  try {
    const invocation = parseInvocation(argv, COMMANDS);
    language = resolveLanguage(invocation.globals.lang, io.env);
    t = createTranslator(language);
    out = new Printer(io.stdout, io.stderr, {
      color: detectColor(io.env, io.stdout, invocation.globals.noColor),
    });
    const version = readVersion();
    if (invocation.globals.version) {
      out.line(version);
      return EXIT_OK;
    }
    const { command } = invocation;
    if (!command) {
      if (invocation.globals.help) {
        out.write(renderHelp(t, COMMANDS));
        return EXIT_OK;
      }
      throw new UsageError(argv.length === 0 ? 'usage.no_command' : 'usage.unknown_command', {
        command: argv.find((a) => !a.startsWith('-')) ?? '',
      });
    }
    if (command === helpCommand) {
      const target = invocation.positionals[0];
      const found = target
        ? COMMANDS.find((c) => c.path.join(' ') === target || c.path[0] === target)
        : undefined;
      if (target && !found) throw new UsageError('usage.unknown_command', { command: target });
      out.write(renderHelp(t, COMMANDS, found));
      return EXIT_OK;
    }
    if (invocation.globals.help) {
      out.write(renderHelp(t, COMMANDS, command));
      return EXIT_OK;
    }
    prompter = new Prompter({ input: io.stdin, output: io.stderr });
    const ctx: CommandContext = {
      options: invocation.options,
      positionals: invocation.positionals,
      globals: invocation.globals,
      language,
      t,
      io,
      out,
      store: new ConfigStore(invocation.globals.config ?? defaultConfigPath(io.env)),
      prompter,
      version,
    };
    return await command.run(ctx);
  } catch (error) {
    out.error(describeError(error, t));
    const code = exitCodeOf(error);
    if (code === EXIT_USAGE) out.notice(t('usage.see'));
    return code;
  } finally {
    prompter?.close();
  }
}
