// The chats list in groups (contract decision §60): the profile's categories first, in their
// order, then one group per messaging channel a conversation came from (Telegram, WhatsApp…) —
// holding the channel conversations Hermes keeps too (§61) — then everything else. Pure functions only — the list component renders what these return,
// and the tests read them directly.
import { derived } from '@corehub/contracts';
import type { Schemas, Session } from '../types.js';
import type { ChannelConversation } from './channels.js';
import { arrange } from './order.js';

export type SessionCategory = Schemas['SessionCategory'];

/** `category:<id>`, `channel:<platform>`, or `rest` for the chats in no group. */
export type GroupKey = `category:${string}` | `channel:${string}` | 'rest';

export interface SessionGroup {
  key: GroupKey;
  kind: 'category' | 'channel' | 'rest';
  /** The category, for `kind: category`. */
  category?: SessionCategory;
  /** The platform slug (`telegram`, `whatsapp`…), for `kind: channel`. */
  channel?: string;
  items: Session[];
  /**
   * For `kind: channel`: the conversations Hermes keeps for that channel (contract decision
   * §61), read-only, most recent first, after any hub session of the same channel.
   */
  conversations?: ChannelConversation[];
}

export const categoryKey = (id: string): GroupKey => `category:${id}`;
export const channelKey = (platform: string): GroupKey => `channel:${platform}`;

/**
 * Which group a conversation sits in. A category the person chose wins over where the
 * conversation came from; a category this list does not know (not loaded yet, or just made
 * by someone else) is no group rather than a hidden row.
 */
export function groupKeyOf(session: Session, known: ReadonlySet<string>): GroupKey {
  if (session.category_id && known.has(session.category_id))
    return categoryKey(session.category_id);
  if (session.source === 'channel') return channelKey(session.channel ?? 'other');
  return 'rest';
}

/**
 * The groups, in the order they are shown. Every category is listed even when empty — it is
 * where a chat is dropped — unless `keepEmpty` is false (a filter is typed: showing folders
 * with nothing that matches would only be noise). Channel groups exist only when a chat came
 * from that channel. Within each group: pinned first, then the remembered manual order.
 */
export function groupSessions(
  sessions: readonly Session[],
  categories: readonly SessionCategory[],
  options: {
    manual?: readonly string[];
    keepEmpty?: boolean;
    /** Channel conversations read from Hermes: each fills its platform's group. */
    conversations?: readonly ChannelConversation[];
  } = {},
): SessionGroup[] {
  const manual = options.manual ?? [];
  const keepEmpty = options.keepEmpty ?? true;
  const known = new Set(categories.map((c) => c.id));
  const buckets = new Map<GroupKey, Session[]>();
  for (const session of sessions) {
    const key = groupKeyOf(session, known);
    buckets.set(key, [...(buckets.get(key) ?? []), session]);
  }
  const groups: SessionGroup[] = [];
  for (const category of categories) {
    const items = buckets.get(categoryKey(category.id)) ?? [];
    if (items.length === 0 && !keepEmpty) continue;
    groups.push({
      key: categoryKey(category.id),
      kind: 'category',
      category,
      items: arrange(items, manual),
    });
  }
  const byChannel = new Map<string, ChannelConversation[]>();
  for (const conversation of options.conversations ?? []) {
    byChannel.set(conversation.channel, [
      ...(byChannel.get(conversation.channel) ?? []),
      conversation,
    ]);
  }
  const channels = [
    ...new Set([
      ...[...buckets.keys()]
        .filter((key): key is `channel:${string}` => key.startsWith('channel:'))
        .map((key) => key.slice('channel:'.length)),
      ...byChannel.keys(),
    ]),
  ].sort((a, b) => channelRank(a) - channelRank(b) || a.localeCompare(b));
  for (const channel of channels) {
    groups.push({
      key: channelKey(channel),
      kind: 'channel',
      channel,
      items: arrange(buckets.get(channelKey(channel)) ?? [], manual),
      conversations: byChannel.get(channel) ?? [],
    });
  }
  groups.push({ key: 'rest', kind: 'rest', items: arrange(buckets.get('rest') ?? [], manual) });
  return groups;
}

/** Telegram, then WhatsApp, then any other channel by name. */
function channelRank(platform: string): number {
  const at = ['telegram', 'whatsapp'].indexOf(platform);
  return at === -1 ? 2 : at;
}

/** Category ids a session list names that the categories list does not (yet) have. */
export function unknownCategories(
  sessions: readonly Session[],
  categories: readonly SessionCategory[],
): string[] {
  const known = new Set(categories.map((c) => c.id));
  return [
    ...new Set(
      sessions.map((s) => s.category_id).filter((id): id is string => !!id && !known.has(id)),
    ),
  ];
}

/**
 * Where a drop lands (dnd-kit's `over.id`): a group's header (`group:<key>`), or a row, which
 * stands for the group that row is in. `null` when it is over nothing.
 */
export function dropGroup(
  overId: string | null,
  groups: readonly SessionGroup[],
): SessionGroup | null {
  if (!overId) return null;
  if (overId.startsWith('group:')) {
    const key = overId.slice('group:'.length);
    return groups.find((g) => g.key === key) ?? null;
  }
  return groups.find((g) => g.items.some((s) => s.id === overId)) ?? null;
}

export type DropOutcome =
  { kind: 'move'; categoryId: string | null } | { kind: 'reorder' } | { kind: 'none' };

/**
 * What dropping `session` on `target` means. Into a category of the session's own profile: a
 * move. Onto the chats in no group, from a category: out of it. Within its own group: the
 * manual order. A channel group is where a conversation came from, so nothing is moved into
 * one, and a category of another profile never takes it (decision §60).
 */
export function dropOutcome(
  session: Session,
  source: SessionGroup | null,
  target: SessionGroup | null,
): DropOutcome {
  if (!target || !source) return { kind: 'none' };
  if (target.key === source.key) return { kind: 'reorder' };
  if (target.kind === 'category' && target.category) {
    return target.category.profile === session.profile
      ? { kind: 'move', categoryId: target.category.id }
      : { kind: 'none' };
  }
  if (target.kind === 'rest' && source.kind === 'category')
    return { kind: 'move', categoryId: null };
  return { kind: 'none' };
}

// ------------------------------------------------------------------ collapsed groups

/** Which groups a viewer collapsed: theirs alone, kept in this browser. */
export const COLLAPSED_KEY = `${derived.storagePrefix}sessionGroups.collapsed`;

export function readCollapsed(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  if (!storage) return new Set();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsed(
  storage: Pick<Storage, 'setItem'> | null,
  collapsed: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // A full or blocked storage only costs remembering; the list still works.
  }
}

export function toggled(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
