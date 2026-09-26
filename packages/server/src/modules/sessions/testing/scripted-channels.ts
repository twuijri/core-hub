/**
 * A scripted Hermes for channel conversations (contract decisions §61, §88): answers the
 * calls `channel-conversations.ts` makes to Hermes's server the way Hermes does
 * (`hermes_cli/web_routers/sessions.py`, `v2026.9.14`) — `GET /api/sessions` filtered by
 * `sources`, most recent first, capped by `limit`; one session's row, `404 {"detail":
 * "Session not found"}` for an unknown id; its messages, the latest page when `order=latest`;
 * and `DELETE` of one session, `{"ok": true}` (`already_absent` for one already gone).
 *
 * Test scaffolding in the source tree on purpose, like `fake-runner.ts`: the unit tests, the
 * contract test and the e2e hub drive the real routes and the real reader against it. It is
 * never wired into the default module list.
 */
import {
  ChannelSourceRefusal,
  ChannelSourceUnavailable,
  type ChannelSource,
  type HermesMessage,
  type HermesSessionRow,
} from '../channel-conversations.js';

export interface ScriptedProfile {
  sessions: HermesSessionRow[];
  messages?: Record<string, HermesMessage[]>;
  /** Picture files in the profile's image cache, by name, with where they are (§103). */
  pictures?: Record<string, string>;
}

export interface ScriptedChannels extends ChannelSource {
  /** Every path asked, in order. */
  readonly calls: string[];
  /** The store of each Hermes profile; change it, then `touch` it, as a message would. */
  readonly profiles: Record<string, ScriptedProfile>;
  /** Hermes wrote this profile's store: its stamp changes. */
  touch(profile: string): void;
  /** While set, every call fails as if Hermes's server were not there. */
  down: boolean;
}

export function scriptedChannels(
  profiles: Record<string, ScriptedProfile>,
  options: {
    /** Which Hermes profile a workspace is. Default: none. */
    profileOf?: (workspace: string) => string | null;
    /** `false`: the store cannot be told apart (stamp `null`). */
    stamps?: boolean;
  } = {},
): ScriptedChannels {
  const calls: string[] = [];
  const writes = new Map<string, number>();
  const source: ScriptedChannels = {
    calls,
    profiles,
    down: false,
    touch(profile) {
      writes.set(profile, (writes.get(profile) ?? 0) + 1);
    },
    hermesProfile: (workspace) => options.profileOf?.(workspace) ?? null,
    stamp: (profile) =>
      options.stamps === false ? null : `${profile}:${writes.get(profile) ?? 0}`,
    picture: (profile, name) => profiles[profile]?.pictures?.[name] ?? null,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (source.down) throw new ChannelSourceUnavailable('connect ECONNREFUSED 127.0.0.1');
      const url = new URL(path, 'http://hermes.test');
      const store = profiles[url.searchParams.get('profile') ?? 'default'] ?? { sessions: [] };
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      // /api/sessions
      if (parts.length === 2) {
        const sources = (url.searchParams.get('sources') ?? '').split(',').filter(Boolean);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const all = store.sessions
          .filter((row) => sources.length === 0 || sources.includes(row.source ?? ''))
          .sort(
            (a, b) => (b.last_active ?? b.started_at ?? 0) - (a.last_active ?? a.started_at ?? 0),
          );
        const rows = all.slice(offset, offset + limit);
        return { sessions: rows, total: all.length, limit, offset } as T;
      }
      const row = store.sessions.find((each) => each.id === parts[2]);
      if (!row) throw new ChannelSourceRefusal(404, 'Session not found');
      // /api/sessions/{id}
      if (parts.length === 3) return { ...row, system_prompt: 'x'.repeat(64) } as T;
      // /api/sessions/{id}/messages
      const all = store.messages?.[row.id] ?? [];
      const asked = url.searchParams.get('limit');
      const limit = asked === null ? 500 : Math.min(Number(asked), 500);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const latest = url.searchParams.get('order') === 'latest' || asked === null;
      // `latest` pages back from the newest, and answers each page oldest first.
      const page = latest
        ? all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset))
        : all.slice(offset, offset + limit);
      return {
        session_id: row.id,
        messages: page,
        pagination: { limit, offset, returned: page.length },
      } as T;
    },
    /** `DELETE /api/sessions/{id}`: gone, with its messages; one already gone is fine. */
    async delete<T>(path: string): Promise<T> {
      calls.push(`DELETE ${path}`);
      if (source.down) throw new ChannelSourceUnavailable('connect ECONNREFUSED 127.0.0.1');
      const url = new URL(path, 'http://hermes.test');
      const store = profiles[url.searchParams.get('profile') ?? 'default'] ?? { sessions: [] };
      const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[2] ?? '');
      const at = store.sessions.findIndex((each) => each.id === id);
      if (at < 0) return { ok: true, already_absent: true } as T;
      store.sessions.splice(at, 1);
      if (store.messages) delete store.messages[id];
      writes.set(url.searchParams.get('profile') ?? 'default', (writes.get(id) ?? 0) + 1);
      return { ok: true } as T;
    },
  };
  return source;
}
