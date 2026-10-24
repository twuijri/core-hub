// Gemini Desktop, the provider the hub holds itself (DECISIONS §155): its sign-in, its account's
// modes, its native turns and one Gemini conversation per hub conversation. Google is never
// called: the token service is a scripted fetch and the native service a local HTTP/2 server
// (`testing/fake-native.ts`) that keeps conversations the way the live one did.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage } from '../adapters/types.js';
import type { AccountScope, AccountStorage, StoredAccount } from './accounts.js';
import { accountIdOf } from './accounts.js';
import { GEMINI_DESKTOP_AUTO, GeminiDesktop } from './index.js';
import { modeModelId, parseUserStatus } from './modes.js';
import {
  GeminiDesktopError,
  REDIRECT_URI,
  SERVICE_SCOPES,
  TOKEN_ENDPOINT,
  USERINFO_ENDPOINT,
  acceptCallback,
  exchange,
  refresh,
  startLogin,
} from './oauth.js';
import { msg, nested, num, parseWire } from './protobuf.js';
import { MAX_TURNS, planTurn, recordTurn, usableKey, type Threads } from './threads.js';
import { GRPC, NativeCallError, PROCESS_QUERY, nativeCall } from './transport.js';
import { readAnswerFrame, turnFrames } from './wire.js';
import { fakeNative, statusWith, type FakeNative } from './testing/fake-native.js';
import { mintSessionRef } from '../../agents/runner.js';
import { newUlid } from '../../../db/ids.js';

const ROW: AccountScope = { id: '01JROWROWROWROWROWROWROWRO', workspace: 'w1', ownerId: 'u1' };
const KEY = 'direct-01jabcdefghjkmnpqrstvwxyz0';
const OTHER_KEY = 'direct-01jzzzzzzzzzzzzzzzzzzzzzz1';

function memoryStorage(): AccountStorage & { all: Map<string, StoredAccount>; saved: Threads } {
  const all = new Map<string, StoredAccount>();
  const box = { saved: {} as Threads };
  return {
    all,
    get saved() {
      return box.saved;
    },
    list: () =>
      [...all.values()].map((a) => structuredClone(a)).sort((a, b) => a.createdAt - b.createdAt),
    get: (_row, id) => (all.has(id) ? structuredClone(all.get(id)!) : null),
    save: (_row, account) => void all.set(account.id, structuredClone(account)),
    remove: (_row, id) => all.delete(id),
    removeAll: () => all.clear(),
    threads: () => structuredClone(box.saved),
    saveThreads: (_row, threads) => {
      box.saved = structuredClone(threads);
    },
  };
}

interface TokenScript {
  email?: string;
  /** Refresh tokens Google rotates to, in order; none: it keeps the old one. */
  rotate?: string[];
  failUserinfo?: boolean;
  failRefresh?: boolean;
  /** The authorization code answer has no refresh token. */
  noRefreshToken?: boolean;
  /** How the access tokens it hands out begin (`svc-1`, `svc-2` …). */
  prefix?: string;
}

function tokenService(script: TokenScript = {}) {
  const calls: { url: string; body: URLSearchParams | null }[] = [];
  let issued = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    calls.push({ url: String(url), body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (String(url) === TOKEN_ENDPOINT) {
      if (body?.get('grant_type') === 'authorization_code') {
        return json({
          access_token: 'flex-token',
          expires_in: 3600,
          ...(script.noRefreshToken ? {} : { refresh_token: 'refresh-1' }),
        });
      }
      if (script.failRefresh) return json({ error: 'invalid_grant' }, 400);
      issued += 1;
      const rotated = script.rotate?.shift();
      return json({
        access_token: `${script.prefix ?? 'svc'}-${issued}`,
        expires_in: 3600,
        scope: body?.get('scope') ?? '',
        ...(rotated ? { refresh_token: rotated } : {}),
      });
    }
    if (String(url) === USERINFO_ENDPOINT) {
      if (script.failUserinfo) return json({ error: 'nope' }, 500);
      return json({ email: script.email ?? 'person@example.com', verified_email: true });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const fakes: FakeNative[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

async function service(script: TokenScript = {}) {
  const fake = await fakeNative();
  fakes.push(fake);
  const storage = memoryStorage();
  const tokens = tokenService(script);
  const desktop = new GeminiDesktop({ storage, fetchImpl: tokens.fetchImpl, opener: fake.opener });
  return { fake, storage, tokens, desktop };
}

async function signIn(desktop: GeminiDesktop) {
  const login = desktop.startLogin();
  return desktop.completeLogin(
    ROW,
    login,
    `${REDIRECT_URI}?state=${login.state}&code=4%2Fabc&scope=x`,
  );
}

async function collect(
  stream: AsyncIterable<ChatEvent>,
): Promise<{ text: string; events: ChatEvent[] }> {
  const events: ChatEvent[] = [];
  let text = '';
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'delta') text += event.text;
  }
  return { text, events };
}

const user = (text: string): ChatMessage => ({ role: 'user', text });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', text });

describe('gemini desktop: wire', () => {
  it('sends the query and commit frames, and the ids of the turn it continues in template field 4', () => {
    const fresh = turnFrames('hello', { category: 0, variantId: null }, null);
    expect(fresh).toHaveLength(3);
    expect(nested(fresh[1]!, 1007, 1)[0]!.toString()).toBe('hello');
    expect(nested(fresh[2]!, 1007, 2)).toHaveLength(1);
    const template = nested(fresh[0]!, 1000, 1001, 1)[0]!;
    expect(parseWire(template)).toEqual([]);

    const resumed = turnFrames(
      'again',
      { category: 3, variantId: 'pro-v1' },
      { conversation: 'c_1', response: 'r_1', choice: 'rc_1' },
    );
    const fields = parseWire(nested(resumed[0]!, 1000, 1001, 1)[0]!);
    const ids = parseWire(fields.find((f) => f.field === 4)!.bytes).map((f) => f.bytes.toString());
    expect(ids).toEqual(['c_1', 'r_1', 'rc_1']);
    expect(fields.find((f) => f.field === 47)!.int).toBe(3n);
    expect(fields.find((f) => f.field === 66)!.bytes.toString()).toBe('pro-v1');
    // RequestMetadata: client type MACOS (21), en-US.
    const metadata = parseWire(nested(resumed[0]!, 1000, 1)[0]!);
    expect(metadata.find((f) => f.field === 4)!.int).toBe(21n);
  });

  it('reads the answer, the three ids and the title out of a server frame', () => {
    const frame = msg(
      1003,
      msg(
        1,
        Buffer.concat([
          msg(1, Buffer.concat([msg(1, 'rc_9'), msg(2, msg(1, 'Hi there'))])),
          msg(2, Buffer.concat([msg(1, 'c_9'), msg(2, 'r_9')])),
          msg(4, msg(1, 'Greeting')),
          msg(30, 'Used 3.1 Pro model'),
        ]),
      ),
    );
    expect(readAnswerFrame(frame)).toEqual({
      text: 'Hi there',
      conversation: 'c_9',
      response: 'r_9',
      choice: 'rc_9',
      title: 'Greeting',
      modelNote: 'Used 3.1 Pro model',
    });
    expect(readAnswerFrame(msg(1014, msg(1, msg(1, 'c_early')))).conversation).toBe('c_early');
    expect(() => readAnswerFrame(Buffer.from([0xff, 0xff]))).toThrow();
  });
});

describe('gemini desktop: modes', () => {
  it('takes the policy as authoritative and never brings back a mode it disabled', () => {
    const status = statusWith(
      [
        { title: '3.5 Flash-Lite', category: 6 },
        { title: '3.8 Flash', category: 1, disabled: true },
        { title: '3.1 Pro', category: 3, variantId: 'v-pro' },
      ],
      [
        { id: 'cfg-lite', title: 'Flash-Lite', category: 6 },
        { id: 'cfg-flash', title: 'Flash', category: 1 },
      ],
    );
    const modes = parseUserStatus(status);
    expect(modes.map((m) => [m.title, m.category, m.variantId, m.configId])).toEqual([
      ['3.5 Flash-Lite', 6, null, 'cfg-lite'],
      ['3.1 Pro', 3, 'v-pro', null],
    ]);
  });

  it('reads the older list only when there is no policy, and uses the short title when the long one is missing', () => {
    expect(
      parseUserStatus(statusWith([], [{ id: 'x', title: 'Old', category: 2 }])).map((m) => m.title),
    ).toEqual(['Old']);
    const short = Buffer.from(msg(34, msg(2, msg(1, Buffer.concat([num(3, 8), msg(6, 'Argon')])))));
    expect(parseUserStatus(short)[0]!.title).toBe('Argon');
  });

  it('names modes readably and refuses two selections under one name', () => {
    expect(modeModelId({ title: '3.5 Flash-Lite', category: 6 })).toBe(
      'gemini-desktop-3.5-flash-lite',
    );
    expect(modeModelId({ title: '4 Argon', category: 8 })).toBe('gemini-desktop-4-argon');
    expect(modeModelId({ title: '3.1 Pro', category: 3 })).toBe('gemini-desktop-3.1-pro');
    expect(modeModelId({ title: '…', category: 5 })).toBe('gemini-desktop-mode-5');
    expect(() =>
      parseUserStatus(
        statusWith([
          { title: 'Pro', category: 3 },
          { title: 'pro', category: 4 },
        ]),
      ),
    ).toThrow(/ambiguous/);
  });
});

describe('gemini desktop: sign-in', () => {
  it('asks for the app’s client with PKCE S256, offline access and a random state', () => {
    const a = startLogin(0);
    const b = startLogin(0);
    const url = new URL(a.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/flexible-api');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('client_id')).toMatch(
      /^839509190550-.*\.apps\.googleusercontent\.com$/,
    );
    expect(a.state).not.toBe(b.state);
    expect(a.expiresAt).toBe(10 * 60_000);
  });

  it('takes an address once, for its own sign-in, in time', () => {
    const login = startLogin(0);
    expect(() => acceptCallback(login, `${REDIRECT_URI}?state=other&code=c`, 1)).toThrow(
      /another sign-in/,
    );
    expect(login.used).toBe(false); // the right address can still be pasted
    expect(() => acceptCallback(login, `${REDIRECT_URI}?state=${login.state}`, 1)).toThrow(
      /no sign-in code/,
    );
    expect(acceptCallback(login, `state=${login.state}&code=the-code`, 1)).toBe('the-code');
    expect(() => acceptCallback(login, `${REDIRECT_URI}?state=${login.state}&code=x`, 2)).toThrow(
      /already used/,
    );

    const late = startLogin(0);
    expect(() =>
      acceptCallback(late, `${REDIRECT_URI}?state=${late.state}&code=x`, 10 * 60_000),
    ).toThrow(/expired/);
    const declined = startLogin(0);
    expect(() =>
      acceptCallback(declined, `${REDIRECT_URI}?error=access_denied&state=${declined.state}`, 1),
    ).toThrow(/declined/);
    expect(declined.used).toBe(true);
  });

  it('exchanges the code, mints a service-scoped token from the same grant and names the account', async () => {
    const { fetchImpl, calls } = tokenService({ email: 'Owner@Example.com' });
    const login = startLogin();
    const tokens = await exchange(fetchImpl, login, 'code-1');
    expect(tokens).toMatchObject({
      accessToken: 'svc-1',
      refreshToken: 'refresh-1',
      email: 'owner@example.com',
    });
    const [first, second] = calls;
    expect(first!.body!.get('code_verifier')).toBe(login.verifier);
    expect(first!.body!.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(second!.body!.get('grant_type')).toBe('refresh_token');
    expect(second!.body!.get('scope')).toBe(SERVICE_SCOPES);

    await expect(
      exchange(tokenService({ noRefreshToken: true }).fetchImpl, startLogin(), 'c'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      exchange(tokenService({ failUserinfo: true }).fetchImpl, startLogin(), 'c'),
    ).rejects.toThrow(/which Google account/);
  });

  it('keeps the stored refresh token when Google sends none, takes a rotated one, and never loses a refresh to a failed e-mail lookup', async () => {
    const base = {
      accessToken: 'old',
      refreshToken: 'refresh-1',
      expiresAt: 0,
      scope: '',
      email: null,
    };
    const kept = await refresh(tokenService({ failUserinfo: true }).fetchImpl, base);
    expect(kept).toMatchObject({ accessToken: 'svc-1', refreshToken: 'refresh-1', email: null });
    const rotated = await refresh(tokenService({ rotate: ['refresh-2'] }).fetchImpl, {
      ...base,
      email: 'a@b.co',
    });
    expect(rotated.refreshToken).toBe('refresh-2');
    await expect(
      refresh(tokenService({ failRefresh: true }).fetchImpl, base),
    ).rejects.toBeInstanceOf(GeminiDesktopError);
  });

  it('saves one account per Google account: signing in again renews it, another e-mail adds one', async () => {
    const { desktop, storage, tokens } = await service({ email: 'one@example.com' });
    const first = await signIn(desktop);
    expect(first.accountId).toBe(accountIdOf('one@example.com'));
    const again = await signIn(desktop);
    expect(again.accountId).toBe(first.accountId);
    expect(storage.all.size).toBe(1);
    expect(storage.all.get(first.accountId)!.modes.map((m) => m.title)).toEqual([
      '3.5 Flash-Lite',
      '3.1 Pro',
    ]);

    // A different Google account lands beside it, never on it.
    const other = new GeminiDesktop({
      storage,
      fetchImpl: tokenService({ email: 'two@example.com' }).fetchImpl,
      opener: fakes[0]!.opener,
    });
    const second = await signIn(other);
    expect(second.accountId).not.toBe(first.accountId);
    expect(storage.all.size).toBe(2);
    expect(storage.all.get(first.accountId)!.email).toBe('one@example.com');
    expect(tokens.calls.some((call) => call.body?.get('scope') === SERVICE_SCOPES)).toBe(true);
  });
});

describe('gemini desktop: transport', () => {
  it('reads gzip frames and maps gRPC codes to the hub’s statuses', async () => {
    const fake = await fakeNative();
    fakes.push(fake);
    fake.gzip = true;
    const seen: Buffer[] = [];
    await nativeCall(
      {
        method: PROCESS_QUERY,
        token: 't',
        frames: turnFrames('hi', { category: 0, variantId: null }, null),
        onMessage: (m) => void seen.push(m),
      },
      fake.opener,
    );
    expect(seen.length).toBe(4);
    expect(readAnswerFrame(seen[3]!).text).toBe('echo: hi');

    fake.tokens.add('good');
    const refused = nativeCall(
      { method: PROCESS_QUERY, token: 'bad', frames: [], onMessage: () => undefined },
      fake.opener,
    );
    await expect(refused).rejects.toMatchObject({ code: GRPC.UNAUTHENTICATED, status: 401 });
    fake.tokens.clear();
    fake.failWith = GRPC.RESOURCE_EXHAUSTED;
    await expect(
      nativeCall(
        {
          method: PROCESS_QUERY,
          token: 't',
          frames: turnFrames('x', { category: 0, variantId: null }, null),
          onMessage: () => undefined,
        },
        fake.opener,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('stops a call when its signal is aborted', async () => {
    const fake = await fakeNative();
    fakes.push(fake);
    fake.hold = true;
    const controller = new AbortController();
    const call = nativeCall(
      {
        method: PROCESS_QUERY,
        token: 't',
        frames: turnFrames('long', { category: 0, variantId: null }, null),
        signal: controller.signal,
        onMessage: (message) => {
          if (readAnswerFrame(message).text) controller.abort();
        },
      },
      fake.opener,
    );
    await expect(call).rejects.toBeInstanceOf(NativeCallError);
    await expect(call).rejects.toMatchObject({ code: GRPC.CANCELLED });
    fake.release();
  });
});

describe('gemini desktop: one hub conversation, one Gemini conversation', () => {
  it('plans: new, continue, branch, a restarted hub, and a history Gemini never saw', () => {
    const ids = (n: number) => ({ conversation: 'c_1', response: `r_${n}`, choice: `rc_${n}` });
    let threads: Threads = {};
    const turn1 = [{ role: 'user' as const, text: 'a' }];
    expect(planTurn(undefined, turn1)).toEqual({ kind: 'new', folded: false, diverged: false });
    threads = recordTurn(
      threads,
      KEY,
      'acc',
      [...turn1, { role: 'assistant', text: 'A' }],
      ids(1),
      1,
      true,
    );
    const turn2 = [
      ...turn1,
      { role: 'assistant' as const, text: 'A' },
      { role: 'user' as const, text: 'b' },
    ];
    expect(planTurn(threads[KEY], turn2)).toEqual({ kind: 'continue', resume: ids(1) });
    threads = recordTurn(
      threads,
      KEY,
      'acc',
      [...turn2, { role: 'assistant', text: 'B' }],
      ids(2),
      2,
      false,
    );
    // The hub cut its history back to turn 1 and asked something else: a branch from turn 1.
    const edited = [
      ...turn1,
      { role: 'assistant' as const, text: 'A' },
      { role: 'user' as const, text: 'b2' },
    ];
    expect(planTurn(threads[KEY], edited)).toEqual({ kind: 'branch', resume: ids(1) });
    // The direct agent lost its memory (a restart): the same conversation goes on.
    expect(
      planTurn(threads[KEY], [
        { role: 'system', text: 's' },
        { role: 'user', text: 'c' },
      ]),
    ).toEqual({ kind: 'continue', resume: ids(2) });
    // A history Gemini never saw: a new conversation, with the history.
    expect(
      planTurn(threads[KEY], [
        { role: 'user', text: 'x' },
        { role: 'assistant', text: 'y' },
        { role: 'user', text: 'z' },
      ]),
    ).toEqual({ kind: 'new', folded: true, diverged: true });

    expect(usableKey(KEY)).toBe(true);
    // The direct agent's conversations are named so (one per hub conversation).
    expect(usableKey(mintSessionRef('builtin', newUlid()))).toBe(true);
    expect(mintSessionRef('acp', newUlid())).toBeNull();
    expect(usableKey('direct-direct')).toBe(false);
    expect(usableKey(null)).toBe(false);
    for (let i = 0; i < MAX_TURNS + 5; i++)
      threads = recordTurn(
        threads,
        KEY,
        'acc',
        [{ role: 'user', text: String(i) }],
        ids(i),
        i,
        false,
      );
    expect(threads[KEY]!.turns).toHaveLength(MAX_TURNS);
  });

  it('continues the same Gemini conversation, sends only the new message, and branches on an edit', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    const system: ChatMessage = { role: 'system', text: 'Be brief.' };
    const one = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [system, user('first')],
      }),
    );
    expect(one.text).toBe('echo: </user>');
    expect(one.events.at(-1)).toEqual({ type: 'completed' });
    const turn1 = fake.turns.at(-1)!;
    // The first message carries the system prompt.
    expect(turn1.text).toContain('<system>\nBe brief.\n</system>');

    const two = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [system, user('first'), assistant(one.text), user('second')],
      }),
    );
    expect(two.text).toBe('echo: second');
    const request2 = fake.requests.at(-1)!;
    expect(request2.text).toBe('second');
    expect(request2.resume).toEqual({
      conversation: turn1.conversation,
      response: turn1.response,
      choice: turn1.choice,
    });
    expect(fake.turns.at(-1)!.conversation).toBe(turn1.conversation);

    // The hub's history cut back to the first answer, and a different question: a branch.
    await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [system, user('first'), assistant(one.text), user('other')],
      }),
    );
    expect(fake.requests.at(-1)!.resume!.response).toBe(turn1.response);
    expect(fake.turns.at(-1)!.parent).toBe(turn1.response);

    // Another hub conversation: another Gemini conversation.
    await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: OTHER_KEY,
        messages: [user('hello')],
      }),
    );
    expect(fake.requests.at(-1)!.resume).toBeNull();
    expect(fake.turns.at(-1)!.conversation).not.toBe(turn1.conversation);
  });

  it('starts again with the history, and says so, when Google no longer continues the conversation', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    const one = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [user('first')],
      }),
    );
    fake.refuseResume = GRPC.NOT_FOUND;
    const two = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [user('first'), assistant(one.text), user('second')],
      }),
    );
    expect(two.text.startsWith('↻')).toBe(true);
    expect(two.text.endsWith('echo: </user>')).toBe(true);
    const last = fake.requests.at(-1)!;
    expect(last.resume).toBeNull();
    expect(last.text).toContain('<user>\nfirst\n</user>');
    expect(last.text).toContain('<assistant>\necho: first\n</assistant>');
    // The new conversation is the one continued next.
    fake.refuseResume = null;
    await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [
          user('first'),
          assistant(one.text),
          user('second'),
          assistant(two.text),
          user('third'),
        ],
      }),
    );
    expect(fake.requests.at(-1)!.resume!.conversation).toBe(fake.turns.at(-2)!.conversation);
  });

  it('folds the history every turn when there is no usable conversation key', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: 'direct-direct',
        messages: [user('a'), assistant('b'), user('c')],
      }),
    );
    expect(fake.requests.at(-1)!.resume).toBeNull();
    expect(fake.requests.at(-1)!.text).toContain('<assistant>\nb\n</assistant>');
  });
});

describe('gemini desktop: models, accounts and failures', () => {
  it('lists auto and each mode once, and sends the chosen mode’s category and variant', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    expect(await desktop.models(ROW)).toEqual([
      { id: 'gemini-desktop-auto', label: 'Gemini (auto)' },
      { id: 'gemini-desktop-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-desktop-3.1-pro', label: 'Gemini 3.1 Pro' },
    ]);
    await collect(desktop.chat(ROW, { model: 'gemini-desktop-3.1-pro', messages: [user('hi')] }));
    expect(fake.requests.at(-1)).toMatchObject({ category: 3, variantId: 'pro-v1' });
    await collect(desktop.chat(ROW, { model: GEMINI_DESKTOP_AUTO, messages: [user('hi')] }));
    expect(fake.requests.at(-1)).toMatchObject({ category: 0, variantId: null });

    const before = fake.requests.length;
    const unknown = await collect(
      desktop.chat(ROW, { model: 'gemini-desktop-9-ultra', messages: [user('hi')] }),
    );
    expect(unknown.events).toEqual([
      expect.objectContaining({ type: 'failed', reason: 'model_not_found', status: 404 }),
    ]);
    expect(fake.requests.length).toBe(before); // never quietly sent as auto
  });

  it('keeps an account’s modes when asking again fails', async () => {
    const { desktop, fake, storage } = await service();
    const { accountId } = await signIn(desktop);
    fake.status = Buffer.from([0xff, 0xff, 0xff]);
    expect((await desktop.models(ROW)).map((m) => m.id)).toContain('gemini-desktop-3.1-pro');
    expect(storage.all.get(accountId)!.modes).toHaveLength(2);
  });

  it('keeps a conversation on its account, and moves to another account only with a new conversation', async () => {
    const { desktop, fake, storage } = await service({ email: 'a@example.com', prefix: 'a' });
    const a = await signIn(desktop);
    const one = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [user('first')],
      }),
    );
    const b = await signIn(
      new GeminiDesktop({
        storage,
        fetchImpl: tokenService({ email: 'b@example.com', prefix: 'b' }).fetchImpl,
        opener: fake.opener,
      }),
    );
    // Account B is newer; the conversation still goes to A.
    await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [user('first'), assistant(one.text), user('second')],
      }),
    );
    expect(fake.requests.at(-1)!.resume).not.toBeNull();
    expect(fake.requests.at(-1)!.token).toBe(storage.all.get(a.accountId)!.accessToken);
    desktop.setDisabled(ROW, a.accountId, true);
    const moved = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        conversation: KEY,
        messages: [user('first'), assistant(one.text), user('third')],
      }),
    );
    expect(moved.text.startsWith('↻')).toBe(true);
    expect(fake.requests.at(-1)!.resume).toBeNull();
    expect(fake.requests.at(-1)!.token).toBe(storage.all.get(b.accountId)!.accessToken);
  });

  it('streams each part of the growing answer once', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    fake.answer = () => 'abcdefghij';
    const out = await collect(
      desktop.chat(ROW, { model: GEMINI_DESKTOP_AUTO, messages: [user('x')] }),
    );
    const deltas = out.events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(['abcde', 'fghij']);
  });

  it('renews an expired token once when Google says so, and refuses images', async () => {
    const { desktop, fake, storage } = await service();
    const { accountId } = await signIn(desktop);
    const stale = storage.all.get(accountId)!;
    fake.tokens.add('svc-2'); // the next token the service hands out
    storage.all.set(accountId, {
      ...stale,
      accessToken: 'revoked',
      expiresAt: Date.now() + 3_600_000,
    });
    const out = await collect(
      desktop.chat(ROW, { model: GEMINI_DESKTOP_AUTO, messages: [user('x')] }),
    );
    expect(out.events.at(-1)).toEqual({ type: 'completed' });
    expect(storage.all.get(accountId)!.accessToken).toBe('svc-2');

    const image = await collect(
      desktop.chat(ROW, {
        model: GEMINI_DESKTOP_AUTO,
        messages: [
          {
            role: 'user',
            text: 'see',
            images: [{ mime: 'image/png', dataBase64: 'AA==' }],
          } as ChatMessage,
        ],
      }),
    );
    expect(image.events).toEqual([
      expect.objectContaining({ type: 'failed', reason: 'unsupported' }),
    ]);
  });

  it('ends a stopped turn as cancelled', async () => {
    const { desktop, fake } = await service();
    await signIn(desktop);
    fake.hold = true;
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const event of desktop.chat(ROW, {
      model: GEMINI_DESKTOP_AUTO,
      messages: [user('long one')],
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === 'delta') controller.abort();
    }
    fake.release();
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'cancelled' });
  });

  it('says plainly when no account is signed in', async () => {
    const { desktop } = await service();
    const out = await collect(
      desktop.chat(ROW, { model: GEMINI_DESKTOP_AUTO, messages: [user('x')] }),
    );
    expect(out.events).toEqual([expect.objectContaining({ type: 'failed', reason: 'no_key' })]);
    await expect(desktop.models(ROW)).rejects.toMatchObject({ status: 409 });
  });
});
