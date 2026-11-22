import { describe, expect, it, vi } from 'vitest';
import { ConsentGate, dialogCommand, systemAsker, type ConsentQuestion } from '../src/consent.js';

const question = (
  key = 'program:a',
  session: string | null = 'Allow for this session',
): ConsentQuestion => ({
  key,
  title: 'Core Hub',
  message: 'The agent "x" wants…',
  labels: { once: 'Allow once', session, deny: 'Deny' },
});

describe('ConsentGate', () => {
  it('asks once per session per program when the person says "for this session"', async () => {
    const ask = vi.fn(async () => 'session' as const);
    const gate = new ConsentGate(ask);
    expect(await gate.check(question())).toBe(true);
    expect(await gate.check(question())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await gate.check(question('program:b'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks again after "once", after a deny, and after the settings change', async () => {
    const answers = ['once', 'deny', 'session', 'session'] as const;
    let i = 0;
    const gate = new ConsentGate(async () => answers[i++]!);
    expect(await gate.check(question())).toBe(true);
    expect(await gate.check(question())).toBe(false);
    expect(await gate.check(question())).toBe(true);
    expect(gate.allowedForSession('program:a')).toBe(true);
    gate.forget();
    expect(gate.allowedForSession('program:a')).toBe(false);
  });

  it('asks every time for a screen task, even after "session"', async () => {
    const ask = vi.fn(async () => 'session' as const);
    const gate = new ConsentGate(ask);
    await gate.check(question('screen_task', null), { everyTime: true });
    await gate.check(question('screen_task', null), { everyTime: true });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('counts a failing prompt as deny, and asks one question at a time', async () => {
    let open = 0;
    let most = 0;
    const gate = new ConsentGate(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open -= 1;
      throw new Error('no display');
    });
    const results = await Promise.all([gate.check(question('a')), gate.check(question('b'))]);
    expect(results).toEqual([false, false]);
    expect(most).toBe(1);
  });
});

describe('the OS dialog', () => {
  const linux = {
    platform: 'linux' as const,
    vars: { DISPLAY: ':0' },
    exists: (f: string) => f === '/usr/bin/zenity',
  };

  it('reads macOS buttons', () => {
    const c = dialogCommand(question(), { platform: 'darwin', vars: {}, exists: () => true })!;
    expect(c.file).toBe('/usr/bin/osascript');
    expect(c.read({ code: 0, stdout: 'Allow for this session\n' })).toBe('session');
    expect(c.read({ code: 0, stdout: 'Allow once\n' })).toBe('once');
    expect(c.read({ code: 1, stdout: '' })).toBe('deny');
    expect(c.read({ code: 0, stdout: '' })).toBe('deny');
  });

  it('reads Windows message box answers', () => {
    const c = dialogCommand(question(), {
      platform: 'win32',
      vars: { SystemRoot: 'C:\\Windows' },
      exists: () => true,
    })!;
    expect(c.file).toMatch(/powershell\.exe$/);
    expect(c.read({ code: 0, stdout: 'Yes' })).toBe('session');
    expect(c.read({ code: 0, stdout: 'No' })).toBe('once');
    expect(c.read({ code: 0, stdout: 'Cancel' })).toBe('deny');
  });

  it('reads zenity, and has nothing to show without a display', () => {
    const c = dialogCommand(question(), linux)!;
    expect(c.read({ code: 0, stdout: '' })).toBe('once');
    expect(c.read({ code: 1, stdout: 'Allow for this session\n' })).toBe('session');
    expect(c.read({ code: 1, stdout: '' })).toBe('deny');
    expect(dialogCommand(question(), { ...linux, vars: {} })).toBeNull();
  });

  it('says deny when the computer cannot ask', async () => {
    const asker = systemAsker({ platform: 'linux', vars: {}, exists: () => false, exec: vi.fn() });
    expect(await asker(question())).toBe('deny');
  });
});
