/**
 * This computer as a device of a hub on a server (ADR 0025): the app's main process keeps its
 * own outbound connection to the hub's `/rt/devices`, with the device token pairing gave it, so
 * it answers while the window is closed or the app sits in the tray. Nothing listens on this
 * computer: the connection goes out, and the hub sends requests down it.
 *
 * - **Reach**: Socket.IO with growing back-off (1 s up to a minute); a hub that refuses the
 *   token (the device was unlinked there) is not asked again until the person links again.
 * - **What it says**: whenever the helper changes, it reports its folders, programs and their
 *   tools (`devices.update` → `helper`) and switches `files` / `apps` on or off.
 * - **What it answers**: `request.created` for `files` or `apps`, and on every connect the
 *   pending ones it missed; each is handed to the helper's own handlers and the result posted
 *   with `devices.respondRequest`. A file for the chat goes up with the resumable upload.
 */
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { HubApiError, createHubClient, type HubClient } from '@corehub/contracts';

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

export interface HelperReport {
  folders: Array<{ path: string; write: boolean; default?: boolean }>;
  allow_open: boolean;
  programs: Array<{
    id: string;
    name: string;
    source: string;
    profiles: string[];
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  }>;
}

export interface DeviceLinkOptions {
  hub: string;
  token: string;
  deviceId: string;
  /** The profiles to catch up in after a reconnect (the person's, from pairing). */
  profiles: () => string[];
  /** What the helper offers now; null when it is off. */
  report: () => HelperReport | null;
  /** The handlers: a result for the request, or a `RequestRefusal`. */
  answer: (request: DeviceRequestView, link: DeviceLink) => Promise<Record<string, unknown>>;
  onStatus?: (status: LinkStatus, detail: string | null) => void;
  fetchImpl?: typeof fetch;
  /** Tests shorten the back-off. */
  reconnectDelayMs?: number;
  reconnectDelayMaxMs?: number;
}

/** Handshake refusals that mean "this token is no good here any more". */
const REFUSED = new Set(['unauthorized', 'token_expired', 'token_revoked', 'forbidden']);
const CHUNK = 256 * 1024;
export const MAX_SEND_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
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
  readonly client: HubClient;

  constructor(private readonly options: DeviceLinkOptions) {
    this.client = createHubClient({
      baseUrl: options.hub,
      token: options.token,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  get hub(): string {
    return this.options.hub;
  }

  get deviceId(): string {
    return this.options.deviceId;
  }

  state(): { status: LinkStatus; detail: string | null } {
    return { status: this.status, detail: this.detail };
  }

  start(): void {
    if (this.socket) return;
    this.setStatus('connecting', null);
    const socket = io(`${this.options.hub}/rt/devices`, {
      path: '/rt',
      auth: { token: this.options.token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: this.options.reconnectDelayMs ?? 1_000,
      reconnectionDelayMax: this.options.reconnectDelayMaxMs ?? 60_000,
      randomizationFactor: 0.3,
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.setStatus('connected', null);
      void this.renew();
      void this.sendReport();
      void this.catchUp();
    });
    socket.on('disconnect', (reason) => {
      if (this.status !== 'refused' && this.status !== 'stopped') this.setStatus('offline', reason);
    });
    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      const code = error.data?.code ?? error.message;
      if (REFUSED.has(code)) {
        // The hub does not know this token any more (unlinked, revoked): stop asking.
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

  async stop(): Promise<void> {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.setStatus('stopped', null);
    socket?.disconnect();
  }

  /** Something the helper offers changed: say so, a moment later (several changes, one report). */
  reportSoon(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      void this.sendReport();
    }, 300);
  }

  async sendReport(): Promise<void> {
    const report = this.options.report();
    const on = report !== null;
    const programs = on && report.programs.length > 0;
    try {
      await this.client.raw('patch', '/devices/{device_id}', {
        params: { device_id: this.options.deviceId },
        body: {
          capabilities: [
            { kind: 'notifications', enabled: true, consent_at: null },
            { kind: 'files', enabled: on, consent_at: null },
            { kind: 'apps', enabled: programs, consent_at: null },
          ],
          helper: report ? { ...report, reported_at: new Date().toISOString() } : null,
        },
      });
    } catch (error) {
      if (error instanceof HubApiError && (error.status === 401 || error.status === 404)) {
        this.setStatus('refused', error.code);
        this.socket?.disconnect();
      }
    }
  }

  /**
   * A pairing token lasts months; each connect renews it (`auth.refresh` with no body), at
   * most once a day, so a computer that stays linked never finds itself signed out.
   */
  private renewedAt = 0;
  async renew(): Promise<void> {
    if (Date.now() - this.renewedAt < 24 * 60 * 60 * 1000) return;
    this.renewedAt = Date.now();
    await this.client.raw('post', '/auth/refresh').catch(() => undefined);
  }

  /** The requests that arrived while this computer was away. */
  async catchUp(): Promise<void> {
    for (const profile of this.options.profiles()) {
      try {
        const { data } = await this.client.raw('get', '/device-requests', {
          query: { status: 'pending', device_id: this.options.deviceId, limit: 50 },
          headers: { 'X-Hub-Profile': profile },
        });
        for (const request of (data as { items?: DeviceRequestView[] })?.items ?? [])
          void this.handle(request);
      } catch {
        // That profile is not the person's any more, or the hub is busy: the next connect tries.
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
      await this.client
        .raw('post', '/device-requests/{request_id}/respond', {
          params: { request_id: request.id },
          body,
          headers: { 'X-Hub-Profile': request.profile },
        })
        .catch(() => undefined); // Expired or answered meanwhile: nothing more to say.
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  /**
   * A file from this computer, into the request's profile as an attachment, with the
   * contract's resumable upload (so a large render survives a slow line).
   */
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
    const started = await this.client.raw('post', '/attachment-uploads', {
      body: { name, mime, size_bytes: size, purpose: 'message' },
      headers,
    });
    const upload = started.data as { id: string; chunk_bytes?: number };
    const chunkBytes = upload.chunk_bytes ?? CHUNK;
    let offset = 0;
    for await (const chunk of createReadStream(file, { highWaterMark: chunkBytes })) {
      const bytes = chunk as Buffer;
      const view = new Uint8Array(bytes.byteLength);
      view.set(bytes);
      await this.client.raw('put', '/attachment-uploads/{upload_id}', {
        params: { upload_id: upload.id },
        query: { offset },
        body: view.buffer,
        headers,
      });
      offset += bytes.byteLength;
    }
    const done = await this.client.raw('post', '/attachment-uploads/{upload_id}/complete', {
      params: { upload_id: upload.id },
      headers,
    });
    const attachment = done.data as {
      id: string;
      name: string;
      mime: string;
      size_bytes: number;
      kind: string;
    };
    return {
      attachment_id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size_bytes: attachment.size_bytes,
      kind: attachment.kind,
    };
  }

  private setStatus(status: LinkStatus, detail: string | null): void {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.options.onStatus?.(status, detail);
  }
}
