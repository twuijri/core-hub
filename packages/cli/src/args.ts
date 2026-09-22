// Argument parsing on `node:util` parseArgs: a declarative command table, global options
// anywhere on the line, strict rejection of unknown options, and a hard refusal of secrets
// (`--password`, `--token`) as arguments. Errors are `UsageError` (exit 2).
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { CommandContext, GlobalValues, OptionValue } from './context.js';
import { UsageError } from './errors.js';
import type { Translator } from './i18n/index.js';

export interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  /** i18n key of the description. */
  description: string;
  /** Placeholder shown in help for string options. */
  value?: string;
  /** May be repeated (`--attach a --attach b`); the value arrives as an array. */
  multiple?: boolean;
}

export interface PositionalSpec {
  name: string;
  /** i18n key of the description. */
  description: string;
  required: boolean;
}

export interface CommandSpec {
  path: readonly string[];
  /** i18n key of the one-line description. */
  description: string;
  positionals?: readonly PositionalSpec[];
  options?: Readonly<Record<string, OptionSpec>>;
  run(ctx: CommandContext): Promise<number>;
}

export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  server: { type: 'string', description: 'option.server', value: 'URL' },
  profile: { type: 'string', description: 'option.profile', value: 'SLUG' },
  json: { type: 'boolean', description: 'option.json' },
  strict: { type: 'boolean', description: 'option.strict' },
  lang: { type: 'string', description: 'option.lang', value: 'ar|en' },
  config: { type: 'string', description: 'option.config', value: 'PATH' },
  'no-color': { type: 'boolean', description: 'option.no_color' },
  help: { type: 'boolean', short: 'h', description: 'option.help' },
  version: { type: 'boolean', short: 'V', description: 'option.version' },
};

/** Never accepted on the command line, whatever the command. */
export const SECRET_OPTIONS = ['password', 'token', 'refresh-token', 'app-token'] as const;

export interface Invocation {
  command: CommandSpec | undefined;
  globals: GlobalValues;
  options: Record<string, OptionValue>;
  positionals: string[];
}

type ParseOptions = NonNullable<ParseArgsConfig['options']>;

function toParseOptions(specs: Readonly<Record<string, OptionSpec>>): ParseOptions {
  const out: ParseOptions = {};
  for (const [name, spec] of Object.entries(specs))
    out[name] = {
      type: spec.type,
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
    };
  return out;
}

function mergedOptions(commands: readonly CommandSpec[]): Readonly<Record<string, OptionSpec>> {
  const merged: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS };
  for (const command of commands)
    for (const [name, spec] of Object.entries(command.options ?? {})) {
      const existing = merged[name];
      if (existing && existing.type !== spec.type)
        throw new Error(`option --${name} is declared with two types across commands`);
      merged[name] = spec;
    }
  return merged;
}

export function findCommand(
  words: readonly string[],
  commands: readonly CommandSpec[],
): CommandSpec | undefined {
  const sorted = [...commands].sort((a, b) => b.path.length - a.path.length);
  return sorted.find(
    (command) =>
      command.path.length <= words.length && command.path.every((word, i) => words[i] === word),
  );
}

export function parseInvocation(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): Invocation {
  for (const token of argv) {
    const match = /^--([a-z-]+)(=|$)/.exec(token);
    if (match && (SECRET_OPTIONS as readonly string[]).includes(match[1] ?? ''))
      throw new UsageError('usage.secret_argument', { option: `--${match[1]}` });
    if (token === '--') break;
  }

  // Pass 1 (lax): find the command words among the positionals.
  const lax = parseArgs({
    args: [...argv],
    options: toParseOptions(mergedOptions(commands)),
    strict: false,
    allowPositionals: true,
  });
  const command = findCommand(lax.positionals, commands);

  // Pass 2 (strict): only the global options and the command's own are legal.
  const specs = { ...GLOBAL_OPTIONS, ...(command?.options ?? {}) };
  let strict: ReturnType<typeof parseArgs>;
  try {
    strict = parseArgs({
      args: [...argv],
      options: toParseOptions(specs),
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const option = /'(-[^']+)'/.exec(message)?.[1] ?? '?';
      throw new UsageError('usage.unknown_option', { option });
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const option = /'(-[^']+)'/.exec(message)?.[1] ?? '?';
      throw new UsageError('usage.invalid_option', { option, value: '' });
    }
    throw error;
  }

  const values = strict.values as Record<string, OptionValue>;
  const globals: GlobalValues = {
    server: stringOrUndefined(values.server),
    profile: stringOrUndefined(values.profile),
    json: values.json === true,
    strict: values.strict === true,
    lang: stringOrUndefined(values.lang),
    config: stringOrUndefined(values.config),
    noColor: values['no-color'] === true,
    help: values.help === true,
    version: values.version === true,
  };
  const options: Record<string, OptionValue> = {};
  for (const name of Object.keys(command?.options ?? {})) options[name] = values[name];

  const positionals = strict.positionals.slice(command?.path.length ?? 0);
  if (command && !globals.help) {
    const specsList = command.positionals ?? [];
    for (const [i, spec] of specsList.entries())
      if (spec.required && positionals[i] === undefined)
        throw new UsageError('usage.missing_argument', { name: spec.name });
    if (positionals.length > specsList.length)
      throw new UsageError('usage.extra_argument', { value: positionals[specsList.length] ?? '' });
  }
  return { command, globals, options, positionals };
}

function stringOrUndefined(value: OptionValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionLine(name: string, spec: OptionSpec): string {
  const short = spec.short ? `-${spec.short}, ` : '    ';
  const value = spec.type === 'string' ? ` ${spec.value ?? 'VALUE'}` : '';
  return `${short}--${name}${value}`;
}

function aligned(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

export function renderHelp(
  t: Translator,
  commands: readonly CommandSpec[],
  command?: CommandSpec,
): string {
  const lines: string[] = [];
  if (command) {
    const args = (command.positionals ?? [])
      .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
      .join(' ');
    lines.push(`majlis ${command.path.join(' ')}${args ? ` ${args}` : ''}`);
    lines.push(`  ${t(command.description)}`);
    if (command.positionals?.length) {
      lines.push('', t('usage.arguments'));
      lines.push(...aligned(command.positionals.map((p) => [p.name, t(p.description)] as const)));
    }
    if (command.options && Object.keys(command.options).length > 0) {
      lines.push('', t('usage.options'));
      lines.push(
        ...aligned(
          Object.entries(command.options).map(
            ([name, spec]) => [optionLine(name, spec), t(spec.description)] as const,
          ),
        ),
      );
    }
  } else {
    lines.push(t('app.tagline'), '', t('usage.synopsis'), '', t('usage.commands'));
    lines.push(...aligned(commands.map((c) => [c.path.join(' '), t(c.description)] as const)));
  }
  lines.push('', t('usage.global_options'));
  lines.push(
    ...aligned(
      Object.entries(GLOBAL_OPTIONS).map(
        ([name, spec]) => [optionLine(name, spec), t(spec.description)] as const,
      ),
    ),
  );
  lines.push('', t('usage.exit_codes'));
  if (!command) lines.push(t('usage.see'));
  return `${lines.join('\n')}\n`;
}
