/**
 * The one cheap question the hub asks a platform before it stores its credentials: who is this?
 *
 * Linking a platform is pasting what its developer console gave. Asking first means a mistyped or
 * revoked credential is refused on the spot, in the platform's own words, and the page can name
 * the account people will message — as #97 does for Telegram with `getMe`:
 *
 * - Discord: `GET /api/v10/users/@me` with the bot token;
 * - Slack: `auth.test` with the bot token, then `apps.connections.open` with the app token (Socket
 *   Mode, what Hermes connects with; it hands out a socket address and opens nothing);
 * - Matrix: `GET /_matrix/client/v3/account/whoami` on the homeserver with the access token;
 * - Mattermost: `GET /api/v4/users/me` on the server with the token;
 * - Email: an IMAP sign-in (how Hermes reads the mailbox) and an SMTP sign-in (how it answers),
 *   each closed at once — nothing is read or sent.
 *
 * A refusal is `400 validation_failed`, `details.reason = credentials_rejected`, naming the field
 * and carrying the platform's words; no answer is `503 service_unavailable`,
 * `details.reason = platform_unreachable`. No credential ever appears in an error or a log.
 */
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { HubError } from '../../lib/errors.js';
import type { AccountIdentity, PlatformSpec } from './channel-platforms.js';

export interface ProbeOptions {
  /** Every HTTP question; a test (or an e2e hub) replaces it, never the addresses. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Email over plain TCP without STARTTLS — only for a test's local IMAP and SMTP servers, which
   * speak the protocol without a certificate.
   */
  plainSockets?: boolean;
}

const rejected = (platform: string, field: string, message: string | null): HubError =>
  new HubError('validation_failed', {
    details: { field, reason: 'credentials_rejected', platform, message },
  });

const unreachable = (platform: string): HubError =>
  new HubError('service_unavailable', { details: { reason: 'platform_unreachable', platform } });

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** One JSON question. A refusal (4xx, or the platform's own `ok: false`) is the caller's to word. */
async function ask(
  platform: string,
  url: string,
  init: RequestInit,
  options: ProbeOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw unreachable(platform);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not the platform's JSON: a proxy's page, a gateway error, a wrong address.
    if (response.ok || response.status >= 500) throw unreachable(platform);
  }
  if (response.status >= 500) throw unreachable(platform);
  return { status: response.status, body };
}

const base = (url: string) => url.trim().replace(/\/+$/, '');

async function discord(values: Record<string, string>, options: ProbeOptions) {
  const { status, body } = await ask(
    'discord',
    'https://discord.com/api/v10/users/@me',
    { method: 'GET', headers: { authorization: `Bot ${values.DISCORD_BOT_TOKEN}` } },
    options,
  );
  if (status !== 200 || body.id === undefined) {
    throw rejected('discord', 'DISCORD_BOT_TOKEN', text(body.message) ?? `HTTP ${status}`);
  }
  return {
    id: String(body.id),
    name: text(body.global_name) ?? text(body.username),
    username: text(body.username),
  };
}

async function slack(values: Record<string, string>, options: ProbeOptions) {
  const post = (method: string, token: string) =>
    ask(
      'slack',
      `https://slack.com/api/${method}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
      options,
    );
  const bot = await post('auth.test', values.SLACK_BOT_TOKEN!);
  if (bot.body.ok !== true) {
    throw rejected('slack', 'SLACK_BOT_TOKEN', text(bot.body.error) ?? `HTTP ${bot.status}`);
  }
  const app = await post('apps.connections.open', values.SLACK_APP_TOKEN!);
  if (app.body.ok !== true) {
    throw rejected('slack', 'SLACK_APP_TOKEN', text(app.body.error) ?? `HTTP ${app.status}`);
  }
  return {
    id: text(bot.body.user_id),
    name: text(bot.body.team),
    username: text(bot.body.user),
  };
}

async function matrix(values: Record<string, string>, options: ProbeOptions) {
  const { status, body } = await ask(
    'matrix',
    `${base(values.MATRIX_HOMESERVER!)}/_matrix/client/v3/account/whoami`,
    { method: 'GET', headers: { authorization: `Bearer ${values.MATRIX_ACCESS_TOKEN}` } },
    options,
  );
  const user = text(body.user_id);
  if (status !== 200 || !user) {
    // A homeserver that answers but is not one says nothing a person could act on.
    if (status === 404) throw rejected('matrix', 'MATRIX_HOMESERVER', text(body.error));
    throw rejected('matrix', 'MATRIX_ACCESS_TOKEN', text(body.error) ?? `HTTP ${status}`);
  }
  return { id: user, name: null, username: user.replace(/^@/, '') };
}

async function mattermost(values: Record<string, string>, options: ProbeOptions) {
  const { status, body } = await ask(
    'mattermost',
    `${base(values.MATTERMOST_URL!)}/api/v4/users/me`,
    { method: 'GET', headers: { authorization: `Bearer ${values.MATTERMOST_TOKEN}` } },
    options,
  );
  if (status !== 200 || body.id === undefined) {
    if (status === 404) throw rejected('mattermost', 'MATTERMOST_URL', text(body.message));
    throw rejected('mattermost', 'MATTERMOST_TOKEN', text(body.message) ?? `HTTP ${status}`);
  }
  const full = [text(body.first_name), text(body.last_name)].filter(Boolean).join(' ');
  return {
    id: String(body.id),
    name: text(body.nickname) ?? (full || null),
    username: text(body.username),
  };
}

// ------------------------------------------------------------------ email

/** Lines from a socket, one at a time, with the socket swappable for its TLS upgrade. */
class LineReader {
  private buffer = '';
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;
  socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    // Decoded here, not with setEncoding: a socket about to be wrapped in TLS must stay bytes.
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.flush();
    });
    const end = () => {
      this.closed = true;
      this.flush();
    };
    socket.on('end', end);
    socket.on('close', end);
    socket.on('error', end);
  }

  private flush(): void {
    if (!this.waiting) return;
    const index = this.buffer.indexOf('\n');
    if (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const resolve = this.waiting;
      this.waiting = null;
      resolve(line);
    } else if (this.closed) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(null);
    }
  }

  line(): Promise<string | null> {
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.flush();
    });
  }

  write(data: string): void {
    this.socket.write(data);
  }
}

function open(host: string, port: number, secure: boolean, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = secure
      ? connectTls({ host, port, servername: host })
      : connectTcp({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function upgrade(socket: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data');
    const secure = connectTls({ socket, servername: host });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** An IMAP quoted string (RFC 3501): `\` and `"` escaped. */
const imapQuoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Reads lines until the tagged answer; returns it without the tag. */
async function tagged(reader: LineReader, tag: string): Promise<string | null> {
  for (;;) {
    const line = await reader.line();
    if (line === null) return null;
    if (line.startsWith(`${tag} `)) return line.slice(tag.length + 1);
  }
}

/** Signs in to the mailbox the way Hermes reads it (IMAP, implicit TLS unless port 143). */
async function imapSignIn(values: Record<string, string>, options: ProbeOptions): Promise<void> {
  const host = values.EMAIL_IMAP_HOST!;
  const port = Number(values.EMAIL_IMAP_PORT || 993);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const implicit = !options.plainSockets && port !== 143;
  let socket: Socket;
  try {
    socket = await open(host, port, implicit, timeoutMs);
  } catch {
    throw unreachable('email');
  }
  const reader = new LineReader(socket);
  const timer = setTimeout(() => reader.socket.destroy(), timeoutMs);
  try {
    const greeting = await reader.line();
    if (!greeting?.startsWith('* OK')) throw unreachable('email');
    if (!implicit && !options.plainSockets) {
      reader.write('a0 STARTTLS\r\n');
      if (!(await tagged(reader, 'a0'))?.startsWith('OK')) throw unreachable('email');
      reader.attach(await upgrade(socket, host, timeoutMs));
    }
    reader.write(
      `a1 LOGIN ${imapQuoted(values.EMAIL_ADDRESS!)} ${imapQuoted(values.EMAIL_PASSWORD!)}\r\n`,
    );
    const answer = await tagged(reader, 'a1');
    if (answer === null) throw unreachable('email');
    if (!answer.startsWith('OK')) {
      throw rejected('email', 'EMAIL_PASSWORD', `IMAP: ${answer.replace(/^(NO|BAD)\s*/, '')}`);
    }
    reader.write('a2 LOGOUT\r\n');
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw unreachable('email');
  } finally {
    clearTimeout(timer);
    reader.socket.destroy();
  }
}

/** One SMTP answer, multi-line (`250-…` … `250 …`) read to its end: the code and the last text. */
async function smtpReply(reader: LineReader): Promise<{ code: number; lines: string[] } | null> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.line();
    if (line === null) return null;
    lines.push(line.slice(4));
    if (line[3] !== '-') return { code: Number(line.slice(0, 3)), lines };
  }
}

/** Signs in to the outgoing server the way Hermes answers (implicit TLS on 465, else STARTTLS). */
async function smtpSignIn(values: Record<string, string>, options: ProbeOptions): Promise<void> {
  const host = values.EMAIL_SMTP_HOST!;
  const port = Number(values.EMAIL_SMTP_PORT || 587);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const implicit = !options.plainSockets && port === 465;
  let socket: Socket;
  try {
    socket = await open(host, port, implicit, timeoutMs);
  } catch {
    throw unreachable('email');
  }
  const reader = new LineReader(socket);
  const timer = setTimeout(() => reader.socket.destroy(), timeoutMs);
  const expect = async (codes: number[]) => {
    const reply = await smtpReply(reader);
    if (!reply) throw unreachable('email');
    if (!codes.includes(reply.code)) return reply;
    return null;
  };
  try {
    if (await expect([220])) throw unreachable('email');
    reader.write('EHLO corehub\r\n');
    let hello = await smtpReply(reader);
    if (!hello || hello.code !== 250) throw unreachable('email');
    if (!implicit && !options.plainSockets) {
      reader.write('STARTTLS\r\n');
      if (await expect([220])) throw unreachable('email');
      reader.attach(await upgrade(socket, host, timeoutMs));
      reader.write('EHLO corehub\r\n');
      hello = await smtpReply(reader);
      if (!hello || hello.code !== 250) throw unreachable('email');
    }
    const auth = hello.lines.find((line) => /^AUTH[ =]/i.test(line)) ?? '';
    const user = values.EMAIL_ADDRESS!;
    const password = values.EMAIL_PASSWORD!;
    let refusal: { code: number; lines: string[] } | null;
    if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
      const plain = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64');
      reader.write(`AUTH PLAIN ${plain}\r\n`);
      refusal = await expect([235]);
    } else {
      reader.write('AUTH LOGIN\r\n');
      refusal = await expect([334]);
      if (!refusal) {
        reader.write(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`);
        refusal = await expect([334]);
      }
      if (!refusal) {
        reader.write(`${Buffer.from(password, 'utf8').toString('base64')}\r\n`);
        refusal = await expect([235]);
      }
    }
    if (refusal) {
      throw rejected('email', 'EMAIL_PASSWORD', `SMTP ${refusal.code}: ${refusal.lines.join(' ')}`);
    }
    reader.write('QUIT\r\n');
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw unreachable('email');
  } finally {
    clearTimeout(timer);
    reader.socket.destroy();
  }
}

async function email(values: Record<string, string>, options: ProbeOptions) {
  await imapSignIn(values, options);
  await smtpSignIn(values, options);
  const address = values.EMAIL_ADDRESS!;
  return { id: address, name: address, username: null };
}

const PROBES: Record<
  string,
  (values: Record<string, string>, options: ProbeOptions) => Promise<AccountIdentity>
> = { discord, slack, matrix, mattermost, email };

/**
 * Asks `spec`'s platform about `values` (only the ones given, never an empty optional). Null for a
 * platform the hub has no question for.
 */
export async function probePlatform(
  spec: PlatformSpec,
  values: Record<string, string | null>,
  options: ProbeOptions = {},
): Promise<AccountIdentity | null> {
  const probe = spec.validates ? PROBES[spec.platform] : undefined;
  if (!probe) return null;
  const given: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value) given[key] = value;
  return probe(given, options);
}
