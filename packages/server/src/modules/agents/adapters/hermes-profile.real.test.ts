/**
 * A conversation runs in **its own Hermes profile** (ADR 0014 stage 3), with the real Hermes.
 *
 * One `python -m tui_gateway.entry` from the image serves two profiles: the root home
 * (Hermes's `default`) and a named profile `b` that Hermes itself created. Each has its own
 * `SOUL.md` and `memories/MEMORY.md` with a fact nobody else knows. A scripted
 * OpenAI-compatible model on this machine reports which of those facts reached it, so the
 * test sees exactly what Hermes put in front of the model — no key, no network beyond the
 * loopback. The provider key is only in the process environment, never in a profile's
 * `.env`: that is how the hub's shared keys reach every profile (ADR 0010).
 *
 *   COREHUB_HERMES_IMAGE=corehub:local pnpm --filter @corehub/server test hermes-profile.real
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHermesProfiles, type ProfileRunner } from '../hermes-profiles.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

const FACTS = {
  soulDefault: 'heron-soul-1203',
  memoryDefault: 'heron-memory-1188',
  soulB: 'orchid-soul-7741',
  memoryB: 'orchid-memory-5521',
} as const;

/** The model: answers with the facts Hermes put in front of it, and nothing else. */
function reportingModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
      const seen = Object.values(FACTS).filter((fact) => raw.includes(fact));
      const reply = `saw=${seen.length ? seen.join(',') : 'none'}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of [{ role: 'assistant', content: reply }, {}]) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake-1',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

/** What the hub's propagation writes into every profile: the route, never the key. */
function configFor(port: number): string {
  return [
    'providers:',
    '  corehub-fake:',
    '    name: corehub-fake',
    `    base_url: http://127.0.0.1:${port}/v1`,
    '    key_env: COREHUB_FAKE_KEY',
    '    api_mode: chat_completions',
    'model:',
    '  default: fake-1',
    '  provider: corehub-fake',
    '',
  ].join('\n');
}

describe.skipIf(!image)(
  'Hermes profiles in conversations (real Hermes; set COREHUB_HERMES_IMAGE)',
  () => {
    let model: http.Server;
    let home: string;
    let channel: TuiChannel;

    const hermes: ProfileRunner = (argv) =>
      new Promise((resolve) => {
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${home}:/hh`,
            '-e',
            'HERMES_HOME=/hh',
            '--entrypoint',
            '/opt/hermes/.venv/bin/hermes',
            image!,
            ...argv,
          ],
          { timeout: 120_000 },
          (error, stdout, stderr) =>
            resolve({
              code: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout: String(stdout),
              stderr: String(stderr),
            }),
        );
      });

    /** Writes a file inside the container, as the container's user (the home is theirs). */
    const put = (file: string, text: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '-v',
            `${home}:/hh`,
            '--entrypoint',
            'sh',
            image!,
            '-c',
            `mkdir -p "$(dirname "/hh/${file}")" && cat > "/hh/${file}"`,
          ],
          { timeout: 60_000 },
          (error) => (error ? reject(error) : resolve()),
        ).stdin!.end(text);
      });

    beforeAll(async () => {
      model = reportingModel();
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const port = (model.address() as AddressInfo).port;
      home = mkdtempSync(path.join(tmpdir(), 'corehub-profile-chat-'));
      chmodSync(home, 0o777);
      writeFileSync(path.join(home, 'config.yaml'), configFor(port));
      writeFileSync(
        path.join(home, 'SOUL.md'),
        `You are the default agent. ${FACTS.soulDefault}\n`,
      );
      mkdirSync(path.join(home, 'memories'));
      chmodSync(path.join(home, 'memories'), 0o777);
      writeFileSync(path.join(home, 'memories', 'MEMORY.md'), `${FACTS.memoryDefault}\n`);

      // Profile `b`, made by Hermes the way the hub makes one (`hermes-profiles.ts`), then
      // given its own soul and memory — and the provider route, as propagation writes it.
      const profiles = createHermesProfiles({ home, run: hermes });
      await profiles.create('b', { kind: 'blank' });
      await put('profiles/b/config.yaml', configFor(port));
      await put('profiles/b/SOUL.md', `You are the B agent. ${FACTS.soulB}\n`);
      await put('profiles/b/memories/MEMORY.md', `${FACTS.memoryB}\n`);
      await put('work/b/.keep', '');

      channel = stdioTuiChannel({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${home}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
          // The key lives in the process environment only, as the hub hands it over.
          '-e',
          'COREHUB_FAKE_KEY=fake-key-000000000000',
          '--entrypoint',
          '/opt/hermes/.venv/bin/python',
          image!,
          '-m',
          'tui_gateway.entry',
        ],
        env: process.env,
        readyTimeoutMs: 120_000,
      });
    }, 400_000);

    afterAll(async () => {
      await channel?.close();
      model?.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // written by the container's user; the OS reclaims the temp dir
      }
    });

    async function say(session: HermesTuiSession, text: string): Promise<string> {
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.type === 'run.completed' || event.type === 'run.failed') return;
        }
      })();
      await session.send({ text });
      await reading;
      expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
      return events
        .filter(
          (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
        )
        .map((e) => e.text)
        .join('');
    }

    it("a conversation in profile b reads b's soul and memory, and nobody else's", async () => {
      const session = await HermesTuiSession.open(channel, null, {
        profile: 'b',
        cwd: '/hh/work/b',
      });
      const said = await say(session, 'what do you know?');
      expect(said).toContain(FACTS.soulB);
      expect(said).toContain(FACTS.memoryB);
      expect(said).not.toContain(FACTS.soulDefault);
      expect(said).not.toContain(FACTS.memoryDefault);
      // Stored in b's own store, not the default one.
      expect(existsSync(path.join(home, 'profiles', 'b', 'state.db'))).toBe(true);

      // Continued by its stored id, still in b.
      const stored = session.id;
      await session.close();
      const again = await HermesTuiSession.open(channel, stored, { profile: 'b' });
      expect(again.id).toBe(stored);
      expect(await say(again, 'and now?')).toContain(FACTS.memoryB);
      await again.close();
    }, 240_000);

    it("the same process serves the default profile with the default's soul and memory", async () => {
      for (const profile of [null, 'default']) {
        const session = await HermesTuiSession.open(channel, null, { profile });
        const said = await say(session, 'what do you know?');
        expect(said).toContain(FACTS.soulDefault);
        expect(said).toContain(FACTS.memoryDefault);
        expect(said).not.toContain(FACTS.soulB);
        expect(said).not.toContain(FACTS.memoryB);
        await session.close();
      }
    }, 240_000);

    it('a profile made as a copy of the default one — how a missing profile is made — answers', async () => {
      const profiles = createHermesProfiles({ home, run: hermes });
      await profiles.create('c', { kind: 'clone', source: 'default' });
      const session = await HermesTuiSession.open(channel, null, { profile: 'c' });
      const said = await say(session, 'who are you?');
      // Hermes's clone copies the config, the soul and — in this Hermes — `memories/MEMORY.md`
      // as it stood (`hermes_cli/profiles.py` §_CLONE_SUBDIR_FILES): a workspace that ran in
      // the default profile until now keeps what it knew. Nothing of b's.
      expect(said).toContain(FACTS.soulDefault);
      expect(said).toContain(FACTS.memoryDefault);
      expect(said).not.toContain(FACTS.soulB);
      expect(said).not.toContain(FACTS.memoryB);
      await session.close();
    }, 240_000);
  },
);
