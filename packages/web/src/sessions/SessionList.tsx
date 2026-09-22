// The Chat segment list: pinned, then recent, with search, pin, archive, delete and drag
// reordering (dnd-kit; the keyboard sensor gives every drag a keyboard equivalent: focus the
// grip, Space to pick up, arrows to move, Space to drop).
//
// Assembled from the kit (`src/ui/`): the field, the segmented scope, the row buttons, the
// empty state and the right-click menu are all components, not markup written here.
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { useDeleteSession, useUpdateSession } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import type { Session } from '../types.js';
import {
  IconArchive,
  IconClose,
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
  Skeleton,
  SkeletonGroup,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import { arrange, move, readOrder, writeOrder } from './order.js';
import { useLiveSessions } from './useSessionList.js';

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
  const { profile } = useAuth();
  const [filter, setFilter] = useState('');
  const [params, setParams] = useSearchParams();
  const { ask, dialog } = useConfirm();
  const { ask: askName, dialog: nameDialog } = usePrompt();
  const scope = scopeFromParams(params);
  // Live, not polled: a session that names itself after its first reply (contract
  // decision §26) changes this list with nothing on this screen having been clicked.
  const sessions = useLiveSessions({ archived: archivedFor(scope) });
  const update = useUpdateSession();
  const remove = useDeleteSession();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [manual, setManual] = useState<string[]>(() =>
    readOrder(typeof localStorage === 'undefined' ? null : localStorage, profile),
  );
  /**
   * Selection, as a mode: `null` is the ordinary list, a set is the list with ticks on it
   * (owner decision, 2026-09-22). It is entered from the row menu rather than living in
   * the sidebar, because tidying many conversations at once is a rare errand and a
   * permanent toolbar for it would cost every day what it saves once a month.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);

  const items = useMemo(() => {
    const all = sessions.data?.items ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? all.filter(
          (s) =>
            (s.title ?? '').toLowerCase().includes(needle) ||
            (s.preview ?? '').toLowerCase().includes(needle),
        )
      : all;
    return arrange(filtered, manual);
  }, [sessions.data, filter, manual]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((s) => s.id);
    const next = move(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setManual(next);
    writeOrder(typeof localStorage === 'undefined' ? null : localStorage, profile, next);
  };

  const selecting = chosen !== null;
  const visibleIds = useMemo(() => items.map((s) => s.id), [items]);
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

  const onBulkArchive = async (archived: boolean) => {
    for (const id of selectedHere) await update.mutateAsync({ id, patch: { archived } });
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
    for (const id of selectedHere) await remove.mutateAsync(id);
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
    await remove.mutateAsync(session.id);
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
    update.mutate({ id: session.id, patch: { title: typed } });
  };

  /**
   * Retitle: hand the naming back to the hub. `title: null` is the whole of the gesture —
   * the hub names the session from its own first turn and announces it on `/rt/sessions`,
   * so the row here changes on its own.
   */
  const onRetitle = (session: Session) => {
    update.mutate({ id: session.id, patch: { title: null } });
  };

  const chooseScope = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next === 'active') updated.delete(SCOPE_PARAM);
    else updated.set(SCOPE_PARAM, next);
    setParams(updated, { replace: true });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="session-list">
      <Input
        type="search"
        inputSize="sm"
        icon={<IconSearch size={14} />}
        placeholder={t('sessions.filter')}
        aria-label={t('sessions.filter')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
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
      {sessions.data && items.length === 0 && (
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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-0.5" aria-label={t('nav.chat')}>
            {items.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === sessionId}
                onOpen={onOpen}
                onRename={() => void onRename(session)}
                onRetitle={() => onRetitle(session)}
                onPin={() => update.mutate({ id: session.id, patch: { pinned: !session.pinned } })}
                onArchive={() =>
                  update.mutate({ id: session.id, patch: { archived: !session.archived } })
                }
                onDelete={() => void onDelete(session)}
                onSelectMode={() => setChosen(new Set([session.id]))}
                selected={chosen === null ? null : chosen.has(session.id)}
                onToggle={() => toggleOne(session.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {dialog}
      {nameDialog}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
  onRename,
  onRetitle,
  onPin,
  onArchive,
  onDelete,
  onSelectMode,
  selected,
  onToggle,
}: {
  session: Session;
  active: boolean;
  onOpen?: (() => void) | undefined;
  onRename: () => void;
  onRetitle: () => void;
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
            to={routeOf('chat').replace(':sessionId?', session.id)}
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
              <span className="truncate" dir="auto">
                {title}
              </span>
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
