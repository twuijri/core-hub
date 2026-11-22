import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StatusView } from '../src/core.js';
import { cleanPatch, handlePanel, panelResponse, type PanelCore } from '../src/panel.js';

const view = { linked: false } as unknown as StatusView;

function core(): PanelCore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    statusView: () => view,
    linkWith: vi.fn(async (raw: string) => {
      calls.push(`link:${raw}`);
      return { ok: raw === 'good', text: raw === 'good' ? 'Linked' : 'Linking failed' };
    }),
    unlink: async () => ({ ok: true, text: 'Unlinked' }),
    refreshModels: async () => ({ ok: true, text: '2 models' }),
    updateSettings: async (patch) => {
      calls.push(`settings:${JSON.stringify(patch)}`);
    },
    pickFolder: async () => '/Users/me/Reports',
  };
}

const signal = new AbortController().signal;
const owner = { kind: 'owner' };

describe('the settings page endpoints', () => {
  it('answers only the harness owner', async () => {
    const c = core();
    expect(await handlePanel(c, 'corehub/state', {}, signal, { kind: 'api' })).toMatchObject({
      ok: false,
      error: { code: 'corehub/forbidden' },
    });
    expect(await handlePanel(c, 'corehub/state', {}, signal, null)).toMatchObject({ ok: false });
  });

  it('links with the pasted pairing and says whether it worked', async () => {
    const c = core();
    expect(await handlePanel(c, 'corehub/link', { pairing: 'good' }, signal, owner)).toEqual({
      ok: true,
      value: { outcome: { ok: true, text: 'Linked' }, state: view },
    });
    expect(await handlePanel(c, 'corehub/link', { pairing: 7 }, signal, owner)).toMatchObject({
      ok: true,
      value: { outcome: { ok: false } },
    });
    expect(c.calls).toEqual(['link:good', 'link:']);
  });

  it('writes only clean settings', async () => {
    const c = core();
    expect(
      await handlePanel(c, 'corehub/settings', { patch: { allowOpen: 'yes' } }, signal, owner),
    ).toMatchObject({ ok: false, error: { code: 'corehub/bad-request' } });
    expect(
      await handlePanel(c, 'corehub/settings', { patch: { screenTasks: false } }, signal, owner),
    ).toEqual({ ok: true, value: { state: view } });
    expect(c.calls).toEqual(['settings:{"screenTasks":false}']);
  });

  it('picks a folder and refuses unknown endpoints', async () => {
    const c = core();
    expect(await handlePanel(c, 'corehub/pick-folder', {}, signal, owner)).toEqual({
      ok: true,
      value: { path: '/Users/me/Reports' },
    });
    expect(await handlePanel(c, 'corehub/nope', {}, signal, owner)).toMatchObject({
      ok: false,
      error: { code: 'corehub/not-found' },
    });
  });

  it('turns a failure into an error answer, not a thrown request', async () => {
    const c = { ...core(), unlink: async () => Promise.reject(new Error('hub down')) };
    expect(await handlePanel(c, 'corehub/unlink', {}, signal, owner)).toEqual({
      ok: false,
      error: { code: 'corehub/failed', message: 'hub down', details: {} },
    });
  });

  it('answers a Fetch route as JSON, and a body that is not JSON as a bad request', async () => {
    const c = core();
    const ok = await panelResponse(
      c,
      'models',
      new Request('http://h/api/corehub/models', { method: 'POST', body: '{}' }),
    );
    expect(await ok.json()).toMatchObject({ ok: true, value: { outcome: { text: '2 models' } } });
    const bad = await panelResponse(
      c,
      'state',
      new Request('http://h/api/corehub/state', { method: 'POST', body: '{' }),
    );
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: 'corehub/bad-request' } });
  });
});

describe('cleanPatch', () => {
  it('keeps absolute folders, normalised and once each', () => {
    expect(
      cleanPatch(
        {
          folders: [
            { path: '/a/b/../c', write: true },
            { path: '/a/c' },
            { path: '/x', write: 'yes' },
          ],
        },
        path.posix,
      ),
    ).toEqual({
      ok: true,
      value: {
        folders: [
          { path: '/a/c', write: true },
          { path: '/x', write: false },
        ],
      },
    });
    expect(cleanPatch({ folders: [{ path: 'relative' }] }, path.posix)).toMatchObject({
      ok: false,
    });
  });

  it('keeps programs with at least one profile', () => {
    expect(cleanPatch({ programs: { github: ['work', ' work ', ''], off: [] } })).toEqual({
      ok: true,
      value: { programs: { github: ['work'] } },
    });
    expect(cleanPatch({ programs: { github: 'work' } })).toMatchObject({ ok: false });
  });

  it('refuses unknown fields, bad languages and non-objects', () => {
    expect(cleanPatch({ dataDir: '/tmp' })).toMatchObject({ ok: false });
    expect(cleanPatch({ language: 'fr' })).toMatchObject({ ok: false });
    expect(cleanPatch([])).toMatchObject({ ok: false });
    expect(cleanPatch({ language: 'ar', agentProfile: ' work ', screenModel: '' })).toEqual({
      ok: true,
      value: { language: 'ar', agentProfile: 'work', screenModel: '' },
    });
  });
});
