// The browser's token store: one JSON document in localStorage. Same shape as the reference
// client's config file minus `server` (the web app is always same-origin with the hub).
export interface StoredUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
}

export interface StoredSession {
  /** Workspace slug sent as `X-Hub-Profile` (ADR 0005). */
  profile: string;
  token: string;
  refresh_token: string | null;
  /** ISO time when `token` stops working; the client refreshes before that. */
  expires_at: string | null;
  user: StoredUser;
}

const KEY = 'majlis.session';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class SessionStore {
  private listeners = new Set<() => void>();
  private cached: StoredSession | null | undefined;

  constructor(private readonly storage: StorageLike | null) {}

  read(): StoredSession | null {
    if (this.cached !== undefined) return this.cached;
    if (!this.storage) return (this.cached = null);
    try {
      const raw = this.storage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      this.cached = isSession(parsed) ? parsed : null;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  save(session: StoredSession): void {
    this.cached = session;
    try {
      this.storage?.setItem(KEY, JSON.stringify(session));
    } catch {
      // The session still lives in memory for this page.
    }
    this.emit();
  }

  clear(): void {
    this.cached = null;
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nothing to forget
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function isSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.profile === 'string' &&
    typeof s.token === 'string' &&
    (s.refresh_token === null || typeof s.refresh_token === 'string') &&
    (s.expires_at === null || typeof s.expires_at === 'string') &&
    !!s.user &&
    typeof s.user === 'object' &&
    typeof (s.user as Record<string, unknown>).id === 'string'
  );
}

export function expiresAt(expiresInSeconds: number, now: number = Date.now()): string {
  return new Date(now + expiresInSeconds * 1000).toISOString();
}
