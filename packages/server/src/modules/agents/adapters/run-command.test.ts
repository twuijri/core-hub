/**
 * `runCommand` — how the hub asks an agent's CLI something (a health check, a version).
 *
 * The owner's hub of 2026-09-29 restarted in a loop: `claude-code-acp --version` ignores the
 * flag, serves its protocol on stdin and keeps itself alive reading it, so with stdin held
 * open it only ended at the 30 s deadline — while the hub was mounting. A command now gets a
 * closed stdin, and a deadline stops its whole process group.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from './host.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'corehub-run-command-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')('runCommand', () => {
  it('gives the program a closed stdin, so a bridge that serves stdin ends at once', async () => {
    // Like `claude-code-acp`: it reads its input until the end, whatever the flag says.
    const bridge = script('bridge', 'cat >/dev/null\necho "bridge 0.16.2"');
    const began = Date.now();
    const result = await runCommand([bridge, '--version'], { timeoutMs: 20_000 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: true, error: null });
    expect(result.stdout).toContain('bridge 0.16.2');
  });

  it('stops a program that never ends at the deadline, with its helpers, and says so', async () => {
    const pidFile = path.join(dir, 'helper.pid');
    const hang = script('hang', `sleep 600 &\necho $! > "${pidFile}"\nwait`);
    const began = Date.now();
    const result = await runCommand([hang, '--version'], { timeoutMs: 400 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not finish within 0\.4 s/);
    const helper = Number(readFileSync(pidFile, 'utf8').trim());
    // The group was killed: the helper the program started does not outlive it.
    for (let i = 0; i < 20 && alive(helper); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(helper)).toBe(false);
  });

  it('reports a failing program with its output, and a missing one without throwing', async () => {
    const fails = script('fails', 'echo "no such flag" >&2\nexit 3');
    const failed = await runCommand([fails, '--version']);
    expect(failed).toMatchObject({ ok: false, stderr: 'no such flag\n' });
    expect(failed.error).toMatch(/exit code 3/);
    const missing = await runCommand([path.join(dir, 'nothing-here')]);
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/ENOENT/);
  });
});
