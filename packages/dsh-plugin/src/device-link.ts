/**
 * This computer as a device of the hub (ADR 0033 §4; ADR 0025 decision 1), ported from the
 * desktop app's `device-link.ts`: the plugin keeps its own outbound Socket.IO connection to the
 * hub's `/rt/devices` with the app token the pairing gave it. Nothing listens on this computer.
 *
 * - **Reach**: growing back-off, 1 s up to a minute; a hub that refuses the token is not asked
 *   again until the person links again.
 * - **What it says**: whenever the settings change, it reports the shared folders, the programs
 *   and their tools, and which capabilities are on (`devices.update`). A hub whose contract does
 *   not know a newer value yet (`screen_task`, the harness's program source) refuses the report
 *   with 400; the link then reports again without it, so an older hub still gets the folders.
 * - **What it answers**: `request.created` for this device, and on every connect the pending
 *   ones it missed; each is answered once with `devices.respondRequest`.
 */
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { HubApiError, type HubClient } from '@corehub/contracts';
import { PROGRAM_SOURCE, SCREEN_CAPABILITY } from './names.js';
import { LinkRefused } from './hub.js';

export type LinkStatus = 'connecting' | 'connected' | 'offline' | 'refused' | 'stopped';

export interface DeviceRequestView {
  id: string;
  profile: string;
  device_id: string;
  capability: string;
  params: Record<string, unknown>;
  status: string;
  purpose: string | null;
}

/** A refusal the device sends back (`DeviceRequestError.code`). */
export class RequestRefusal extends Error {
  constructor(
    readonly code: 'permission_denied' | 'unavailable' | 'failed',
    message: string,
    readonly status: 'denied' | 'failed' = code === 'permission_denied' ? 'denied' : 'failed',
  ) {
    super(message);
    this.name = 'RequestRefusal';
  }
}

export interface DeviceReport {
  folders: Array<{ path: string; write: boolean }>;
  allow_open: boolean;
  programs: Array<{
    id: string;
    name: string;
    profiles: string[];
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  }>;
  screen: boolean;
}

/**
 * The `devices.update` bodies to try, newest first: everything, then without what an older hub
 * refuses. `left_out` names what a body leaves out.
 */
export function reportBodies(
  report: DeviceReport,
  at: string,
): Array<{ left_out: 'screen_task' | 'programs' | null; body: Record<string, unknown> }> {
  const files = report.folders.length > 0;
  const body = (programs: boolean, screen: boolean) => ({
    capabilities: [
      { kind: 'notifications', enabled: false, consent_at: null },
      { kind: 'files', enabled: files, consent_at: null },
      { kind: 'apps', enabled: programs && report.programs.length > 0, consent_at: null },
      ...(screen ? [{ kind: SCREEN_CAPABILITY, enabled: true, consent_at: null }] : []),
    ],
    helper: {
      folders: report.folders,
      allow_open: report.allow_open,
      programs: programs ? report.programs.map((p) => ({ ...p, source: PROGRAM_SOURCE })) : [],
      reported_at: at,
    },
  });
  const bodies: ReturnType<typeof reportBodies> = [
    { left_out: null, body: body(true, report.screen) },
  ];
  if (report.screen) bodies.push({ left_out: 'screen_task', body: body(true, false) });
  if (report.programs.length > 0) bodies.push({ left_out: 'programs', body: body(false, false) });
  return bodies;
}

export interface DeviceLinkOptions {
  hub: string;
  token: () => string;
  deviceId: string;
  client: HubClient;
  /** The profiles to catch up in after a reconnect. */
  profiles: () => string[];
  report: () => DeviceReport;
  answer: (request: DeviceRequestView, link: DeviceLink) => Promise<Record<string, unknown>>;
  onStatus?: (status: LinkStatus, detail: string | null) => void;
  /** Before a connect: renew the token when it is due. */
  beforeConnect?: () => Promise<void>;
  reconnectDelayMs?: number;
  reconnectDelayMaxMs?: number;
  connect?: typeof io;
}

const REFUSED = new Set(['unauthorized', 'token_expired', 'token_revoked', 'forbidden']);
const CHUNK = 256 * 1024;
export const MAX_SEND_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export class DeviceLink {
  private socket: Socket | null = null;
  private status: LinkStatus = 'stopped';
  private detail: string | null = null;
  private readonly inFlight = new Set<string>();
  private reportTimer: NodeJS.Timeout | null = null;
  /** What the last accepted report left out because the hub did not know it. */
  private degraded: string | null = null;

  constructor(private readonly options: DeviceLinkOptions) {}

  get hub(): string {
    return this.options.hub;
  }

  get client(): HubClient {
    return this.options.client;
  }

  state(): { status: LinkStatus; detail: string | null; degraded: string | null } {
    return { status: this.status, detail: this.detail, degraded: this.degraded };
  }

  async start(): Promise<void> {
    if (this.socket) return;
    this.setStatus('connecting', null);
    await this.options.beforeConnect?.().catch(() => undefined);
    const connect = this.options.connect ?? io;
    const socket = connect(`${this.options.hub}/rt/devices`, {
      path: '/rt',
      // A function: every reconnect sends the token as it is now.
      auth: (cb: (data: object) => void) => cb({ token: this.options.token() }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: this.options.reconnectDelayMs ?? 1_000,
      reconnectionDelayMax: this.options.reconnectDelayMaxMs ?? 60_000,
      randomizationFactor: 0.3,
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.setStatus('connected', null);
      void this.sendReport();
      void this.catchUp();
    });
    socket.on('disconnect', (reason) => {
      if (this.status !== 'refused' && this.status !== 'stopped') this.setStatus('offline', reason);
    });
    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      const code = error.data?.code ?? error.message;
      if (REFUSED.has(code)) {
        this.setStatus('refused', code);
        socket.disconnect();
        return;
      }
      this.setStatus('offline', error.message);
    });
    socket.on('request.created', (envelope: { payload?: { request?: DeviceRequestView } }) => {
      const request = envelope?.payload?.request;
      if (request && request.device_id === this.options.deviceId) void this.handle(request);
    });
  }

  stop(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.setStatus('stopped', null);
    socket?.disconnect();
  }

  /** Something offered changed: say so a moment later (several changes, one report). */
  reportSoon(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      void this.sendReport();
    }, 300);
  }

  async sendReport(): Promise<void> {
    const bodies = reportBodies(this.options.report(), new Date().toISOString());
    for (const { left_out, body } of bodies) {
      try {
        await this.options.client.raw('patch', '/devices/{device_id}', {
          params: { device_id: this.options.deviceId },
          body,
        });
        this.degraded = left_out;
        return;
      } catch (error) {
        if (error instanceof HubApiError && error.status === 400) continue;
        if (error instanceof HubApiError && (error.status === 401 || error.status === 404)) {
          this.setStatus('refused', error.code);
          this.socket?.disconnect();
        }
        return;
      }
    }
  }

  /** The requests that arrived while this computer was away. */
  async catchUp(): Promise<void> {
    for (const profile of this.options.profiles()) {
      try {
        const { data } = await this.options.client.raw('get', '/device-requests', {
          query: { status: 'pending', device_id: this.options.deviceId, limit: 50 },
          headers: { 'X-Hub-Profile': profile },
        });
        for (const request of (data as { items?: DeviceRequestView[] })?.items ?? [])
          void this.handle(request);
      } catch {
        // Not the person's profile any more, or the hub is busy: the next connect tries.
      }
    }
  }

  /** One request: answered once, whatever happens. */
  async handle(request: DeviceRequestView): Promise<void> {
    if (request.status !== 'pending' || this.inFlight.has(request.id)) return;
    this.inFlight.add(request.id);
    try {
      let body: Record<string, unknown>;
      try {
        const result = await this.options.answer(request, this);
        body = { status: 'fulfilled', result, error: null };
      } catch (error) {
        const refusal =
          error instanceof RequestRefusal
            ? error
            : new RequestRefusal('failed', error instanceof Error ? error.message : String(error));
        body = {
          status: refusal.status,
          result: null,
          error: { code: refusal.code, message: refusal.message.slice(0, 1000) },
        };
      }
      const send = (payload: Record<string, unknown>) =>
        this.options.client.raw('post', '/device-requests/{request_id}/respond', {
          params: { request_id: request.id },
          body: payload,
          headers: { 'X-Hub-Profile': request.profile },
        });
      try {
        await send(body);
      } catch (error) {
        // An answer the hub will not take (a shape it does not know) must not leave the agent
        // waiting for the request's whole wait: say why instead (owner's Mac, 2026-11-22).
        if (body.status === 'fulfilled' && !(error instanceof LinkRefused)) {
          const why = error instanceof Error ? error.message : String(error);
          await send({
            status: 'failed',
            result: null,
            error: {
              code: 'failed',
              message: `The hub did not accept this computer's answer: ${why}`.slice(0, 1000),
            },
          }).catch(() => undefined);
        }
      }
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  /** A file from this computer into the request's profile, with the resumable upload. */
  async upload(
    profile: string,
    file: string,
  ): Promise<{
    attachment_id: string;
    name: string;
    mime: string;
    size_bytes: number;
    kind: string;
  }> {
    const size = statSync(file).size;
    if (size === 0) throw new RequestRefusal('failed', 'That file is empty.');
    if (size > MAX_SEND_BYTES)
      throw new RequestRefusal('failed', `That file is over ${MAX_SEND_BYTES / 1024 / 1024} MB.`);
    const headers = { 'X-Hub-Profile': profile };
    const name = path.basename(file);
    const mime = mimeOf(file);
    const started = await this.options.client.raw('post', '/attachment-uploads', {
      body: { name, mime, size_bytes: size, purpose: 'message' },
      headers,
    });
    const upload = started.data as { id: string; chunk_bytes?: number };
    let offset = 0;
    for await (const chunk of createReadStream(file, {
      highWaterMark: upload.chunk_bytes ?? CHUNK,
    })) {
      const bytes = chunk as Buffer;
      const view = new Uint8Array(bytes.byteLength);
      view.set(bytes);
      await this.options.client.raw('put', '/attachment-uploads/{upload_id}', {
        params: { upload_id: upload.id },
        query: { offset },
        body: view.buffer,
        headers,
      });
      offset += bytes.byteLength;
    }
    const done = await this.options.client.raw('post', '/attachment-uploads/{upload_id}/complete', {
      params: { upload_id: upload.id },
      headers,
    });
    const a = done.data as {
      id: string;
      name: string;
      mime: string;
      size_bytes: number;
      kind: string;
    };
    return {
      attachment_id: a.id,
      name: a.name,
      mime: a.mime,
      size_bytes: a.size_bytes,
      kind: a.kind,
    };
  }

  private setStatus(status: LinkStatus, detail: string | null): void {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.options.onStatus?.(status, detail);
  }
}
