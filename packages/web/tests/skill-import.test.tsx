/**
 * Importing skill packs deletes the uploaded packs afterwards (2026-09-24): the hub now takes
 * the same bytes again after a delete, so keeping them only filled the profile's files. They
 * go whether the import succeeded or was refused, and a failed delete never hides the import's
 * own answer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubApiError } from '@corehub/contracts';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { I18nProvider } from '../src/i18n/context.js';
import { useImportSkills } from '../src/agents/skills.js';

const AGENT = '01KAGENTXYZ000000000000000';
const uploaded: string[] = [];

vi.mock('../src/attachments/queries.js', () => ({
  useUploadAttachment: () => ({
    upload: async ({ file }: { file: File }) => {
      const id = `01J8QK3ZR2W7M5N4P6T8V9X0A${uploaded.length}`;
      uploaded.push(id);
      return { id, name: file.name };
    },
  }),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The hub, as far as this hook talks to it: the import answer, and every delete it saw. */
function hub(importAnswer: () => Response, deleteStatus = 204) {
  const deleted: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname.endsWith(`/agents/${AGENT}/skills`)) {
      return importAnswer();
    }
    const match = /\/attachments\/([^/]+)$/.exec(url.pathname);
    if (method === 'DELETE' && match) {
      deleted.push(match[1]!);
      return deleteStatus === 204
        ? new Response(null, { status: 204 })
        : json(deleteStatus, { error: 'nope', code: 'internal' });
    }
    return json(404, { error: 'unexpected', code: 'not_found' });
  });
  return { fetchImpl, deleted };
}

function harness(fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 'test-token',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'owner', display_name: 'Owner', role: 'owner' },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useImportSkills(AGENT), {
    wrapper: ({ children }) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider language="en">
            <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
              {children}
            </AuthProvider>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

const packs = () => [
  new File(['zip-a'], 'a.zip', { type: 'application/zip' }),
  new File(['zip-b'], 'b.zip', { type: 'application/zip' }),
];

describe('importing skill packs', () => {
  beforeEach(() => {
    uploaded.length = 0;
  });

  it('deletes every uploaded pack once the skills are installed', async () => {
    const { fetchImpl, deleted } = hub(() =>
      json(201, { items: [{ key: 'pdf-notes', name: 'pdf-notes' }] }),
    );
    const { result } = harness(fetchImpl as unknown as typeof fetch);
    let answer: unknown;
    await act(async () => {
      answer = await result.current.mutateAsync(packs());
    });
    expect(answer).toMatchObject({ items: [{ key: 'pdf-notes' }] });
    expect(deleted.sort()).toEqual([...uploaded].sort());
    expect(deleted).toHaveLength(2);
  });

  it('deletes them too when the hub refuses the pack, and keeps the refusal', async () => {
    const { fetchImpl, deleted } = hub(() =>
      json(409, {
        error: 'A skill called pdf-notes already exists.',
        code: 'conflict',
        details: { reason: 'skill_exists', skill: 'pdf-notes' },
      }),
    );
    const { result } = harness(fetchImpl as unknown as typeof fetch);
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync(packs()).catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(HubApiError);
    expect((caught as HubApiError).status).toBe(409);
    expect(deleted).toHaveLength(2);
  });

  it('answers the import even when a delete fails', async () => {
    const { fetchImpl, deleted } = hub(
      () => json(201, { items: [{ key: 'pdf-notes', name: 'pdf-notes' }] }),
      500,
    );
    const { result } = harness(fetchImpl as unknown as typeof fetch);
    let answer: unknown;
    await act(async () => {
      answer = await result.current.mutateAsync(packs());
    });
    expect(answer).toMatchObject({ items: [{ key: 'pdf-notes' }] });
    expect(deleted).toHaveLength(2);
  });
});
