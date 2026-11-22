import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubClient } from '@corehub/contracts';
import { ConsentGate } from '../src/consent.js';
import { deviceAnswers, type ScreenService } from '../src/device-answers.js';
import {
  DeviceLink,
  RequestRefusal,
  reportBodies,
  type DeviceRequestView,
} from '../src/device-link.js';
import { defaultRealpath } from '../src/folders.js';
import { ProgramHost } from '../src/programs.js';
import { fakeFetch } from './fake-hub.js';

let root: string;
beforeEach(() => {
  root = defaultRealpath(mkdtempSync(path.join(os.tmpdir(), 'corehub-dsh-device-')))!;
  mkdirSync(path.join(root, 'shared'));
  writeFileSync(path.join(root, 'shared/a.txt'), 'hello');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const request = (capability: string, params: Record<string, unknown>): DeviceRequestView => ({
  id: 'RQ1',
  profile: 'work',
  device_id: 'D1',
  capability,
  params,
  status: 'pending',
  purpose: null,
});

const programs = new ProgramHost({
  mcp: { servers: () => [], tools: () => [], call: vi.fn() },
  profiles: () => ({}),
  consent: new ConsentGate(async () => 'deny'),
  question: () => ({
    key: 'x',
    title: '',
    message: '',
    labels: { once: 'o', session: null, deny: 'd' },
  }),
  record: () => undefined,
});

function answers(screen: Partial<ScreenService> = {}, consent: 'once' | 'deny' = 'once') {
  const record = vi.fn();
  const run = vi.fn(async () => ({
    state: 'done' as const,
    outcome: 'Made the note.',
    screenshot_attachment_id: 'AT1',
    progress: '3 steps',
  }));
  const answer = deviceAnswers({
    folders: () => ({
      folders: [{ path: path.join(root, 'shared'), write: false }],
      allowOpen: false,
    }),
    open: { openPath: async () => undefined, openUrl: async () => undefined },
    programs,
    consent: new ConsentGate(async () => consent),
    record,
    screen: {
      available: () => true,
      question: () => ({
        key: 'screen_task',
        title: '',
        message: '',
        labels: { once: 'a', session: null, deny: 'd' },
      }),
      run,
      status: () => null,
      ...screen,
    },
  });
  return { answer, record, run };
}

const link = {} as DeviceLink;

describe('device answers', () => {
  it('answers a file tool inside a shared folder and records it', async () => {
    const { answer, record } = answers();
    const result = await answer(
      request('files', {
        tool: 'read_text_file',
        arguments: { path: path.join(root, 'shared/a.txt') },
      }),
      link,
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }], is_error: false });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'files', ok: true }));
  });

  it('refuses a path outside and a tool not offered', async () => {
    const { answer } = answers();
    expect(
      await answer(
        request('files', { tool: 'read_text_file', arguments: { path: '/etc/hostname' } }),
        link,
      ),
    ).toMatchObject({ is_error: true });
    await expect(
      answer(request('files', { tool: 'write_text_file', arguments: {} }), link),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      answer(request('files', { tool: 'send_file', arguments: { path: '/etc/hostname' } }), link),
    ).rejects.toBeInstanceOf(RequestRefusal);
  });

  it('refuses a program that is not switched on', async () => {
    const { answer } = answers();
    await expect(
      answer(request('apps', { op: 'call', program: 'resolve', tool: 'render' }), link),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('runs a screen task only after the person allows it', async () => {
    const allowed = answers();
    expect(
      await allowed.answer(request('screen_task', { task: 'Make a note', app: 'Notes' }), link),
    ).toMatchObject({
      state: 'done',
      screenshot_attachment_id: 'AT1',
    });
    const denied = answers({}, 'deny');
    await expect(denied.answer(request('screen_task', { task: 'x' }), link)).rejects.toMatchObject({
      code: 'permission_denied',
      status: 'denied',
    });
    expect(denied.run).not.toHaveBeenCalled();
  });

  it('refuses screen tasks where they cannot run, and an unknown status', async () => {
    await expect(
      answers({ available: () => false }).answer(request('screen_task', { task: 'x' }), link),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      answers().answer(request('screen_task', { op: 'status', call_id: 'nope' }), link),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(answers().answer(request('location', {}), link)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('device link', () => {
  const report = {
    folders: [{ path: '/x', write: true }],
    allow_open: false,
    programs: [{ id: 'gh', name: 'gh', profiles: ['work'], tools: [] }],
    screen: true,
  };

  it('offers older hubs a report without what they do not know', () => {
    const bodies = reportBodies(report, 'now');
    expect(bodies.map((b) => b.left_out)).toEqual([null, 'screen_task', 'programs']);
    const kinds = (b: Record<string, unknown>) =>
      (b.capabilities as Array<{ kind: string }>).map((c) => c.kind);
    expect(kinds(bodies[0]!.body)).toContain('screen_task');
    expect(kinds(bodies[1]!.body)).not.toContain('screen_task');
    expect((bodies[2]!.body.helper as { programs: unknown[] }).programs).toEqual([]);
    expect(
      (bodies[0]!.body.helper as { programs: Array<{ source: string }> }).programs[0]!.source,
    ).toBe('dsh');
  });

  it('falls back when the hub refuses the newer report, and answers a request once', async () => {
    const { fetch, seen } = fakeFetch((s) => {
      if (s.method === 'PATCH') {
        const kinds = (s.body as { capabilities: Array<{ kind: string }> }).capabilities.map(
          (c) => c.kind,
        );
        return kinds.includes('screen_task')
          ? { status: 400, json: { error: 'bad', code: 'validation_failed' } }
          : { status: 200, json: {} };
      }
      if (s.path.endsWith('/respond')) return { status: 200, json: {} };
      return undefined;
    });
    const client = createHubClient({ baseUrl: 'https://hub.example', token: 't', fetch });
    const answer = vi.fn(async () => ({ ok: true }));
    const link = new DeviceLink({
      hub: 'https://hub.example',
      token: () => 't',
      deviceId: 'D1',
      client,
      profiles: () => ['work'],
      report: () => report,
      answer,
    });
    await link.sendReport();
    expect(link.state().degraded).toBe('screen_task');
    await Promise.all([link.handle(request('files', {})), link.handle(request('files', {}))]);
    expect(answer).toHaveBeenCalledTimes(1);
    const respond = seen.find((s) => s.path.endsWith('/respond'))!;
    expect(respond.body).toEqual({ status: 'fulfilled', result: { ok: true }, error: null });
    expect(respond.headers['x-hub-profile']).toBe('work');
  });
});
