// The Chat segment list: pinned, then recent, with search, pin, archive, delete and drag
// reordering (dnd-kit; the keyboard sensor gives every drag a keyboard equivalent: focus the
// grip, Space to pick up, arrows to move, Space to drop).
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
import { IconArchive, IconGrip, IconPin, IconTrash, IconUnarchive } from '../ui/icons.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { Segmented } from '../ui/Segmented.js';
import { useConfirm } from '../ui/ConfirmDialog.js';
import { Tooltip } from '../ui/Tooltip.js';
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
      <input
        type="search"
        className="field py-1 text-sm"
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
      {sessions.isPending && <Spinner label={t('common.loading')} />}
      {sessions.isError && <Notice tone="danger">{describeError(sessions.error, t)}</Notice>}
      {sessions.data && items.length === 0 && (
        <Notice>
          {filter
            ? t('sessions.none_match')
            : scope === 'archived'
              ? t('sessions.none_archived')
              : t('sessions.empty')}
        </Notice>
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
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-1 rounded-md ${isDragging ? 'sortable-dragging' : ''} ${active ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
      data-testid="session-row"
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="cursor-grab px-1 text-faint opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={t('sessions.reorder', { title })}
        {...attributes}
        {...listeners}
      >
        <IconGrip size={14} />
      </button>
      <NavLink
        to={routeOf('chat').replace(':sessionId?', session.id)}
        onClick={onOpen}
        className="min-w-0 flex-1 py-1.5 text-sm"
      >
        <span className="flex items-center gap-1">
          {session.pinned && <IconPin size={12} label={t('sessions.pinned')} />}
          {session.status !== 'idle' && (
            <span
              className="inline-block size-1.5 rounded-full bg-accent"
              aria-label={t(`sessions.status.${session.status}`)}
            />
          )}
          <span className="truncate" dir="auto">
            {title}
          </span>
        </span>
        {session.preview && (
          <span className="block truncate text-xs text-faint" dir="auto">
            {plainPreview(session.preview)}
          </span>
        )}
      </NavLink>
      <span className="flex opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip label={session.pinned ? t('sessions.unpin') : t('sessions.pin')}>
          <button
            type="button"
            className="btn btn-ghost px-1"
            onClick={onPin}
            aria-label={session.pinned ? t('sessions.unpin') : t('sessions.pin')}
          >
            <IconPin size={14} />
          </button>
        </Tooltip>
        <Tooltip label={session.archived ? t('sessions.unarchive') : t('sessions.archive')}>
          <button
            type="button"
            className="btn btn-ghost px-1"
            onClick={onArchive}
            aria-label={session.archived ? t('sessions.unarchive') : t('sessions.archive')}
          >
            {session.archived ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={t('sessions.delete')}>
          <button
            type="button"
            className="btn btn-ghost px-1"
            onClick={onDelete}
            aria-label={t('sessions.delete')}
          >
            <IconTrash size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
