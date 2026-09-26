/**
 * The Tailscale route (DECISIONS §92): when this computer is on a tailnet, the app listens on its
 * tailnet address — that address only, never 0.0.0.0 or the LAN — and passes each connection to
 * the hub on the loopback. Only machines on the person's own tailnet can reach that address, and
 * the hub asks them to sign in like anyone else.
 *
 * The tailnet address comes from the network interfaces (100.64.0.0/10); the MagicDNS name, when
 * there is one, from `tailscale status --json` if the Tailscale program is where its installers
 * put it. Neither needs Tailscale's cooperation beyond being installed and connected.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tailnetAddress, tailscaleDnsName } from '../shared/relay.js';

export interface TailnetFound {
  address: string;
  dns_name: string | null;
}

/** Where Tailscale's program is on each platform, besides PATH. */
export function tailscaleCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin')
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'];
  if (platform === 'win32')
    return [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
}

export interface DetectOptions {
  interfaces?: () => ReturnType<typeof os.networkInterfaces>;
  /** `tailscale status --json`, or null when there is no program to ask. */
  status?: () => Promise<string | null>;
}

function runTailscaleStatus(): Promise<string | null> {
  const program = tailscaleCandidates(process.platform, process.env).find((p) => existsSync(p));
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      program,
      ['status', '--json'],
      { timeout: 4_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

export async function detectTailnet(options: DetectOptions = {}): Promise<TailnetFound | null> {
  const address = tailnetAddress((options.interfaces ?? os.networkInterfaces)());
  if (!address) return null;
  let dnsName: string | null = null;
  try {
    const status = await (options.status ?? runTailscaleStatus)();
    dnsName = status ? tailscaleDnsName(status) : null;
  } catch {
    dnsName = null;
  }
  return { address, dns_name: dnsName };
}

/** A plain TCP pass-through from `host:port` to the hub on 127.0.0.1. */
export class Forwarder {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly target: () => number | null) {}

  get listening(): boolean {
    return this.server?.listening === true;
  }

  listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((incoming) => {
        const hubPort = this.target();
        if (!hubPort) {
          incoming.destroy();
          return;
        }
        const outgoing = createConnection({ host: '127.0.0.1', port: hubPort });
        for (const socket of [incoming, outgoing]) {
          this.sockets.add(socket);
          socket.once('close', () => this.sockets.delete(socket));
          socket.on('error', () => {
            incoming.destroy();
            outgoing.destroy();
          });
        }
        incoming.pipe(outgoing);
        outgoing.pipe(incoming);
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
