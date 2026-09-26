/**
 * Media in chat (decision §97): a video or a sound of a conversation's working folder, or of the
 * profile's working files, plays and seeks — the reads a player makes are byte ranges.
 *
 * - `sessions.readFile` and `knowledge.downloadWorkspaceFile` answer one `Range` with `206` and
 *   `Content-Range`; one past the end is `416` with `Content-Range: bytes *\/<size>`; a header
 *   that is not one byte range is the whole file;
 * - a video or a sound is listed as `video` / `audio`, with no preview cap worth the name;
 * - `sessions.createFileStream` and `knowledge.createWorkspaceFileStream` give a one-file ticket
 *   a media element plays from without the bearer, byte range by byte range; nothing else
 *   answers to it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { byteRangeOf } from '../../src/lib/byte-range.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { attachmentsPort } from '../../src/modules/knowledge/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { MEDIA_MAX_BYTES } from '../../src/modules/sessions/files.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
type Hub = TestHub & { token: string; userId: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function hub(): Promise<Hub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
    attachments: attachmentsPort,
    scopes: principalScopeResolver,
  });
  const made = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  cleanups.push(() => made.close());
  return made;
}

/** 100 KiB whose every byte says where it is, so a range can be checked byte for byte. */
const VIDEO = Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i % 251));

async function session(h: Hub): Promise<{ id: string; dir: string }> {
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: AGENT_ID },
  });
  expect(created.statusCode, created.body).toBe(201);
  const body = created.json() as { id: string; working_dir: string };
  writeFileSync(path.join(body.working_dir, 'clip.mp4'), VIDEO);
  writeFileSync(path.join(body.working_dir, 'voice.mp3'), Buffer.alloc(2048, 7));
  writeFileSync(path.join(body.working_dir, 'notes.txt'), 'hello');
  return { id: body.id, dir: body.working_dir };
}

describe('one byte range (§97)', () => {
  it('reads a range, a suffix and an open end; past the end cannot be satisfied', () => {
    expect(byteRangeOf(undefined, 100)).toEqual({ kind: 'all' });
    expect(byteRangeOf('bytes=0-9', 100)).toEqual({ kind: 'part', start: 0, end: 9 });
    expect(byteRangeOf('bytes=90-', 100)).toEqual({ kind: 'part', start: 90, end: 99 });
    expect(byteRangeOf('bytes=90-500', 100)).toEqual({ kind: 'part', start: 90, end: 99 });
    expect(byteRangeOf('bytes=-10', 100)).toEqual({ kind: 'part', start: 90, end: 99 });
    expect(byteRangeOf('bytes=-500', 100)).toEqual({ kind: 'part', start: 0, end: 99 });
    expect(byteRangeOf('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(byteRangeOf('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(byteRangeOf('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    // Not one byte range: ignored, the whole file.
    for (const header of ['items=0-9', 'bytes=0-9,20-29', 'bytes=9-0', 'bytes=abc', 'bytes=-']) {
      expect(byteRangeOf(header, 100)).toEqual({ kind: 'all' });
    }
  });
});

describe('a conversation’s working folder (sessions.readFile, sessions.createFileStream)', () => {
  it('lists a video and a sound by their kind, with no preview cap that stops them', async () => {
    const h = await hub();
    const { id } = await session(h);
    const list = await authed(h, h.token, { method: 'GET', url: `/api/v1/sessions/${id}/files` });
    const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get('clip.mp4')).toMatchObject({
      preview: 'video',
      mime: 'video/mp4',
      preview_max_bytes: MEDIA_MAX_BYTES,
    });
    expect(byName.get('voice.mp3')).toMatchObject({ preview: 'audio', mime: 'audio/mpeg' });
  });

  it('answers a range with 206 and exactly those bytes; past the end is 416', async () => {
    const h = await hub();
    const { id } = await session(h);
    const url = `/api/v1/sessions/${id}/files/content?path=clip.mp4`;
    const part = await authed(h, h.token, {
      method: 'GET',
      url,
      headers: { range: 'bytes=1000-1999' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 1000-1999/${VIDEO.length}`);
    expect(part.headers['content-length']).toBe('1000');
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.rawPayload.equals(VIDEO.subarray(1000, 2000))).toBe(true);

    const tail = await authed(h, h.token, { method: 'GET', url, headers: { range: 'bytes=-16' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(VIDEO.subarray(VIDEO.length - 16))).toBe(true);

    const whole = await authed(h, h.token, { method: 'GET', url });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload.equals(VIDEO)).toBe(true);

    const past = await authed(h, h.token, {
      method: 'GET',
      url,
      headers: { range: `bytes=${VIDEO.length}-` },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${VIDEO.length}`);
    expect(past.json()).toMatchObject({
      code: 'bad_request',
      details: { reason: 'range_not_satisfiable', size_bytes: VIDEO.length },
    });

    const garbage = await authed(h, h.token, {
      method: 'GET',
      url,
      headers: { range: 'lines=1-2' },
    });
    expect(garbage.statusCode).toBe(200);
    expect(garbage.rawPayload.length).toBe(VIDEO.length);
  });

  it('plays from a one-file ticket without the bearer, a range at a time', async () => {
    const h = await hub();
    const { id } = await session(h);
    const made = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/sessions/${id}/files/stream`,
      payload: { path: 'clip.mp4' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const { url, expires_at } = made.json() as { url: string; expires_at: string };
    expect(url).toMatch(/^\/api\/v1\/file-streams\/[0-9a-f]{64}$/);
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(55 * 60_000);

    const seek = await h.app.inject({
      method: 'GET',
      url,
      headers: { range: 'bytes=50000-50099' },
    });
    expect(seek.statusCode, seek.body).toBe(206);
    expect(seek.headers['content-range']).toBe(`bytes 50000-50099/${VIDEO.length}`);
    expect(seek.headers['content-type']).toBe('video/mp4');
    expect(seek.headers['cache-control']).toBe('private, no-store');
    expect(String(seek.headers['content-disposition'])).toMatch(/^inline/);
    expect(seek.rawPayload.equals(VIDEO.subarray(50000, 50100))).toBe(true);

    const whole = await h.app.inject({ method: 'GET', url });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(VIDEO)).toBe(true);

    const past = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=999999-' } });
    expect(past.statusCode).toBe(416);

    // The ticket names that one file and nothing else.
    const other = await h.app.inject({
      method: 'GET',
      url: `/api/v1/file-streams/${'0'.repeat(64)}`,
    });
    expect(other.statusCode).toBe(404);

    // A text file is offered to save, never shown as a page from a ticket.
    const text = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/sessions/${id}/files/stream`,
      payload: { path: 'notes.txt' },
    });
    const saved = await h.app.inject({ method: 'GET', url: (text.json() as { url: string }).url });
    expect(saved.headers['content-type']).toBe('application/octet-stream');
    expect(String(saved.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('refuses a ticket for a path out of the folder, or a file that is not there', async () => {
    const h = await hub();
    const { id } = await session(h);
    const out = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/sessions/${id}/files/stream`,
      payload: { path: '../../etc/passwd' },
    });
    expect(out.statusCode).toBe(400);
    const missing = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/sessions/${id}/files/stream`,
      payload: { path: 'nope.mp4' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('a player that stops reading half-way (§97)', () => {
  it('is not an error: the hub keeps answering after a reader drops a long range', async () => {
    const h = await hub();
    const { id, dir } = await session(h);
    // Large enough that the socket is still busy when the reader goes away.
    writeFileSync(path.join(dir, 'long.wav'), Buffer.alloc(24 * 1024 * 1024, 3));
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const made = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/sessions/${id}/files/stream`,
      payload: { path: 'long.wav' },
    });
    const { url } = made.json() as { url: string };
    const unhandled: unknown[] = [];
    const onError = (error: unknown) => unhandled.push(error);
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
    try {
      for (let round = 0; round < 5; round += 1) {
        await new Promise<void>((resolve) => {
          const request = http.get(
            { host: '127.0.0.1', port, path: url, headers: { range: 'bytes=0-' } },
            (response) => {
              expect(response.statusCode).toBe(206);
              response.once('data', () => {
                // What a player does once it has the header of the file: it lets go.
                request.destroy();
                resolve();
              });
            },
          );
          request.on('error', () => resolve());
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Still up, still answering ranges.
      const again = await fetch(`http://127.0.0.1:${port}${url}`, {
        headers: { range: 'bytes=10-19' },
      });
      expect(again.status).toBe(206);
      expect(Buffer.from(await again.arrayBuffer())).toEqual(Buffer.alloc(10, 3));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onError);
      process.off('unhandledRejection', onError);
    }
  });
});

describe('the profile’s working files (knowledge.downloadWorkspaceFile, …Stream)', () => {
  it('answers a range inline for a video, and plays from a ticket', async () => {
    const h = await hub();
    const root = path.join(h.dataDir, 'workspaces', 'default', 'renders');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'final.webm'), VIDEO);

    const part = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/workspace-files/content?path=renders/final.webm&disposition=inline',
      headers: { range: 'bytes=0-99' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-type']).toBe('video/webm');
    expect(part.headers['content-range']).toBe(`bytes 0-99/${VIDEO.length}`);
    expect(part.rawPayload.equals(VIDEO.subarray(0, 100))).toBe(true);

    const past = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/workspace-files/content?path=renders/final.webm',
      headers: { range: 'bytes=200000-' },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${VIDEO.length}`);

    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/workspace-files/stream?path=renders/final.webm',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { url } = made.json() as { url: string };
    const seek = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=100-199' } });
    expect(seek.statusCode).toBe(206);
    expect(seek.headers['content-type']).toBe('video/webm');
    expect(seek.rawPayload.equals(VIDEO.subarray(100, 200))).toBe(true);

    const folder = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/workspace-files/stream?path=renders',
    });
    expect(folder.statusCode).toBe(400);
  });
});
