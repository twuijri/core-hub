/**
 * What the `updates` module knows: which client builds exist, which channel a client
 * follows, and where builds come from.
 *
 * Two rules run through all of it.
 *
 * **A release is a row plus bytes this hub holds.** `download_url` is a path on this hub
 * and never a third-party URL (the contract says so, and a phone that follows a link we
 * did not serve is a phone we cannot vouch for). A release published from a `source_url`
 * is fetched here, checksummed here, and served from here.
 *
 * **A version is compared, never trusted.** A client sends `<release>[-<channel>.<build>]`;
 * the hub parses it, compares release then build, and answers `up_to_date` rather than
 * offering a build the client already has.
 */
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { releaseChannels, releases, updateSettings } from './schema.js';

export type ClientPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'linux';
export type ChannelKey = 'stable' | 'test';

/**
 * The contract's platform names and the table's. The table says `desktop_macos` because a
 * desktop build is a desktop build; the wire says `macos` because that is what a client
 * calls itself.
 */
const TO_ROW: Record<ClientPlatform, string> = {
  android: 'android',
  ios: 'ios',
  macos: 'desktop_macos',
  windows: 'desktop_windows',
  linux: 'desktop_linux',
};
const TO_WIRE = Object.fromEntries(
  Object.entries(TO_ROW).map(([wire, row]) => [row, wire]),
) as Record<string, ClientPlatform>;

export interface ParsedVersion {
  release: string;
  build: number;
}

/**
 * `1.0.2-test.22` -> `{ release: '1.0.2', build: 22 }`; `1.0.2` -> build 0.
 *
 * A build number the client did not send is 0, which loses to any real build — the hub
 * would rather offer an update twice than hide one.
 */
export function parseVersion(value: string): ParsedVersion {
  const [release = '0.0.0', suffix] = value.trim().split('-', 2);
  const build = suffix ? Number.parseInt(suffix.split('.').pop() ?? '0', 10) : 0;
  return { release, build: Number.isFinite(build) ? build : 0 };
}

/** Semver-ish comparison on the release segment: numeric where numeric, text otherwise. */
export function compareRelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number.parseInt(left[i] ?? '0', 10);
    const y = Number.parseInt(right[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const text = (left[i] ?? '').localeCompare(right[i] ?? '');
      if (text !== 0) return text;
      continue;
    }
    if (x !== y) return x - y;
  }
  return 0;
}

/** Is `candidate` newer than what the client has? Release first, then build. */
export function isNewer(candidate: ParsedVersion, current: ParsedVersion): boolean {
  const byRelease = compareRelease(candidate.release, current.release);
  if (byRelease !== 0) return byRelease > 0;
  return candidate.build > current.build;
}

export type ReleaseRow = typeof releases.$inferSelect;

export interface WireRelease {
  id: string;
  platform: ClientPlatform;
  channel: ChannelKey;
  version: string;
  build: number;
  notes: { ar: string; en: string };
  size_bytes: number;
  sha256: string;
  mandatory: boolean;
  download_url: string;
  published_at: string | null;
}

export function toRelease(row: ReleaseRow, channel: ChannelKey): WireRelease {
  return {
    id: row.id,
    platform: TO_WIRE[row.platform] ?? 'android',
    channel,
    version: row.version,
    build: row.buildNumber ?? 0,
    notes: { ar: row.notesAr ?? '', en: row.notesEn ?? '' },
    size_bytes: row.artifactSizeBytes ?? 0,
    sha256: row.artifactSha256 ?? '',
    mandatory: row.mandatory,
    // Always a path on this hub, whatever the artefact's origin was.
    download_url: `/api/v1/updates/releases/${row.id}/download`,
    published_at: row.publishedAt?.toISOString() ?? null,
  };
}

export interface Settings {
  default_channel: ChannelKey;
  source: { kind: 'manual' | 'github_release'; repo: string | null; token: '[stored]' | null };
  auto_publish: boolean;
}

export class UpdatesService {
  constructor(private readonly db: ModuleDb) {}

  // --------------------------------------------------------------- channels

  /** The channel row for a key, created on first use: a hub has `stable` and `test`. */
  channel(key: ChannelKey, ownerId: string): typeof releaseChannels.$inferSelect {
    const existing = this.db
      .select()
      .from(releaseChannels)
      .where(eq(releaseChannels.key, key))
      .get();
    if (existing) return existing;
    const id = newUlid();
    this.db
      .insert(releaseChannels)
      .values({
        id,
        ownerId,
        key,
        name: key === 'stable' ? 'Stable' : 'Test',
        isDefault: key === 'stable',
      })
      .run();
    return this.db.select().from(releaseChannels).where(eq(releaseChannels.id, id)).get()!;
  }

  keyOf(channelId: string): ChannelKey {
    const row = this.db
      .select()
      .from(releaseChannels)
      .where(eq(releaseChannels.id, channelId))
      .get();
    return (row?.key as ChannelKey) ?? 'stable';
  }

  // --------------------------------------------------------------- settings

  settings(): Settings {
    const row = this.db.select().from(updateSettings).limit(1).get();
    return {
      default_channel: (row?.defaultChannel as ChannelKey) ?? 'stable',
      source: {
        kind: (row?.sourceKind as 'manual' | 'github_release') ?? 'manual',
        repo: row?.sourceRepo ?? null,
        // Never the token itself: the contract only allows `[stored]` or null.
        token: row?.sourceToken ? '[stored]' : null,
      },
      auto_publish: row?.autoPublish ?? false,
    };
  }

  /** The stored token, for the hub's own fetches. Never leaves the server. */
  sourceToken(): string | null {
    return this.db.select().from(updateSettings).limit(1).get()?.sourceToken ?? null;
  }

  saveSettings(
    ownerId: string,
    patch: {
      default_channel?: ChannelKey;
      source?: { kind?: 'manual' | 'github_release'; repo?: string | null; token?: string | null };
      auto_publish?: boolean;
    },
  ): Settings {
    const current = this.db.select().from(updateSettings).limit(1).get();
    const values = {
      defaultChannel: patch.default_channel ?? current?.defaultChannel ?? 'stable',
      sourceKind: patch.source?.kind ?? current?.sourceKind ?? 'manual',
      sourceRepo:
        patch.source?.repo !== undefined ? patch.source.repo : (current?.sourceRepo ?? null),
      // A token is replaced only when a new one is sent; `[stored]` means "keep it", and
      // `null` means "forget it".
      sourceToken:
        patch.source?.token === undefined || patch.source.token === '[stored]'
          ? (current?.sourceToken ?? null)
          : patch.source.token,
      autoPublish: patch.auto_publish ?? current?.autoPublish ?? false,
    };
    if (current) {
      this.db
        .update(updateSettings)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(updateSettings.id, current.id))
        .run();
    } else {
      this.db
        .insert(updateSettings)
        .values({ id: newUlid(), ownerId, ...values })
        .run();
    }
    return this.settings();
  }

  // --------------------------------------------------------------- releases

  /** The newest published, unyanked release for a platform on a channel. */
  latest(platform: ClientPlatform, channelId: string): ReleaseRow | undefined {
    return this.db
      .select()
      .from(releases)
      .where(
        and(
          eq(releases.channelId, channelId),
          eq(releases.platform, TO_ROW[platform] as ReleaseRow['platform']),
          isNull(releases.yankedAt),
        ),
      )
      .orderBy(desc(releases.publishedAt))
      .limit(1)
      .get();
  }

  list(query: {
    platform?: ClientPlatform | undefined;
    channelId?: string | undefined;
    cursor?: string | null;
    limit: number;
  }): ReleaseRow[] {
    return this.db
      .select()
      .from(releases)
      .where(
        and(
          isNull(releases.yankedAt),
          query.platform
            ? eq(releases.platform, TO_ROW[query.platform] as ReleaseRow['platform'])
            : undefined,
          query.channelId ? eq(releases.channelId, query.channelId) : undefined,
          query.cursor ? lt(releases.id, query.cursor) : undefined,
        ),
      )
      .orderBy(desc(releases.id))
      .limit(query.limit)
      .all();
  }

  get(id: string): ReleaseRow | undefined {
    return this.db.select().from(releases).where(eq(releases.id, id)).get();
  }

  publish(input: {
    ownerId: string;
    channelId: string;
    platform: ClientPlatform;
    version: string;
    build: number;
    notes: { ar?: string; en?: string };
    mandatory: boolean;
    artifact: { attachmentId: string; workspace: string; sha256: string; sizeBytes: number } | null;
    sourceUrl: string | null;
    now?: number;
  }): ReleaseRow {
    const id = newUlid(input.now);
    this.db
      .insert(releases)
      .values({
        id,
        ownerId: input.ownerId,
        channelId: input.channelId,
        platform: TO_ROW[input.platform] as ReleaseRow['platform'],
        version: input.version,
        buildNumber: input.build,
        notesAr: input.notes.ar ?? null,
        notesEn: input.notes.en ?? null,
        artifactUrl: input.sourceUrl,
        artifactAttachmentId: input.artifact?.attachmentId ?? null,
        artifactWorkspace: input.artifact?.workspace ?? null,
        artifactSha256: input.artifact?.sha256 ?? null,
        artifactSizeBytes: input.artifact?.sizeBytes ?? null,
        mandatory: input.mandatory,
        publishedAt: new Date(input.now ?? Date.now()),
      })
      .run();
    return this.get(id)!;
  }

  /** Unpublish: the row stays, so a client that already has the build still checks out. */
  yank(id: string, now: number = Date.now()): boolean {
    const row = this.get(id);
    if (!row || row.yankedAt) return false;
    this.db
      .update(releases)
      .set({ yankedAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(releases.id, id))
      .run();
    return true;
  }
}
