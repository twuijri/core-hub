/**
 * The fallback chain on the **direct** agent (contract decision §54), over the real routes,
 * the real registry and the real `models` store — only the provider's HTTP endpoint is
 * scripted.
 *
 * The owner's outage of 2026-09-25 as a test: the chosen model answers
 * `503 auth_unavailable`, the profile's fallback chain names a second model, and the turn is
 * answered by it — with the run saying which model answered and what failed before it. And the
 * line it must not cross: a `400` is the request, not the provider, and is never retried
 * elsewhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

const BASE_URL = 'https://proxy.example/v1';

interface ChatCall {
  model: string;
}

/**
 * The owner's proxy: three models. `primary` is down the way the proxy was
 * (`503 auth_unavailable`), `backup` answers, `strict` refuses the request as invalid (400).
 */
function scriptedProxy(): { fetchImpl: typeof fetch; chats: ChatCall[] } {
  const chats: ChatCall[] = [];
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    if (String(url) === `${BASE_URL}/models`) {
      return Promise.resolve(
        json(200, { data: [{ id: 'primary' }, { id: 'backup' }, { id: 'strict' }] }),
      );
    }
    if (String(url) === `${BASE_URL}/chat/completions`) {
      const body = JSON.parse(String(init.body)) as { model: string };
      chats.push({ model: body.model });
      if (body.model === 'primary') {
        return Promise.resolve(
          json(503, {
            error: {
              message:
                'auth_unavailable: no auth available (providers=antigravity, model=gemini-3.8-flash-high)',
            },
          }),
        );
      }
      if (body.model === 'strict') {
        return Promise.resolve(json(400, { error: { message: 'messages: field required' } }));
      }
      const frames = [
        { choices: [{ delta: { content: 'أجاب الاحتياطي' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    return Promise.resolve(json(503, { error: 'not part of this test' }));
  }) as unknown as typeof fetch;
  return { fetchImpl, chats };
}

let hub: (TestHub & { token: string }) | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

interface RunView {
  id: string;
  status: string;
  model: string | null;
  provider: string | null;
  error: { code: string; error: string } | null;
  fallback?: {
    failed: { model: string; provider: string | null; code: string | null; error: string | null }[];
  } | null;
}

/** A hub whose default model is `primary`, with `fallbacks` behind it, and a session. */
async function setUp(primary: string, fallbacks: string[]) {
  const { fetchImpl, chats } = scriptedProxy();
  hub = await signedInHub({}, { models: { fetchImpl } });
  const h = hub;
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: {
      preset: 'openai-compatible',
      label: 'Proxy',
      kind: 'llm',
      base_url: BASE_URL,
      api_key: 'sk-proxy',
    },
  });
  expect(created.statusCode).toBe(201);
  const provider = created.json() as { id: string; slug: string };
  await drainJobs(h.app);
  const saved = await authed(h, h.token, {
    method: 'PUT',
    url: '/api/v1/models/defaults',
    payload: {
      default: { provider_id: provider.id, model: primary },
      fallbacks: fallbacks.map((model) => ({ provider_id: provider.id, model })),
    },
  });
  expect(saved.statusCode).toBe(200);
  expect((saved.json() as { fallbacks: { model: string }[] }).fallbacks).toEqual(
    fallbacks.map((model) => ({ provider_id: provider.id, model })),
  );
  const agents = (
    (await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
      items: { id: string; slug: string }[];
    }
  ).items;
  const direct = agents.find((agent) => agent.slug === 'direct');
  if (!direct) throw new Error('no direct agent');
  const session = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: direct.id },
  });
  expect(session.statusCode).toBe(201);
  return { h, chats, slug: provider.slug, sessionId: (session.json() as { id: string }).id };
}

async function runToEnd(h: TestHub & { token: string }, sessionId: string): Promise<RunView> {
  const accepted = await authed(h, h.token, {
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/runs`,
    payload: { content: [{ type: 'text', text: 'مرحبًا' }] },
  });
  expect(accepted.statusCode).toBe(202);
  for (let i = 0; i < 200; i += 1) {
    const page = (
      await authed(h, h.token, { method: 'GET', url: `/api/v1/sessions/${sessionId}/runs` })
    ).json() as { items: RunView[] };
    const run = page.items[0];
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the run did not end');
}

describe('the fallback chain on the direct agent (decision §54)', () => {
  it('moves on from a 503 auth_unavailable and says which model answered', async () => {
    const { h, chats, slug, sessionId } = await setUp('primary', ['backup']);
    const run = await runToEnd(h, sessionId);

    expect(run.status).toBe('succeeded');
    // The turn itself; the conversation's title is asked for after it, down the same chain.
    expect(chats.map((call) => call.model).slice(0, 2)).toEqual(['primary', 'backup']);
    // The run names the model that answered, and what failed before it, in its own words.
    expect(run.model).toBe(`${slug}/backup`);
    expect(run.provider).toBe(slug);
    expect(run.fallback?.failed).toHaveLength(1);
    expect(run.fallback?.failed[0]).toMatchObject({ model: 'primary', provider: slug });
    expect(run.fallback?.failed[0]?.error).toContain('auth_unavailable');

    const messages = (
      await authed(h, h.token, { method: 'GET', url: `/api/v1/sessions/${sessionId}/messages` })
    ).json() as { items: { role: string; content: { type: string; text?: string }[] }[] };
    const reply = messages.items.filter((message) => message.role === 'assistant').at(-1);
    expect(reply?.content[0]?.text).toBe('أجاب الاحتياطي');

    // The trajectory's turn says the same.
    const trajectory = (
      await authed(h, h.token, { method: 'GET', url: `/api/v1/sessions/${sessionId}/trajectory` })
    ).json() as {
      steps: { kind: string; model?: string | null; fallback?: RunView['fallback'] }[];
    };
    const turn = trajectory.steps.find((step) => step.kind === 'turn');
    expect(turn?.model).toBe(`${slug}/backup`);
    expect(turn?.fallback?.failed[0]?.model).toBe('primary');
  });

  it('does not move on from a 400: the request was refused, not the provider', async () => {
    const { h, chats, sessionId } = await setUp('strict', ['backup']);
    const run = await runToEnd(h, sessionId);

    expect(run.status).toBe('failed');
    expect(chats.map((call) => call.model)).toEqual(['strict']);
    expect(run.error?.error).toContain('messages: field required');
    expect(run.fallback ?? null).toBeNull();
  });

  it('with no chain, the 503 ends the run as before', async () => {
    const { h, chats, sessionId } = await setUp('primary', []);
    const run = await runToEnd(h, sessionId);

    expect(run.status).toBe('failed');
    expect(chats.map((call) => call.model)).toEqual(['primary']);
    expect(run.error?.error).toContain('auth_unavailable');
  });

  it('keeps the chain when only the chat model changes, and never lists that model in it', async () => {
    const { h } = await setUp('primary', ['backup', 'strict']);
    const providerId = (
      (await authed(h, h.token, { method: 'GET', url: '/api/v1/models/defaults' })).json() as {
        default: { provider_id: string };
      }
    ).default.provider_id;
    // What a provider card sends: the model alone.
    const changed = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: providerId, model: 'backup' } },
    });
    expect(changed.statusCode).toBe(200);
    const body = changed.json() as { fallbacks: { model: string }[] };
    expect(body.fallbacks.map((ref) => ref.model)).toEqual(['strict']);
  });

  it('when every model fails, the run fails on the last and lists the ones before it', async () => {
    const { h, chats, slug, sessionId } = await setUp('primary', ['strict']);
    const run = await runToEnd(h, sessionId);

    expect(run.status).toBe('failed');
    expect(chats.map((call) => call.model)).toEqual(['primary', 'strict']);
    expect(run.model).toBe(`${slug}/strict`);
    expect(run.fallback?.failed.map((attempt) => attempt.model)).toEqual(['primary']);
  });
});
