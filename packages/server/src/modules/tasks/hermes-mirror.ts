/**
 * The hub's board reflecting Hermes's.
 *
 * `hermes-kanban.ts` and `hermes-api.ts` talk to Hermes; this decides **when** and **what
 * it means** for the hub's rows. Three rules, all of them the owner's (2026-09-23, 2026-09-24):
 *
 * 1. **The hub's board is the one page.** Hermes's cards appear on it beside every other
 *    card, as rows of their own, so filters, order and the four columns work on them.
 * 2. **Hermes wins.** On every read, Hermes's title, body, status and result overwrite
 *    the reflection. A card Hermes archived or deleted is archived here. Where the hub
 *    runs Hermes's server, Hermes's priority, its comments and the profile it gave the card
 *    to (which is a workspace, ADR 0014) are reflected too.
 * 3. **Writes go through Hermes.** Moving a card goes through Hermes's CLI; editing its
 *    words or priority, deleting it, commenting, stopping its run and handing it to another
 *    profile go through Hermes's own server (ADR 0015) — first, before the hub touches the
 *    row. If Hermes refuses, the hub refuses with Hermes's own sentence and changes nothing;
 *    if Hermes accepts, the reflection is refreshed from Hermes's answer, not from what the
 *    person typed. Without Hermes's server (Hermes not supervised here) those writes are
 *    refused, because the next read would undo them.
 *
 * Sync happens **on read**, throttled — not in a timer. A board nobody is looking at does
 * not need to be current, and a background loop would be one more thing that runs at
 * 3 a.m. for no one.
 */
import type { HermesKanban, HermesTask } from './hermes-kanban.js';
import type { TasksService, TaskStatus } from './service.js';
import type { CommentRow, TaskRow } from './serialize.js';
import { HERMES_STATUSES } from './hermes-kanban.js';
import {
  fromHermesPriority,
  toHermesPriority,
  type HermesCardApi,
  type HermesComment,
  type HubPriority,
} from './hermes-api.js';

interface Scope {
  workspace: string;
  profile: string;
  userId: string;
}

/** What the mirror needs from the rest of the hub. Composed in `modules/index.ts`. */
export interface HermesBoardPort {
  /** Hermes's kanban, or `null` when there is no Hermes on this hub. */
  kanban(): HermesKanban | null;
  /** The registry id of the Hermes agent in this workspace, for the card's assignee. */
  agentId(workspace: string): string | null;
  /** How stale the reflection may be when someone opens the board. Five seconds by default. */
  throttleMs?: number;
  /**
   * Hermes's own server, for the writes its CLI cannot make (ADR 0015) — or `null` where
   * the hub does not supervise Hermes. Absent or `null`: those writes are refused, as before.
   */
  api?(): HermesCardApi | null;
  /**
   * Every workspace with the name of its Hermes profile (a workspace is a Hermes profile,
   * ADR 0014), so a card Hermes gave to a profile shows in that workspace and a card handed
   * to a workspace goes to its profile.
   */
  profiles?(): Array<{ workspace: string; slug: string; profile: string }>;
}

export interface SyncReport {
  added: number;
  updated: number;
  archived: number;
  /** Set when Hermes could not be read; the board still answers with what it has. */
  error: string | null;
}

const KNOWN = new Set<string>(HERMES_STATUSES);

/** A card done for this long goes to the archive (owner decision, 2026-09-23). */
export const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export class HermesMirror {
  private readonly lastSync = new Map<string, number>();

  constructor(
    private readonly port: HermesBoardPort,
    private readonly options: {
      throttleMs?: number;
      now?: () => Date;
      archiveAfterMs?: number;
    } = {},
  ) {}

  /**
   * Bring the reflection up to date with Hermes, at most once per `throttleMs`.
   *
   * Never throws: a Hermes that cannot be read leaves the board showing its last
   * reflection, and the report says why. A board that errored because a helper did would
   * hide every other card from the person with it.
   */
  async sync(service: TasksService, scope: Scope, force = false): Promise<SyncReport | null> {
    const kanban = this.port.kanban();
    if (!kanban) return null;
    const now = this.options.now?.() ?? new Date();
    const last = this.lastSync.get(scope.workspace) ?? 0;
    if (!force && now.getTime() - last < (this.options.throttleMs ?? this.port.throttleMs ?? 5_000))
      return null;
    this.lastSync.set(scope.workspace, now.getTime());

    let cards: HermesTask[];
    try {
      cards = await kanban.list();
    } catch (error) {
      return {
        added: 0,
        updated: 0,
        archived: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Past this point nothing may escape either: a card that does not fit, or a board
    // that cannot be written, is reported — never a Tasks page that fails for everyone.
    try {
      return await this.reflect(service, scope, kanban, cards, now);
    } catch (error) {
      return {
        added: 0,
        updated: 0,
        archived: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async reflect(
    service: TasksService,
    scope: Scope,
    kanban: HermesKanban,
    cards: HermesTask[],
    now: Date,
  ): Promise<SyncReport> {
    if (!Array.isArray(cards)) throw new Error('hermes kanban list did not answer a list');
    // Done for a week goes to the archive (owner decision, 2026-09-23) — on Hermes, which
    // owns the card, in one call; the next list then leaves them out like any archived card.
    const cutoff = now.getTime() - (this.options.archiveAfterMs ?? ARCHIVE_AFTER_MS);
    const stale = cards
      .filter((card) => card.status === 'done' && card.completed_at)
      .filter((card) => card.completed_at! * 1000 < cutoff)
      .map((card) => card.id);
    let archivedOnHermes = new Set<string>();
    if (stale.length > 0) {
      try {
        await kanban.archive(stale);
        archivedOnHermes = new Set(stale);
      } catch {
        // Hermes kept them; they stay in Done and the next read tries again.
      }
    }

    const agentId = this.port.agentId(scope.workspace);
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    for (const card of cards) {
      // A status this release does not know is skipped rather than guessed at: showing a
      // card in the wrong column is worse than showing it on the next release.
      if (!KNOWN.has(card.status) || !card.id || typeof card.title !== 'string') continue;
      if (archivedOnHermes.has(card.id)) continue;
      seen.add(card.id);
      const { created } = service.reflectExternal(scope, this.input(card, agentId), now);
      if (created) added += 1;
      else updated += 1;
    }

    // `list` leaves archived cards out, so a reflection Hermes no longer lists was archived
    // or deleted there. Either way it is not work any more — and Hermes wins.
    let archived = 0;
    for (const row of service.externalRows(scope, 'hermes')) {
      if (row.externalId && !seen.has(row.externalId) && row.status !== 'archived') {
        service.reflectExternal(
          scope,
          {
            source: 'hermes',
            id: row.externalId,
            title: row.title,
            body: row.description,
            status: 'archived',
            result: row.latestSummary,
            agentId,
          },
          now,
        );
        archived += 1;
      }
    }
    return { added, updated, archived, error: null };
  }

  /**
   * Ask Hermes to move its card before the hub moves the reflection.
   *
   * Throws `HermesRefusal` with Hermes's own sentence when Hermes says no — the caller
   * answers 409 with it and does not touch the row. A card that is not Hermes's is left
   * alone: this returns and the hub moves it as it always has.
   */
  async moveThrough(row: TaskRow, to: TaskStatus, reason?: string | null): Promise<void> {
    if (row.externalSource !== 'hermes' || !row.externalId) return;
    const kanban = this.port.kanban();
    if (!kanban) return;
    await kanban.move(row.externalId, row.status, to, reason);
  }

  /** Put a new card on Hermes's board, using the hub's id so a retry finds the same card. */
  async createThrough(input: {
    id: string;
    title: string;
    body: string | null;
    triage: boolean;
    /** The workspace the card is made in: it goes to that workspace's Hermes profile. */
    workspace?: string;
    priority?: HubPriority;
  }): Promise<string | null> {
    const kanban = this.port.kanban();
    if (!kanban) return null;
    const assignee = input.workspace ? this.profileOf(input.workspace) : null;
    const priority =
      input.priority && input.priority !== 'normal' ? toHermesPriority(input.priority) : null;
    const card = await kanban.create({
      title: input.title,
      body: input.body,
      idempotencyKey: input.id,
      triage: input.triage,
      ...(assignee ? { assignee } : {}),
      ...(priority !== null ? { priority } : {}),
    });
    return card.id;
  }

  // ------------------------------------------------ Hermes's server (ADR 0015)

  /** Hermes's own server, or `null` where the hub does not run it. */
  api(): HermesCardApi | null {
    if (!this.port.kanban()) return null;
    return this.port.api?.() ?? null;
  }

  /** Start Hermes's server in the background when a page that will need it opens. */
  warm(): void {
    this.api()?.warm();
  }

  /** The Hermes profile a workspace is (ADR 0014), or `null` when the port does not say. */
  profileOf(workspace: string): string | null {
    return this.port.profiles?.().find((entry) => entry.workspace === workspace)?.profile ?? null;
  }

  /** The workspace a Hermes profile is, by id; `null` for a profile the hub has no workspace for. */
  workspaceOf(profile: string | null | undefined): string | null {
    if (!profile) return null;
    return this.port.profiles?.().find((entry) => entry.profile === profile)?.workspace ?? null;
  }

  /** The workspace with this slug or id, with its Hermes profile. */
  target(slugOrId: string): { workspace: string; slug: string; profile: string } | null {
    return (
      this.port
        .profiles?.()
        .find((entry) => entry.slug === slugOrId || entry.workspace === slugOrId) ?? null
    );
  }

  /**
   * What the hub reflects of one of Hermes's cards. Priority and the profile it is given to
   * are reflected only where the hub can write them back through Hermes's server — without
   * it they stay the hub's, as they always were, rather than being undone on every read.
   */
  private input(card: HermesTask, agentId: string | null) {
    const writable = this.api() !== null;
    return {
      source: 'hermes' as const,
      id: card.id,
      title: card.title,
      body: card.body ?? null,
      status: card.status as TaskStatus,
      result: card.result ?? null,
      agentId,
      completedAt: card.completed_at ? new Date(card.completed_at * 1000) : null,
      ...(writable
        ? {
            priority: fromHermesPriority(card.priority),
            workspace: this.workspaceOf(card.assignee),
          }
        : {}),
    };
  }

  /**
   * Refresh one reflection from what Hermes just answered — after a write, so the row shows
   * what Hermes kept, which is not always what was typed (Hermes trims a title, for one).
   */
  reflectCard(service: TasksService, scope: Scope, card: HermesTask): TaskRow {
    if (!KNOWN.has(card.status)) {
      throw new Error(`Hermes answered a status this release does not know: ${card.status}`);
    }
    return service.reflectExternal(scope, this.input(card, this.port.agentId(scope.workspace))).row;
  }

  /**
   * Hermes's comments on the card, reflected: the ones the hub has not seen are added with
   * Hermes's time. Nothing is removed — Hermes has no way to delete a comment, and a comment
   * written here before the hub ran Hermes's server lives only here.
   *
   * An author who is one of Hermes's profiles is an agent; anyone else is a person.
   * `poster` names the person who just posted through the hub, so their comment carries
   * their id as well as their name.
   */
  reflectComments(
    service: TasksService,
    row: TaskRow,
    comments: readonly HermesComment[],
    poster?: { id: string | null; name: string; body: string },
  ): CommentRow[] {
    const profiles = new Set((this.port.profiles?.() ?? []).map((entry) => entry.profile));
    return service.reflectComments(
      row,
      comments.map((comment) => {
        const mine =
          poster && comment.author === poster.name && comment.body === poster.body
            ? poster.id
            : null;
        return {
          author: comment.author,
          authorKind:
            profiles.has(comment.author) && !mine ? ('agent' as const) : ('user' as const),
          authorId: mine,
          body: comment.body,
          createdAt: new Date(comment.created_at * 1000),
        };
      }),
    );
  }

  /** True when `agentId` is the Hermes agent of this workspace. */
  isHermesAgent(workspace: string, agentId: string | null | undefined): boolean {
    if (!agentId || !this.port.kanban()) return false;
    return this.port.agentId(workspace) === agentId;
  }

  /** True when this row is a reflection, whose words belong to Hermes. */
  static isHermes(row: TaskRow): boolean {
    return row.externalSource === 'hermes';
  }
}
