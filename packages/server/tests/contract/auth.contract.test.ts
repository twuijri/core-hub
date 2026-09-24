// `pnpm contract:test`: the success path of every `auth` operation, driven through the generated
// TypeScript client against a hub booted with HUB_ADMIN_PASSWORD, each answer validated against
// the schema the contract documents for that status. The generic runner (contract.test.ts) covers
// the unauthenticated/failure answers of the same operations.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@majlis/contracts';
import { profileTransferPorts } from '../../src/modules/index.js';
import { registerProfileTransfer } from '../../src/modules/auth/index.js';
import { fakeProfileRuntime } from '../../src/modules/auth/testing/fake-profile-runtime.js';
import { tarGz } from '../../src/modules/auth/testing/tar.js';
import { drainJobs, testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();

/** A profile archive as the browser's `FormData` sends it, with `purpose: import`. */
function archiveUpload(body: Buffer) {
  const boundary = '----majlisContractBoundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="work.tar.gz"\r\n` +
          'Content-Type: application/gzip\r\n\r\n',
      ),
      body,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nimport\r\n--${boundary}--\r\n`,
      ),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const PASSWORD = 'contract-test-password';
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe.skipIf(!doc)('contract: auth operations answer their success path', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let baseUrl: string;
  let token: string | undefined;
  let client: HubClient;
  let anonymous: HubClient;

  /** Calls the operation and asserts the answer is the expected status with a schema-valid body. */
  async function call(
    operationId: string,
    expectedStatus: number,
    init: {
      params?: Record<string, string | number>;
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      as?: HubClient;
    } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await (init.as ?? client).raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.query ? { query: init.query } : {}),
      });
      status = res.status;
      data = res.data;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    return (data ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    client = createHubClient({ ...options, token: () => token });
    anonymous = createHubClient(options);
  });
  afterAll(async () => {
    await hub.close();
  });

  it('runs the whole auth surface in order', async () => {
    // first run is already over on this hub (HUB_ADMIN_PASSWORD created the owner)
    const setupState = await call('auth.getSetup', 200, { as: anonymous });
    expect(setupState).toEqual({ required: false });
    await call('auth.completeSetup', 409, {
      body: { token: 'a'.repeat(48), username: 'intruder', password: 'a-long-enough-password' },
      as: anonymous,
    });

    // sign-in
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    token = login.access_token as string;
    const refreshed = await call('auth.refresh', 200, {
      body: { refresh_token: login.refresh_token },
      as: anonymous,
    });
    expect(refreshed.refresh_token).not.toBe(login.refresh_token);

    // me
    const me = await call('auth.getMe', 200);
    expect(me.role).toBe('owner');
    await call('auth.updateMe', 200, {
      body: { display_name: 'طارق', avatar: { kind: 'image', data_url: PNG_1X1 } },
    });
    const avatar = await client.raw('get', '/auth/users/{user_id}/avatar', {
      params: { user_id: me.id as string },
    });
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('content-type')).toContain('image/png');
    await call('auth.getPreferences', 200);
    const prefs = await call('auth.setPreferences', 200, {
      body: {
        theme: 'dark',
        locale: 'ar',
        text_scale: 1.15,
        link_target: 'browser',
        busy_input_mode: 'next',
        streaming: true,
        compact: false,
        show_reasoning: true,
        show_tool_calls: true,
        show_cost: true,
        inline_diffs: true,
        sound_on_complete: false,
        notify_on_complete: true,
        notify_on_approval: true,
        reasoning_effort: 'medium',
        voice: {
          input_mode: 'server',
          dictation_language: 'ar-SA',
          output_mode: 'server',
          auto_speak: false,
        },
      },
    });
    expect(prefs.theme).toBe('dark');
    await call('auth.changePassword', 204, {
      body: { current_password: PASSWORD, new_password: `${PASSWORD}-2` },
    });
    await call('auth.changePassword', 204, {
      body: { current_password: `${PASSWORD}-2`, new_password: PASSWORD },
    });

    // users (admin)
    const sara = await call('auth.createUser', 201, {
      body: {
        username: 'sara',
        password: 'sara-password-1',
        display_name: 'سارة',
        role: 'member',
        profiles: ['default'],
        default_profile: 'default',
        locale: 'ar',
      },
    });
    const page = await call('auth.listUsers', 200, { query: { limit: 50 } });
    expect((page.items as { username: string }[]).map((u) => u.username).sort()).toEqual([
      'admin',
      'sara',
    ]);
    await call('auth.getUser', 200, { params: { user_id: sara.id as string } });
    const disabled = await call('auth.updateUser', 200, {
      params: { user_id: sara.id as string },
      body: { status: 'disabled' },
    });
    expect(disabled.status).toBe('disabled');
    await call('auth.deleteUser', 204, { params: { user_id: sara.id as string } });

    // lockouts (admin)
    await call('auth.listLockouts', 200);
    await call('auth.clearLockouts', 200);

    // app tokens
    const created = await call('auth.createAppToken', 201, {
      body: { name: 'سكربت النسخ الاحتياطي', scopes: ['read'], expires_at: null },
    });
    expect(String(created.token)).toMatch(/^hub_at_/);
    const tokens = await call('auth.listAppTokens', 200);
    expect((tokens.items as { id: string }[]).some((t) => t.id === created.id)).toBe(true);
    await call('auth.revokeAppToken', 204, { params: { token_id: created.id as string } });

    // pairing
    const pairing = await call('auth.createPairing', 201, {
      body: { connection: 'lan', ttl_seconds: 300 },
    });
    expect(JSON.parse(pairing.qr_payload as string)).toMatchObject({
      type: 'majlis.pairing',
      pairing_id: pairing.id,
      code: pairing.code,
    });
    await call('auth.getPairing', 200, { params: { pairing_id: pairing.id as string } });
    const paired = await call('auth.claimPairing', 201, {
      params: { pairing_id: pairing.id as string },
      body: {
        code: pairing.code,
        device: {
          device_key: '3d5b0f2e-9c1a-4e7b-8f6d-2a1b3c4d5e6f',
          name: 'هاتف طارق',
          platform: 'android',
          kind: 'phone',
          brand: 'Google',
          model: 'Pixel 9',
          app_version: '1.0.2-test.22',
          capabilities: ['location', 'camera'],
        },
      },
      as: anonymous,
    });
    expect((paired.device as { this_device: boolean }).this_device).toBe(true);
    const claimed = await call('auth.getPairing', 200, {
      params: { pairing_id: pairing.id as string },
    });
    expect(claimed.status).toBe('claimed');
    await call('auth.cancelPairing', 204, { params: { pairing_id: pairing.id as string } });
    // the phone renews its app token: bearer only, no body
    const device = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      token: paired.app_token as string,
    });
    const renewed = await call('auth.refresh', 200, { as: device });
    expect(renewed.refresh_token).toBeNull();
    const asDevice = await call('auth.getMe', 200, { as: device });
    expect(asDevice.id).toBe(me.id);

    // profiles (workspaces)
    const listed = await call('auth.listProfiles', 200);
    expect((listed.items as { slug: string }[]).map((p) => p.slug)).toEqual(['default']);
    const work = await call('auth.createProfile', 201, {
      body: { slug: 'work', name: 'العمل', clone_from: 'default' },
    });
    await call('auth.getProfile', 200, { params: { profile_id: work.id as string } });
    const renamed = await call('auth.updateProfile', 200, {
      params: { profile_id: work.id as string },
      body: {
        name: 'العمل الرئيسي',
        default_model: { provider_id: '01J8QK3ZR2W7M5N4P6T8V9X0PV', model: 'claude-opus-4-1' },
      },
    });
    expect(renamed.default_model).toEqual({
      provider_id: '01J8QK3ZR2W7M5N4P6T8V9X0PV',
      model: 'claude-opus-4-1',
    });
    await call('auth.getProfileSettings', 200, { params: { profile_id: work.id as string } });
    const settings = await call('auth.updateProfileSettings', 200, {
      params: { profile_id: work.id as string },
      body: { privacy: { redact_pii: true } },
    });
    expect((settings.settings as { privacy: { redact_pii: boolean } }).privacy.redact_pii).toBe(
      true,
    );
    // A hub that does not supervise Hermes names the reason (contract decision §34) …
    const unmanaged = await call('auth.exportProfile', 409, {
      params: { profile_id: work.id as string },
    });
    expect(unmanaged.details).toEqual({ reason: 'hermes_not_supervised' });
    // … and with Hermes (scripted here) both are jobs that finish.
    const previous = registerProfileTransfer((app) =>
      profileTransferPorts(app, fakeProfileRuntime().runtime),
    );
    try {
      await call('auth.exportProfile', 202, { params: { profile_id: work.id as string } });
      const form = archiveUpload(tarGz([{ path: 'work/SOUL.md', content: 'soul' }]));
      const uploaded = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        payload: form.payload,
        headers: { ...form.headers, authorization: `Bearer ${token}`, 'x-hub-profile': 'default' },
      });
      expect(uploaded.statusCode).toBe(201);
      await call('auth.importProfile', 202, {
        body: {
          attachment_id: (uploaded.json() as { id: string }).id,
          slug: 'imported',
          name: 'المستورد',
        },
      });
      await call('auth.importProfile', 409, {
        body: { attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AW', slug: 'work' },
      });
      await drainJobs(hub.app);
      const jobs = await call('jobs.list', 200);
      expect(
        (jobs.items as Array<{ kind: string; status: string }>)
          .filter((job) => job.kind === 'export' || job.kind === 'import')
          .map((job) => `${job.kind}:${job.status}`)
          .sort(),
      ).toEqual(['export:succeeded', 'import:succeeded']);
    } finally {
      registerProfileTransfer(previous);
    }
    await call('auth.deleteProfile', 204, { params: { profile_id: work.id as string } });

    // sign-out ends the session immediately
    await call('auth.logout', 204);
    await call('auth.getMe', 401);
  });
});

// The success path of first-run setup needs the opposite hub: no owner and no
// HUB_ADMIN_PASSWORD, so the claim token on disk is the only way in (ADR 0011).
describe.skipIf(!doc)('contract: first-run setup on a hub with no owner', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let anonymous: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await anonymous.raw(op.method as ClientMethod, op.path, {
        ...(body !== undefined ? { body } : {}),
      });
      status = res.status;
      data = res.data;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    return (data ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    hub = await testHub();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    anonymous = createHubClient({
      baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
      apiBase: serverBasePath(document),
      profile: 'default',
    });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('auth.getSetup then auth.completeSetup: wrong token 401, the real one signs the owner in', async () => {
    expect(await call('auth.getSetup', 200)).toEqual({ required: true });
    await call('auth.completeSetup', 401, {
      token: 'c'.repeat(48),
      username: 'tariq',
      password: 'a-good-owner-password',
    });
    const token = readFileSync(path.join(hub.dataDir, 'setup-token.txt'), 'utf8').trim();
    const pair = await call('auth.completeSetup', 200, {
      token,
      username: 'tariq',
      password: 'a-good-owner-password',
      display_name: 'طارق',
      workspace_name: 'مساحتي',
    });
    expect((pair.user as { role: string }).role).toBe('owner');
    expect(await call('auth.getSetup', 200)).toEqual({ required: false });
    await call('auth.completeSetup', 409, {
      token,
      username: 'tariq2',
      password: 'a-good-owner-password',
    });
  });
});
