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
import { useDeleteSession, useSessions, useUpdateSession } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import type { Session } from '../types.js';
import {
  IconArchive,
  IconGrip,
  IconPin,
  IconSearch,
  IconTrash,
  IconUnarchive,
} from '../ui/icons.js';
import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  EmptyState,
  Input,
  Notice,
  Segmented,
  Skeleton,
  SkeletonGroup,
  useConfirm,
} from '../ui/index.js';
import { arrange, move, readOrder, writeOrder } from './order.js';

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
  const scope = scopeFromParams(params);
  const sessions = useSessions({ archived: archivedFor(scope) });
  const update = useUpdateSession();
  const remove = useDeleteSession();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [manual, setManual] = useState<string[]>(() =>
    readOrder(typeof localStorage === 'undefined' ? null : localStorage, profile),
  );

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
                onPin={() => update.mutate({ id: session.id, patch: { pinned: !session.pinned } })}
                onArchive={() =>
                  update.mutate({ id: session.id, patch: { archived: !session.archived } })
                }
                onDelete={() => void onDelete(session)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {dialog}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
  onPin,
  onArchive,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onOpen?: (() => void) | undefined;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
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
          data-testid="session-row"
        >
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
          <NavLink
            to={routeOf('chat').replace(':sessionId?', session.id)}
            onClick={onOpen}
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
          {/* The same three actions the right-click menu offers, always visible to the
              keyboard and to touch — a context menu is never the only way to reach one. */}
          <span className="session-actions">
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
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              tooltip={t('sessions.delete')}
              aria-label={t('sessions.delete')}
              icon={<IconTrash size={14} />}
              onClick={onDelete}
            />
          </span>
        </li>
      }
    >
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
      <ContextMenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={onDelete}>
        {t('sessions.delete')}
      </ContextMenuItem>
    </ContextMenu>
  );
}
