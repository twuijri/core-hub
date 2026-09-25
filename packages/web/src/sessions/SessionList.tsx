// The Chat segment list: pinned, then recent, with search, pin, archive, delete and drag
// reordering (dnd-kit; the keyboard sensor gives every drag a keyboard equivalent: focus the
// grip, Space to pick up, arrows to move, Space to drop).
//
// In groups (contract decision §54): the profile's categories first, each collapsible, then a
// group per messaging channel a conversation came from, then the chats in no group. A chat is
// dropped on a category's header, or moved from its menu («نقل إلى تصنيف»). Which groups are
// collapsed is the viewer's own, remembered in this browser (`groups.ts`). A channel's group also
// holds the conversations Hermes keeps for it (Telegram, WhatsApp…; contract decision §55): they
// are read-only, so they open as a transcript and are never dragged, pinned or moved.
//
// Assembled from the kit (`src/ui/`): the field, the segmented scope, the row buttons, the
// empty state and the right-click menu are all components, not markup written here.
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { useDeleteSession, useProfiles, useUpdateSession } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Translator } from '../i18n/index.js';
import { routeOf } from '../navigation/manifest.js';
import { chatHref } from '../chat/anchor.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { ALL_PROFILES, useManyProfiles, useProfileInLink } from '../shell/profiles.js';
import type { Session } from '../types.js';
import {
  IconArchive,
  IconChevron,
  IconClose,
  IconFolder,
  IconGlobe,
  IconGrip,
  IconMore,
  IconPin,
  IconSearch,
  IconSelect,
  IconSpark,
  IconTrash,
  IconUnarchive,
} from '../ui/icons.js';
import {
  Badge,
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  ContextMenuItem,
  ContextMenuSeparator,
  EmptyState,
  Input,
  Menu,
  MenuItem,
  MenuNote,
  MenuSeparator,
  Notice,
  Segmented,
  Select,
  Skeleton,
  SkeletonGroup,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import { move, readOrder, writeOrder } from './order.js';
import { useLiveSessions } from './useSessionList.js';
import {
  channelHref,
  conversationPreview,
  conversationTitle,
  isChannelAddress,
  matchesConversation,
  useChannelConversations,
  type ChannelConversation,
} from './channels.js';
import {
  categoryKeys,
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
} from './categories.js';
import {
  dropGroup,
  dropOutcome,
  groupSessions,
  readCollapsed,
  toggled,
  unknownCategories,
  writeCollapsed,
  type SessionCategory,
  type SessionGroup,
} from './groups.js';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/**
 * A category's header wins over the rows around it while the pointer is on it, so a chat
 * can be dropped *into* a group; anywhere else the nearest row decides, as before.
 */
const onHeaderFirst: CollisionDetection = (args) => {
  const header = pointerWithin(args).find((hit) => String(hit.id).startsWith('group:'));
  return header ? [header] : closestCenter(args);
};

export function sessionTitle(session: Pick<Session, 'title'>, t: (k: string) => string): string {
  return session.title ?? t('sessions.untitled');
}

/** The server's preview is the raw first line of markdown; show it as plain words. */
export function plainPreview(text: string | null): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~>#]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `?sessions=` — which slice of the list is on screen. It lives in the URL so a link
 * reproduces the view, which is the whole of what the old History page offered
 * (owner decision, 2026-09-22: the conversation list *is* the history).
 */
export const SCOPES = ['active', 'archived', 'all'] as const;
export type SessionScope = (typeof SCOPES)[number];
export const SCOPE_PARAM = 'sessions';

export function scopeFromParams(params: URLSearchParams): SessionScope {
  const value = params.get(SCOPE_PARAM);
  return (SCOPES as readonly string[]).includes(value ?? '') ? (value as SessionScope) : 'active';
}

/** The contract's `archived` query value for a scope (`sessions.list`). */
export function archivedFor(scope: SessionScope): 'true' | 'false' | 'all' {
  return scope === 'archived' ? 'true' : scope === 'all' ? 'all' : 'false';
}

export function SessionList({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  // The list gathers every profile the person may enter unless its own filter narrows it to
  // one (ADR 0016). The filter is the list's, not the top selector's: neither moves the
  // other. A badge says which profile a row is from once there are several on screen.
  const { listFilter, setListFilter, profile: ownProfile } = useAuth();
  const profiles = useProfiles().data ?? [];
  const manyProfiles = useManyProfiles();
  // A filter naming a profile the person can no longer enter falls back to all of them.
  const narrowed =
    manyProfiles && listFilter !== ALL_PROFILES && profiles.some((p) => p.slug === listFilter)
      ? listFilter
      : null;
  const allProfiles = narrowed === null;
  const showProfile = allProfiles && manyProfiles;
  /** The manual order is kept per view: every profile together, or one profile. */
  const orderScope = narrowed ?? ALL_PROFILES;
  const [filter, setFilter] = useState('');
  const [params, setParams] = useSearchParams();
  const { ask, dialog } = useConfirm();
  const { ask: askName, dialog: nameDialog } = usePrompt();
  const scope = scopeFromParams(params);
  // Live, not polled: a session that names itself after its first reply (contract
  // decision §26) changes this list with nothing on this screen having been clicked.
  const sessions = useLiveSessions({
    archived: archivedFor(scope),
    allProfiles,
    ...(narrowed ? { profile: narrowed } : {}),
  });
  const update = useUpdateSession();
  const remove = useDeleteSession();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [manual, setManual] = useState<string[]>(() =>
    readOrder(typeof localStorage === 'undefined' ? null : localStorage, orderScope),
  );
  useEffect(() => {
    setManual(readOrder(typeof localStorage === 'undefined' ? null : localStorage, orderScope));
  }, [orderScope]);
  /**
   * Selection, as a mode: `null` is the ordinary list, a set is the list with ticks on it
   * (owner decision, 2026-09-22). It is entered from the row menu rather than living in
   * the sidebar, because tidying many conversations at once is a rare errand and a
   * permanent toolbar for it would cost every day what it saves once a month.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);

  const categories = useCategories(allProfiles ? { allProfiles: true } : { profile: narrowed });
  const categoryList = useMemo(() => categories.data ?? [], [categories.data]);
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const queryClient = useQueryClient();
  /** Where "New category" makes one: the profile the list is narrowed to, else the person's. */
  const newCategoryProfile = narrowed ?? ownProfile;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(storage()));
  const [moving, setMoving] = useState<Session | null>(null);
  const needle = filter.trim().toLowerCase();
  // Telegram, WhatsApp… as Hermes keeps them. Hermes archives nothing the hub can show, so the
  // archive has none; the rest of the time they are polled while the list is on screen.
  const channelList = useChannelConversations({
    allProfiles,
    profile: narrowed,
    enabled: scope !== 'archived',
  });
  const unreachable = (channelList.data?.unavailable ?? []).some(
    (entry) => entry.reason === 'hermes_unreachable',
  );

  const groups = useMemo(() => {
    // The global agent is not a chat in the list: search and the pending-actions bar lead
    // to its own page (NAVIGATION §4, contract decision §46).
    const all = (sessions.data?.items ?? []).filter((s) => s.source !== 'global_agent');
    const filtered = needle
      ? all.filter(
          (s) =>
            (s.title ?? '').toLowerCase().includes(needle) ||
            (s.preview ?? '').toLowerCase().includes(needle),
        )
      : all;
    const conversations =
      scope === 'archived'
        ? []
        : (channelList.data?.items ?? []).filter((c) => matchesConversation(c, needle));
    return groupSessions(filtered, categoryList, {
      manual,
      conversations,
      // Folders with nothing in them are where a chat is dropped — but not while a filter
      // is typed or the archive is on screen, where they would only be noise.
      keepEmpty: !needle && scope !== 'archived',
    });
  }, [sessions.data, needle, manual, categoryList, scope, channelList.data]);
  /** While a filter is typed every match shows, collapsed or not: hiding a hit helps nobody. */
  const isOpen = (group: SessionGroup) =>
    group.kind === 'rest' || !!needle || !collapsed.has(group.key);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const conversationCount = groups.reduce((n, group) => n + (group.conversations?.length ?? 0), 0);
  /** The conversation on screen, when it is a channel's (its id is Hermes's). */
  const openChannel = isChannelAddress(params) ? sessionId : undefined;

  // A chat filed under a category this list has not loaded (someone else just made it): ask
  // again rather than show it among the loose chats for good.
  const missing = unknownCategories(sessions.data?.items ?? [], categoryList).join(',');
  useEffect(() => {
    if (missing && !categories.isFetching)
      void queryClient.invalidateQueries({ queryKey: categoryKeys.all });
    // `isFetching` is left out on purpose: re-asking once per new id is enough.
  }, [missing, queryClient]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const dragged = items.find((s) => s.id === String(active.id));
    if (!dragged) return;
    const source = groups.find((g) => g.items.some((s) => s.id === dragged.id)) ?? null;
    const outcome = dropOutcome(dragged, source, dropGroup(String(over.id), groups));
    if (outcome.kind === 'move') {
      void moveTo(dragged, outcome.categoryId);
      return;
    }
    if (outcome.kind !== 'reorder' || String(over.id).startsWith('group:')) return;
    const ids = items.map((s) => s.id);
    const next = move(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setManual(next);
    writeOrder(storage(), orderScope, next);
  };

  /** Into a category of the chat's own profile, or out of any (`null`). */
  const moveTo = async (session: Session, categoryId: string | null) => {
    if ((session.category_id ?? null) === categoryId) return;
    await update.mutateAsync({
      id: session.id,
      patch: { category_id: categoryId },
      profile: session.profile,
    });
    void queryClient.invalidateQueries({ queryKey: categoryKeys.all });
  };

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = toggled(current, key);
      writeCollapsed(storage(), next);
      return next;
    });

  /** "New category": its name typed into our own dialog, made in `profile`. */
  const onNewCategory = async (profile: string): Promise<SessionCategory | null> => {
    const name = await askName({
      title: t('sessions.categories.new'),
      label: t('sessions.categories.new_label'),
      confirmLabel: t('sessions.categories.create'),
      ...(manyProfiles
        ? {
            description: t('sessions.categories.new_in_profile', {
              profile: profiles.find((p) => p.slug === profile)?.name ?? profile,
            }),
          }
        : {}),
    });
    if (name === null || !name.trim()) return null;
    return createCategory.mutateAsync({ name: name.trim(), profile });
  };

  const onRenameCategory = async (category: SessionCategory) => {
    const name = await askName({
      title: t('sessions.categories.rename'),
      label: t('sessions.categories.new_label'),
      initialValue: category.name,
      confirmLabel: t('common.save'),
    });
    if (name === null || !name.trim() || name.trim() === category.name) return;
    updateCategory.mutate({
      id: category.id,
      patch: { name: name.trim() },
      profile: category.profile,
    });
  };

  const onDeleteCategory = async (category: SessionCategory) => {
    const sure = await ask({
      title: t('sessions.categories.confirm_delete', { name: category.name }),
      body: t('sessions.categories.confirm_delete_body'),
      confirmLabel: t('sessions.categories.delete'),
    });
    if (!sure) return;
    deleteCategory.mutate({ id: category.id, profile: category.profile });
  };

  /** The last place in the category's own profile, for "Move down". */
  const lastPosition = (category: SessionCategory) =>
    categoryList.filter((c) => c.profile === category.profile).length - 1;

  const selecting = chosen !== null;
  // Only rows on screen: a collapsed group's chats cannot be ticked by "all".
  const visibleIds = useMemo(
    () => groups.filter(isOpen).flatMap((group) => group.items.map((s) => s.id)),
    [groups, collapsed, needle],
  );
  // Only what is on screen counts: a filtered list means the person is looking at a slice,
  // and "all" has to mean the slice they can see.
  const selectedHere = visibleIds.filter((id) => chosen?.has(id));
  const allChosen = visibleIds.length > 0 && selectedHere.length === visibleIds.length;
  const toggleOne = (id: string) =>
    setChosen((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Each row is acted on in its own profile, which is not always the person's. */
  const profileOf = (id: string) => items.find((s) => s.id === id)?.profile;

  const onBulkArchive = async (archived: boolean) => {
    for (const id of selectedHere)
      await update.mutateAsync({ id, patch: { archived }, profile: profileOf(id) });
    setChosen(null);
  };

  const onBulkDelete = async () => {
    const count = selectedHere.length;
    if (count === 0) return;
    const sure = await ask({
      title: t('sessions.confirm_delete_many', { count }),
      body: t('sessions.confirm_delete_body'),
      confirmLabel: t('sessions.delete'),
    });
    if (!sure) return;
    for (const id of selectedHere) await remove.mutateAsync({ id, profile: profileOf(id) });
    if (sessionId && selectedHere.includes(sessionId)) navigate(routeOf('new_chat'));
    setChosen(null);
  };

  const onDelete = async (session: Session) => {
    const title = sessionTitle(session, t);
    const sure = await ask({
      title: t('sessions.confirm_delete', { title }),
      body: t('sessions.confirm_delete_body'),
      confirmLabel: t('sessions.delete'),
    });
    if (!sure) return;
    await remove.mutateAsync({ id: session.id, profile: session.profile });
    if (sessionId === session.id) navigate(routeOf('new_chat'));
  };

  /**
   * Rename: the person's own words. The hub marks the row and never renames it again
   * (contract decision §26).
   */
  const onRename = async (session: Session) => {
    const typed = await askName({
      title: t('sessions.rename'),
      label: t('sessions.rename_label'),
      initialValue: session.title ?? '',
      confirmLabel: t('common.save'),
    });
    if (typed === null) return;
    update.mutate({ id: session.id, patch: { title: typed }, profile: session.profile });
  };

  /**
   * Retitle: hand the naming back to the hub. `title: null` is the whole of the gesture —
   * the hub names the session from its own first turn and announces it on `/rt/sessions`,
   * so the row here changes on its own.
   */
  const onRetitle = (session: Session) => {
    update.mutate({ id: session.id, patch: { title: null }, profile: session.profile });
  };

  const chooseScope = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next === 'active') updated.delete(SCOPE_PARAM);
    else updated.set(SCOPE_PARAM, next);
    setParams(updated, { replace: true });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="session-list">
      {/* Which profiles the list shows — hidden for someone with one profile, where there
          is nothing to choose between. */}
      {manyProfiles && (
        <Select
          value={narrowed ?? ALL_PROFILES}
          onValueChange={(next) => setListFilter(next ?? ALL_PROFILES)}
          options={[
            { value: ALL_PROFILES, label: t('sessions.all_profiles') },
            ...profiles.map((p) => ({ value: p.slug, label: p.name })),
          ]}
          label={t('sessions.profile_filter')}
          testId="session-profile-filter"
        />
      )}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Input
            type="search"
            inputSize="sm"
            icon={<IconSearch size={14} />}
            placeholder={t('sessions.filter')}
            aria-label={t('sessions.filter')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip={t('sessions.categories.new')}
          aria-label={t('sessions.categories.new')}
          icon={<IconFolder size={14} />}
          onClick={() => void onNewCategory(newCategoryProfile)}
          data-testid="session-category-new"
        />
      </div>
      {selecting ? (
        /* The bar the selection brings with it: what is ticked, all or none, and the two
           things worth doing to many conversations at once. It stands where the scope row
           was, so nothing jumps. */
        <div className="session-select-bar" data-testid="session-select-bar">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChosen(allChosen ? new Set() : new Set(visibleIds))}
            data-testid="session-select-all"
          >
            {allChosen ? t('sessions.select_none') : t('sessions.select_all')}
          </Button>
          <span className="session-select-count" data-testid="session-select-count">
            {t('sessions.selected_count', { count: selectedHere.length })}
          </span>
          <span className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={selectedHere.length === 0}
              tooltip={scope === 'archived' ? t('sessions.unarchive') : t('sessions.archive')}
              aria-label={scope === 'archived' ? t('sessions.unarchive') : t('sessions.archive')}
              icon={scope === 'archived' ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
              onClick={() => void onBulkArchive(scope !== 'archived')}
              data-testid="session-bulk-archive"
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={selectedHere.length === 0}
              tooltip={t('sessions.delete')}
              aria-label={t('sessions.delete')}
              icon={<IconTrash size={14} />}
              onClick={() => void onBulkDelete()}
              data-testid="session-bulk-delete"
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={t('common.cancel')}
              aria-label={t('common.cancel')}
              icon={<IconClose size={14} />}
              onClick={() => setChosen(null)}
              data-testid="session-select-done"
            />
          </span>
        </div>
      ) : null}
      <Segmented
        label={t('sessions.scope.label')}
        value={scope}
        onChange={chooseScope}
        size="sm"
        stretch
        testId="session-scope"
        options={SCOPES.map((id) => ({
          value: id,
          label: t(`sessions.scope.${id}`),
          itemProps: { 'data-scope-id': id },
        }))}
      />
      {sessions.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height="2.25rem" radius="md" />
          ))}
        </SkeletonGroup>
      )}
      {sessions.isError && <Notice tone="danger">{describeError(sessions.error, t)}</Notice>}
      {unreachable && (
        <p className="session-group-empty" role="status" data-testid="channel-unreachable">
          {t('sessions.channels.unreachable')}
        </p>
      )}
      {sessions.data && items.length === 0 && conversationCount === 0 && (
        <EmptyState
          size="sm"
          title={
            filter
              ? t('sessions.none_match')
              : scope === 'archived'
                ? t('sessions.none_archived')
                : t('sessions.empty')
          }
        />
      )}
      {(update.isError || remove.isError) && (
        <Notice tone="danger">{describeError(update.error ?? remove.error, t)}</Notice>
      )}
      {(createCategory.isError || updateCategory.isError || deleteCategory.isError) && (
        <Notice tone="danger">
          {describeError(createCategory.error ?? updateCategory.error ?? deleteCategory.error, t)}
        </Notice>
      )}
      <DndContext sensors={sensors} collisionDetection={onHeaderFirst} onDragEnd={onDragEnd}>
        {groups.map((group) => {
          const rows = (
            <SortableContext
              items={group.items.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul
                className="flex flex-col gap-0.5"
                aria-label={group.kind === 'rest' ? t('nav.chat') : groupName(group, t)}
              >
                {group.items.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === sessionId}
                    onOpen={onOpen}
                    onRename={() => void onRename(session)}
                    onRetitle={() => onRetitle(session)}
                    onMove={() => setMoving(session)}
                    showProfile={showProfile}
                    onPin={() =>
                      update.mutate({
                        id: session.id,
                        patch: { pinned: !session.pinned },
                        profile: session.profile,
                      })
                    }
                    onArchive={() =>
                      update.mutate({
                        id: session.id,
                        patch: { archived: !session.archived },
                        profile: session.profile,
                      })
                    }
                    onDelete={() => void onDelete(session)}
                    onSelectMode={() => setChosen(new Set([session.id]))}
                    selected={chosen === null ? null : chosen.has(session.id)}
                    onToggle={() => toggleOne(session.id)}
                  />
                ))}
                {group.conversations?.map((conversation) => (
                  <ChannelRow
                    key={`${conversation.profile}:${conversation.id}`}
                    conversation={conversation}
                    active={openChannel === conversation.id}
                    showProfile={showProfile}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            </SortableContext>
          );
          if (group.kind === 'rest') return <div key={group.key}>{rows}</div>;
          const open = isOpen(group);
          const category = group.category;
          return (
            <section
              key={group.key}
              className="session-group"
              data-testid="session-group"
              data-group={group.key}
            >
              <GroupHeader
                group={group}
                name={groupName(group, t)}
                open={open}
                onToggle={() => toggleGroup(group.key)}
                showProfile={showProfile && !!category}
                menu={
                  category ? (
                    <>
                      <MenuItem
                        icon={<IconGrip size={14} />}
                        onSelect={() => void onRenameCategory(category)}
                      >
                        {t('sessions.categories.rename')}
                      </MenuItem>
                      {category.position > 0 && (
                        <MenuItem
                          icon={<IconChevron size={14} className="session-group-up" />}
                          onSelect={() =>
                            updateCategory.mutate({
                              id: category.id,
                              patch: { position: category.position - 1 },
                              profile: category.profile,
                            })
                          }
                        >
                          {t('sessions.categories.move_up')}
                        </MenuItem>
                      )}
                      {category.position < lastPosition(category) && (
                        <MenuItem
                          icon={<IconChevron size={14} />}
                          onSelect={() =>
                            updateCategory.mutate({
                              id: category.id,
                              patch: { position: category.position + 1 },
                              profile: category.profile,
                            })
                          }
                        >
                          {t('sessions.categories.move_down')}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem
                        icon={<IconTrash size={14} />}
                        tone="danger"
                        onSelect={() => void onDeleteCategory(category)}
                      >
                        {t('sessions.categories.delete')}
                      </MenuItem>
                    </>
                  ) : null
                }
              />
              {open && rows}
              {open && group.items.length === 0 && !group.conversations?.length && (
                <p className="session-group-empty">{t('sessions.categories.empty_group')}</p>
              )}
            </section>
          );
        })}
      </DndContext>
      <MoveDialog
        session={moving}
        categories={moving ? categoryList.filter((c) => c.profile === moving.profile) : []}
        profileName={
          moving ? (profiles.find((p) => p.slug === moving.profile)?.name ?? moving.profile) : ''
        }
        onClose={() => setMoving(null)}
        onChoose={(categoryId) => {
          const session = moving;
          setMoving(null);
          if (session) void moveTo(session, categoryId);
        }}
        onNew={async () => {
          const session = moving;
          setMoving(null);
          if (!session) return;
          const made = await onNewCategory(session.profile);
          if (made) await moveTo(session, made.id);
        }}
      />
      {dialog}
      {nameDialog}
    </div>
  );
}

/** A group's title: the category's own name, or the channel's in the reader's language. */
function groupName(group: SessionGroup, t: Translator): string {
  if (group.category) return group.category.name;
  if (group.channel === 'telegram' || group.channel === 'whatsapp')
    return t(`sessions.channels.${group.channel}`);
  return t('sessions.channels.other', { name: group.channel ?? '' });
}

/**
 * A group's header: the button that opens and closes it (its name, how many chats are on
 * screen), the profile it belongs to when several are shown, and — for a category — its menu.
 * A category's header is also where a dragged chat is dropped.
 */
function GroupHeader({
  group,
  name,
  open,
  onToggle,
  showProfile,
  menu,
}: {
  group: SessionGroup;
  name: string;
  open: boolean;
  onToggle(): void;
  showProfile: boolean;
  menu: ReactNode;
}) {
  const { t } = useI18n();
  const count = group.items.length + (group.conversations?.length ?? 0);
  const { setNodeRef, isOver } = useDroppable({
    id: `group:${group.key}`,
    disabled: group.kind !== 'category',
  });
  return (
    <div
      ref={setNodeRef}
      className="session-group-head"
      data-over={isOver ? 'true' : undefined}
      data-testid="session-group-head"
    >
      <button
        type="button"
        className="session-group-toggle"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="session-group-toggle"
      >
        <IconChevron size={12} className="session-group-chevron" />
        <span className="min-w-0 truncate" dir="auto">
          {name}
        </span>
        <span
          className="session-group-count"
          aria-label={t('sessions.categories.count', { count })}
        >
          {count}
        </span>
      </button>
      {showProfile && group.category && (
        <ProfileBadge profile={group.category.profile} testId="session-group-profile" />
      )}
      {menu && (
        <Menu
          align="end"
          testId="session-group-menu"
          tooltip={t('common.more')}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('sessions.categories.more', { name })}
              icon={<IconMore size={14} />}
              data-testid="session-group-more"
            />
          }
        >
          {menu}
        </Menu>
      )}
    </div>
  );
}

/**
 * «نقل إلى تصنيف»: the categories of the chat's own profile — another profile's cannot hold
 * it (decision §54) — plus "No category", and a new one made on the spot.
 */
function MoveDialog({
  session,
  categories,
  profileName,
  onClose,
  onChoose,
  onNew,
}: {
  session: Session | null;
  categories: readonly SessionCategory[];
  profileName: string;
  onClose(): void;
  onChoose(categoryId: string | null): void;
  onNew(): void;
}) {
  const { t } = useI18n();
  const current = session?.category_id ?? null;
  const option = (id: string | null, label: string) => (
    <Button
      key={id ?? 'none'}
      variant={current === id ? 'secondary' : 'ghost'}
      size="sm"
      onClick={() => onChoose(id)}
      aria-pressed={current === id}
      data-testid="move-category-option"
      data-category-id={id ?? 'none'}
    >
      <span className="min-w-0 truncate" dir="auto">
        {label}
      </span>
      {current === id && <Badge tone="neutral">{t('sessions.categories.current')}</Badge>}
    </Button>
  );
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('sessions.categories.move_title', {
        title: session ? sessionTitle(session, t) : '',
      })}
      description={t('sessions.categories.move_hint', { profile: profileName })}
      size="sm"
      closeLabel={t('common.cancel')}
      testId="move-category-dialog"
    >
      <div className="flex flex-col gap-1">
        {categories.map((category) => option(category.id, category.name))}
        {option(null, t('sessions.categories.none'))}
        <Button
          variant="ghost"
          size="sm"
          icon={<IconFolder size={14} />}
          onClick={onNew}
          data-testid="move-category-new"
        >
          {t('sessions.categories.new_and_move')}
        </Button>
      </div>
    </Dialog>
  );
}

function SessionRow({
  session,
  active,
  showProfile,
  onOpen,
  onRename,
  onRetitle,
  onMove,
  onPin,
  onArchive,
  onDelete,
  onSelectMode,
  selected,
  onToggle,
}: {
  session: Session;
  active: boolean;
  /** Say which profile the row is from: the list holds more than one. */
  showProfile: boolean;
  onOpen?: (() => void) | undefined;
  onRename: () => void;
  onRetitle: () => void;
  /** «نقل إلى تصنيف»: opens the list's move dialog for this chat. */
  onMove: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Enter selection with this row already ticked. */
  onSelectMode: () => void;
  /** `null` while the list is not selecting; a boolean while it is. */
  selected: boolean | null;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const inLink = useProfileInLink();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: session.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const title = sessionTitle(session, t);
  const selecting = selected !== null;
  const pinLabel = session.pinned ? t('sessions.unpin') : t('sessions.pin');
  const archiveLabel = session.archived ? t('sessions.unarchive') : t('sessions.archive');
  return (
    <ContextMenu
      testId="session-menu"
      trigger={
        <li
          ref={setNodeRef}
          style={style}
          className={`session-row ${isDragging ? 'sortable-dragging' : ''}`}
          data-active={active ? 'true' : undefined}
          data-selecting={selecting ? 'true' : undefined}
          data-selected={selected ? 'true' : undefined}
          data-testid="session-row"
        >
          {selecting ? (
            // While the list is selecting, the grip's place is the tick: there is no
            // reordering to do and every row needs one reachable box.
            <span className="session-grip">
              <Checkbox
                checked={selected === true}
                onChange={onToggle}
                label={t('sessions.select_one', { title })}
                labelHidden
                testId="session-check"
              />
            </span>
          ) : (
            <button
              ref={setActivatorNodeRef}
              type="button"
              className="session-grip"
              aria-label={t('sessions.reorder', { title })}
              {...attributes}
              {...listeners}
            >
              <IconGrip size={14} />
            </button>
          )}
          <NavLink
            // Opened in its own profile, which the address carries (ADR 0016).
            to={chatHref(session.id, null, undefined, inLink(session.profile))}
            onClick={(event) => {
              // Selecting: the row is a tick, not a door. Opening one would throw away
              // the selection the person is still building.
              if (selecting) {
                event.preventDefault();
                onToggle();
                return;
              }
              onOpen?.();
            }}
            className="session-link"
          >
            <span className="session-title-row">
              {session.pinned && <IconPin size={12} label={t('sessions.pinned')} />}
              {session.status !== 'idle' && (
                <Badge tone="accent" dot testId="session-live">
                  {t(`sessions.status.${session.status}`)}
                </Badge>
              )}
              <span className="min-w-0 truncate" dir="auto">
                {title}
              </span>
              {showProfile && (
                <ProfileBadge
                  profile={session.profile}
                  testId="session-profile"
                  className="ms-auto"
                />
              )}
            </span>
            {session.preview && (
              <span className="session-preview" dir="auto">
                {plainPreview(session.preview)}
              </span>
            )}
          </NavLink>
          {/* Pin and archive stay on the row: both are one click back. **Delete does
              not** (owner decision, 2026-09-22) — it is not something to be able to hit
              in passing, so it lives in the menu with the rest, and the menu takes the
              place at the end of the row where the bin used to be. */}
          <span className="session-actions" hidden={selecting}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={pinLabel}
              aria-label={pinLabel}
              icon={<IconPin size={14} />}
              onClick={onPin}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={archiveLabel}
              aria-label={archiveLabel}
              icon={session.archived ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
              onClick={onArchive}
            />
            <Menu
              align="end"
              testId="session-more"
              tooltip={t('common.more')}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('sessions.more', { title })}
                  icon={<IconMore size={14} />}
                  data-testid="session-more-button"
                />
              }
            >
              <MenuItem icon={<IconGrip size={14} />} onSelect={onRename}>
                {t('sessions.rename')}
              </MenuItem>
              <MenuNote>{t('sessions.retitle_hint')}</MenuNote>
              <MenuItem icon={<IconSpark size={14} />} onSelect={onRetitle}>
                {t('sessions.retitle')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<IconFolder size={14} />} onSelect={onMove}>
                {t('sessions.categories.move_to')}
              </MenuItem>
              <MenuItem icon={<IconSelect size={14} />} onSelect={onSelectMode}>
                {t('sessions.select')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={onDelete}>
                {t('sessions.delete')}
              </MenuItem>
            </Menu>
          </span>
        </li>
      }
    >
      <ContextMenuItem icon={<IconGrip size={14} />} onSelect={onRename}>
        {t('sessions.rename')}
      </ContextMenuItem>
      {/* The other half of decision §26: give the naming back to the hub. */}
      <ContextMenuItem icon={<IconSpark size={14} />} onSelect={onRetitle}>
        {t('sessions.retitle')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={<IconPin size={14} />} onSelect={onPin}>
        {pinLabel}
      </ContextMenuItem>
      <ContextMenuItem
        icon={session.archived ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
        onSelect={onArchive}
      >
        {archiveLabel}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={<IconFolder size={14} />} onSelect={onMove}>
        {t('sessions.categories.move_to')}
      </ContextMenuItem>
      <ContextMenuItem icon={<IconSelect size={14} />} onSelect={onSelectMode}>
        {t('sessions.select')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={onDelete}>
        {t('sessions.delete')}
      </ContextMenuItem>
    </ContextMenu>
  );
}

/**
 * A conversation Hermes keeps for a channel (contract decision §55): the other party (or
 * Hermes's title), its latest message, and its profile when several are shown. Read-only — it
 * opens as a transcript, and has no menu: nothing the hub could do to it would reach Hermes.
 */
function ChannelRow({
  conversation,
  active,
  showProfile,
  onOpen,
}: {
  conversation: ChannelConversation;
  active: boolean;
  showProfile: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const { t, language } = useI18n();
  const inLink = useProfileInLink();
  const title = conversationTitle(conversation, t);
  const when = new Date(conversation.last_message_at);
  return (
    <li
      className="session-row"
      data-active={active ? 'true' : undefined}
      data-testid="channel-row"
      data-channel={conversation.channel}
      data-conversation-id={conversation.id}
    >
      <span className="session-grip" aria-hidden>
        <IconGlobe size={14} />
      </span>
      <NavLink
        to={channelHref(conversation.id, inLink(conversation.profile))}
        onClick={() => onOpen?.()}
        className="session-link"
        title={Number.isNaN(when.getTime()) ? undefined : when.toLocaleString(language)}
      >
        <span className="session-title-row">
          <span className="min-w-0 truncate" dir="auto">
            {title}
          </span>
          {showProfile && (
            <ProfileBadge
              profile={conversation.profile}
              testId="channel-profile"
              className="ms-auto"
            />
          )}
        </span>
        {conversationPreview(conversation, t) && (
          <span className="session-preview" dir="auto">
            {plainPreview(conversationPreview(conversation, t))}
          </span>
        )}
      </NavLink>
    </li>
  );
}
