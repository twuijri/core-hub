// pair · pair claim — QR pairing, both sides.
import { LEGACY, derived } from '@corehub/contracts';
import { hostname, platform as osPlatform, release, type as osType } from 'node:os';
import type { Socket } from 'socket.io-client';
import type { CommandSpec } from '../args.js';
import { anonymousClient, normaliseServer } from '../client.js';
import type { CommandContext } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import { renderQr } from '../qr.js';
import { DEVICES_NAMESPACE, EnvelopeValidator, connectNamespace, isEnvelope } from '../realtime.js';
import type { Device, Pairing } from '../types.js';
import { pickUser } from './auth.js';
import { formatTime, optionEnum, optionInteger, requireSession } from './shared.js';

const POLL_MS = 5_000;

interface Claimed {
  pairing: Pairing;
  device: Device | null;
}

export const pairCommand: CommandSpec = {
  path: ['pair'],
  description: 'cmd.pair',
  options: {
    ttl: { type: 'string', description: 'option.ttl', value: 'SECONDS' },
    connection: { type: 'string', description: 'option.connection', value: 'lan|relay' },
    'no-qr': { type: 'boolean', description: 'option.no_qr' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const auth = requireSession(ctx);
    const ttl = optionInteger(ctx, 'ttl', 300, { min: 60, max: 900 });
    const connection = optionEnum(ctx, 'connection', ['lan', 'relay'] as const, 'lan');
    const { data: pairing } = await auth.client.request('post', '/auth/pairings', {
      body: { connection, ttl_seconds: ttl },
    });

    if (ctx.globals.json) {
      ctx.out.jsonLine(pairing);
    } else {
      ctx.out.line(
        t('pair.created', {
          id: pairing.id,
          code: ctx.out.style.bold(pairing.code),
          expires: formatTime(pairing.expires_at),
        }),
      );
      ctx.out.line(t('pair.scan'));
      ctx.out.line(`  corehub pair claim '${pairing.qr_payload.replace(/'/g, "'\\''")}'`);
      if (ctx.options['no-qr'] !== true) {
        ctx.out.line();
        ctx.out.line(renderQr(pairing.qr_payload));
        ctx.out.line();
      }
      ctx.out.notice(ctx.out.style.dim(t('pair.waiting')));
    }

    const result = await waitForClaim(ctx, auth.session().server, auth.session().token, pairing);
    if (result.pairing.status === 'claimed') {
      if (ctx.globals.json) ctx.out.jsonLine(result);
      else if (result.device)
        ctx.out.line(
          t('pair.claimed', {
            name: result.device.name,
            platform: result.device.platform,
            kind: result.device.kind,
          }),
        );
      else ctx.out.line(t('pair.claimed_unknown', { device_id: result.pairing.device_id ?? '?' }));
      return 0;
    }
    if (ctx.globals.json) ctx.out.jsonLine(result);
    ctx.out.error(t(result.pairing.status === 'cancelled' ? 'pair.cancelled' : 'pair.expired'));
    return 1;
  },
};

/** The `pairing.claimed` event on `/rt/devices`, with a poll of `auth.getPairing` as fallback. */
async function waitForClaim(
  ctx: CommandContext,
  server: string,
  token: string,
  pairing: Pairing,
): Promise<Claimed> {
  const auth = requireSession(ctx);
  const validator = ctx.globals.strict ? new EnvelopeValidator() : undefined;
  let socket: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  const expiresIn = Math.max(0, Date.parse(pairing.expires_at) - Date.now()) + 2_000;
  try {
    return await new Promise<Claimed>((resolve, reject) => {
      socket = connectNamespace({ server, namespace: DEVICES_NAMESPACE, token });
      socket.on('connect_error', (error: Error) => {
        // `unauthorized` is fatal; anything else falls back to polling.
        if (error.message === 'unauthorized')
          reject(new CliError('errors.socket', { reason: error.message }, 3));
      });
      socket.on('pairing.claimed', (envelope: unknown) => {
        if (validator) {
          const problems = validator.problems(envelope);
          if (problems.length > 0)
            return reject(
              new CliError('errors.envelope_invalid', {
                event: 'pairing.claimed',
                problems: problems.join('; '),
              }),
            );
        }
        if (!isEnvelope(envelope)) return;
        const payload = envelope.payload as { pairing?: Pairing; device?: Device };
        if (payload.pairing?.id === pairing.id)
          resolve({ pairing: payload.pairing, device: payload.device ?? null });
      });
      const check = async () => {
        try {
          const { data } = await auth.client.request('get', '/auth/pairings/{pairing_id}', {
            params: { pairing_id: pairing.id },
          });
          if (data.status !== 'pending') resolve({ pairing: data, device: null });
        } catch (error) {
          reject(error);
        }
      };
      poll = setInterval(() => void check(), POLL_MS);
      timer = setTimeout(
        () =>
          void check().then(() =>
            resolve({ pairing: { ...pairing, status: 'expired' }, device: null }),
          ),
        expiresIn,
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    socket?.disconnect();
  }
}

interface QrPayload {
  type: typeof derived.pairingType;
  hub_url?: string;
  pairing_id: string;
  code: string;
}

function parseQrPayload(text: string): QrPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  // A code shown by a hub from before the rename says `majlis.pairing` (ADR 0017).
  const known = p.type === derived.pairingType || p.type === LEGACY.pairingType;
  if (!known || typeof p.pairing_id !== 'string' || typeof p.code !== 'string')
    throw new UsageError('errors.pairing_json_invalid');
  return {
    type: derived.pairingType,
    pairing_id: p.pairing_id,
    code: p.code,
    ...(typeof p.hub_url === 'string' ? { hub_url: p.hub_url } : {}),
  };
}

export function devicePlatform(
  node: NodeJS.Platform = osPlatform(),
): 'linux' | 'macos' | 'windows' {
  if (node === 'darwin') return 'macos';
  if (node === 'win32') return 'windows';
  return 'linux';
}

export const pairClaimCommand: CommandSpec = {
  path: ['pair', 'claim'],
  description: 'cmd.pair_claim',
  positionals: [{ name: 'CODE', description: 'arg.code', required: true }],
  options: {
    'pairing-id': { type: 'string', description: 'option.pairing_id', value: 'ID' },
    name: { type: 'string', description: 'option.device_name', value: 'NAME' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const raw = (ctx.positionals[0] ?? '').trim();
    const payload = raw.startsWith('{') ? parseQrPayload(raw) : null;
    const code = payload?.code ?? raw;
    const pairingId =
      payload?.pairing_id ??
      (typeof ctx.options['pairing-id'] === 'string' ? ctx.options['pairing-id'] : undefined);
    if (!pairingId) throw new UsageError('errors.pairing_id_required');
    const server = normaliseServer(ctx.globals.server ?? payload?.hub_url);
    const anonymous = anonymousClient({ server, language: ctx.language });
    const name =
      typeof ctx.options.name === 'string' && ctx.options.name !== ''
        ? ctx.options.name
        : hostname();

    const { data } = await anonymous.request('post', '/auth/pairings/{pairing_id}/claim', {
      params: { pairing_id: pairingId },
      body: {
        code,
        device: {
          device_key: ctx.store.deviceKey(),
          name: name.slice(0, 80),
          platform: devicePlatform(),
          kind: 'computer',
          brand: null,
          model: `${osType()} ${release()}`,
          app_version: ctx.version,
          capabilities: [],
        },
      },
    });
    ctx.store.saveSession({
      server,
      profile: ctx.globals.profile ?? data.user.default_profile,
      token: data.app_token,
      token_kind: 'app',
      refresh_token: null,
      expires_at: data.expires_at,
      user: pickUser(data.user),
    });
    if (ctx.globals.json) {
      const { app_token: _secret, ...rest } = data;
      ctx.out.json({ hub_url: server, ...rest });
    } else {
      ctx.out.line(t('pair.claim_success', { username: data.user.username, server }));
      ctx.out.line(ctx.out.style.dim(t('pair.claim_stored', { file: ctx.store.file })));
    }
    return 0;
  },
};
