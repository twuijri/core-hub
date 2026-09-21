import { describe, expect, it } from 'vitest';
import { findCommand, parseInvocation, renderHelp } from '../src/args.js';
import { EXIT_USAGE, UsageError } from '../src/errors.js';
import { createTranslator } from '../src/i18n/index.js';
import { COMMANDS } from '../src/main.js';

const usage = (argv: string[]) => {
  try {
    parseInvocation(argv, COMMANDS);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('parseInvocation', () => {
  it('finds nested commands and keeps only their own positionals', () => {
    const inv = parseInvocation(
      ['sessions', 'show', '01J8QK3ZR2W7M5N4P6T8V9X0YA', '--json'],
      COMMANDS,
    );
    expect(inv.command?.path).toEqual(['sessions', 'show']);
    expect(inv.positionals).toEqual(['01J8QK3ZR2W7M5N4P6T8V9X0YA']);
    expect(inv.globals.json).toBe(true);
  });

  it('accepts global options before and after the command', () => {
    const inv = parseInvocation(
      ['--server', 'http://hub', 'chat', 'ID', '--message', 'hi there', '--once', '--lang', 'ar'],
      COMMANDS,
    );
    expect(inv.command?.path).toEqual(['chat']);
    expect(inv.globals.server).toBe('http://hub');
    expect(inv.globals.lang).toBe('ar');
    expect(inv.options).toMatchObject({ message: 'hi there', once: true });
  });

  it('prefers the longest command path', () => {
    expect(findCommand(['pair', 'claim', 'X'], COMMANDS)?.path).toEqual(['pair', 'claim']);
    expect(findCommand(['pair'], COMMANDS)?.path).toEqual(['pair']);
    expect(findCommand(['nothing'], COMMANDS)).toBeUndefined();
  });

  it('refuses secrets on the command line, whatever the command', () => {
    for (const argv of [
      ['login', '--password', 'x'],
      ['login', '--password=x'],
      ['whoami', '--token', 'hub_at_x'],
    ]) {
      const error = usage(argv);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).key).toBe('usage.secret_argument');
      expect((error as UsageError).exitCode).toBe(EXIT_USAGE);
    }
  });

  it('rejects unknown options with exit 2 and names them', () => {
    const error = usage(['whoami', '--bogus']) as UsageError;
    expect(error.key).toBe('usage.unknown_option');
    expect(error.params).toEqual({ option: '--bogus' });
  });

  it('rejects an option that belongs to another command', () => {
    expect((usage(['whoami', '--message', 'x']) as UsageError).key).toBe('usage.unknown_option');
  });

  it('reports missing and extra positionals', () => {
    expect((usage(['chat']) as UsageError).params).toEqual({ name: 'SESSION_ID' });
    expect((usage(['whoami', 'extra']) as UsageError).key).toBe('usage.extra_argument');
  });

  it('does not demand positionals when help is asked', () => {
    expect(parseInvocation(['chat', '--help'], COMMANDS).globals.help).toBe(true);
  });
});

describe('renderHelp', () => {
  it.each(['en', 'ar'] as const)('lists every command with a translated line (%s)', (language) => {
    const t = createTranslator(language);
    const text = renderHelp(t, COMMANDS);
    for (const command of COMMANDS) expect(text).toContain(command.path.join(' '));
    expect(text).not.toMatch(/\b(cmd|option|usage)\.[a-z_]+/);
    expect(
      renderHelp(
        t,
        COMMANDS,
        COMMANDS.find((c) => c.path[0] === 'chat'),
      ),
    ).toContain('--message');
  });
});
