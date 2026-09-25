// `pnpm contract:test`: the owner's web terminal through the generated TypeScript client —
// `terminal.get` answers what the contract documents for each caller (403 while off, 403 for
// an admin, 200 for the owner), and every `/rt/terminal` envelope a session sends validates
// against its schema in `packages/contracts/events/terminal/`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
} from '@corehub/contracts';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/events',
);

function eventValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  return (envelope: { event: string }): string[] => {
    const file = path.join(eventsDir, 'terminal', `${envelope.event}.schema.json`);
    const schema = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete schema.$id;
    const validate = ajv.compile(schema);
    return validate(envelope)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
  };
}

describe.skipIf(!doc)("contract: the owner's web terminal", () => {
  const document = doc!;
  const op = operationsById(document).get('terminal.get')!;
  const schemas = ajvFor(document);
  const hubs: TestHub[] = [];
  const sockets: Socket[] = [];

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const hub of hubs) await hub.close();
  });

  async function start(env: Record<string, string>) {
    const hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD, ...env });
    hubs.push(hub);
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    let token: string | undefined;
    const client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      token: () => token,
    });
    const signIn = async (username: string, password: string) => {
      const res = await client.raw('post', '/auth/login', { body: { username, password } });
      token = (res.data as { access_token: string }).access_token;
      return token;
    };
    const get = async (expected: number) => {
      let status: number;
      let data: unknown;
      try {
        const res = await client.raw(op.method as ClientMethod, op.path, {});
        status = res.status;
        data = res.data;
      } catch (error) {
        if (!(error instanceof HubApiError)) throw error;
        status = error.status;
        data = error.body;
      }
      expect(status, JSON.stringify(data)).toBe(expected);
      const schema = responseSchema(op, status);
      expect(schema, `terminal.get documents ${status}`).toBeDefined();
      expect(schemas.validate(schema!, data)).toEqual([]);
      return data as Record<string, unknown>;
    };
    return { hub, baseUrl, client, signIn, get };
  }

  it('answers the documented 403 while the terminal is off, even for the owner', async () => {
    const { signIn, get } = await start({});
    await signIn('admin', PASSWORD);
    expect(await get(403)).toMatchObject({ details: { reason: 'terminal_disabled' } });
  });

  it('answers the documented 403 to an admin, and 200 with a schema-valid status to the owner; its events match their schemas', async () => {
    const { baseUrl, client, signIn, get } = await start({ COREHUB_WEB_TERMINAL: '1' });
    const owner = await signIn('admin', PASSWORD);
    await client.raw('post', '/auth/users', {
      body: { username: 'amal', password: 'amal-password-1', role: 'admin', profiles: ['default'] },
    });
    await signIn('amal', 'amal-password-1');
    expect(await get(403)).toMatchObject({ details: { required_role: 'owner' } });
    await signIn('admin', PASSWORD);
    expect(await get(200)).toMatchObject({ enabled: true, max_sessions: 3, sessions: [] });

    const socket = connect(`${baseUrl}/rt/terminal`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth: { token: owner },
    });
    sockets.push(socket);
    const envelopes: Array<{ event: string; payload: { data?: string } }> = [];
    socket.onAny((_name: string, envelope: { event: string; payload: { data?: string } }) =>
      envelopes.push(envelope),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const opened = await new Promise<{ ok: boolean; session: { id: string } }>((resolve) =>
      socket.emit('open', { profile: 'default', cols: 80, rows: 24 }, resolve),
    );
    expect(opened.ok).toBe(true);
    const listed = await get(200);
    expect(listed.sessions).toHaveLength(1);
    const id = opened.session.id;
    socket.emit('input', { terminal_id: id, data: 'echo contract\r' });
    await expect
      .poll(() => envelopes.map((e) => e.payload.data ?? '').join(''), { timeout: 10_000 })
      .toMatch(/\rcontract\r\n/);
    socket.emit('close', { terminal_id: id });
    await expect
      .poll(() => envelopes.some((e) => e.event === 'terminal.exited'), { timeout: 10_000 })
      .toBe(true);

    const validEvent = eventValidator();
    expect(new Set(envelopes.map((e) => e.event))).toEqual(
      new Set(['terminal.output', 'terminal.exited']),
    );
    for (const envelope of envelopes) expect(validEvent(envelope), envelope.event).toEqual([]);
  });
});
