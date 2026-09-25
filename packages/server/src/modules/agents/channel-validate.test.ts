/**
 * Linking Email asks the mailbox before anything is stored: an IMAP sign-in (how Hermes reads) and
 * an SMTP sign-in (how it answers). Against two small local servers that speak just enough of each
 * protocol — the real handshake, the real refusal lines — over plain TCP.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import { platformSpec } from './channel-platforms.js';
import { probePlatform } from './channel-validate.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const USER = 'hub@example.org';
const PASSWORD = 'correct horse';

function listen(handler: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/** Lines in, a reply out. */
function onLines(socket: Socket, reply: (line: string) => void): void {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      reply(line);
    }
  });
}

const imapLogins: string[] = [];
function imap(): Promise<number> {
  return listen((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    onLines(socket, (line) => {
      const [tag, command] = line.split(' ');
      if (command === 'LOGIN') {
        imapLogins.push(line);
        const ok = line === `${tag} LOGIN "${USER}" "${PASSWORD}"`;
        socket.write('* CAPABILITY IMAP4rev1\r\n');
        socket.write(
          ok
            ? `${tag} OK LOGIN completed\r\n`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`,
        );
      } else if (command === 'LOGOUT') {
        socket.end(`* BYE\r\n${tag} OK\r\n`);
      }
    });
  });
}

function smtp(mechanism: 'PLAIN' | 'LOGIN'): Promise<number> {
  return listen((socket) => {
    socket.write('220 mail.example.org ESMTP\r\n');
    let step = 0;
    onLines(socket, (line) => {
      if (line.startsWith('EHLO')) {
        socket.write(`250-mail.example.org\r\n250-AUTH ${mechanism}\r\n250 8BITMIME\r\n`);
      } else if (line.startsWith('AUTH PLAIN ')) {
        const decoded = Buffer.from(line.slice(11), 'base64').toString('utf8');
        socket.write(
          decoded === `\u0000${USER}\u0000${PASSWORD}`
            ? '235 2.7.0 Accepted\r\n'
            : '535 5.7.8 Username and Password not accepted\r\n',
        );
      } else if (line === 'AUTH LOGIN') {
        step = 1;
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (step === 1) {
        step = Buffer.from(line, 'base64').toString('utf8') === USER ? 2 : 3;
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else if (step >= 2) {
        const ok = step === 2 && Buffer.from(line, 'base64').toString('utf8') === PASSWORD;
        step = 0;
        socket.write(ok ? '235 Accepted\r\n' : '535 Authentication failed\r\n');
      } else if (line === 'QUIT') {
        socket.end('221 Bye\r\n');
      }
    });
  });
}

const email = platformSpec('email')!;
const values = (imapPort: number, smtpPort: number, password = PASSWORD) => ({
  EMAIL_ADDRESS: USER,
  EMAIL_PASSWORD: password,
  EMAIL_IMAP_HOST: '127.0.0.1',
  EMAIL_IMAP_PORT: String(imapPort),
  EMAIL_SMTP_HOST: '127.0.0.1',
  EMAIL_SMTP_PORT: String(smtpPort),
});

async function refusal(promise: Promise<unknown>): Promise<HubError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('Email is asked before it is linked', () => {
  it('signs in to IMAP and SMTP, and names the mailbox', async () => {
    const identity = await probePlatform(email, values(await imap(), await smtp('PLAIN')), {
      plainSockets: true,
    });
    expect(identity).toEqual({ id: USER, name: USER, username: null });
    expect(imapLogins.at(-1)).toBe(`a1 LOGIN "${USER}" "${PASSWORD}"`);
  });

  it('speaks AUTH LOGIN to a server that offers only that', async () => {
    const identity = await probePlatform(email, values(await imap(), await smtp('LOGIN')), {
      plainSockets: true,
    });
    expect(identity?.id).toBe(USER);
  });

  it('refuses a wrong password in the server’s own words', async () => {
    const error = await refusal(
      probePlatform(email, values(await imap(), await smtp('PLAIN'), 'wrong'), {
        plainSockets: true,
      }),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.details).toMatchObject({
      reason: 'credentials_rejected',
      field: 'EMAIL_PASSWORD',
      message: 'IMAP: [AUTHENTICATIONFAILED] Invalid credentials',
    });
  });

  it('says the server does not answer when nothing listens', async () => {
    const closed = await listen((socket) => socket.destroy());
    const error = await refusal(
      probePlatform(email, values(closed, closed), { plainSockets: true, timeoutMs: 2000 }),
    );
    expect(error.code).toBe('service_unavailable');
    expect(error.details).toMatchObject({ reason: 'platform_unreachable', platform: 'email' });
  });

  it('asks nothing of a platform the hub has no question for', async () => {
    expect(await probePlatform(platformSpec('signal')!, { SIGNAL_ACCOUNT: 'x' })).toBeNull();
  });
});
