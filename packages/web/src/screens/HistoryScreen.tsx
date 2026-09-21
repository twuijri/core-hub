// History: a page — pinned, groups by source, multi-select archive/unarchive/delete (bulk
// operations of the contract), and the archive.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useSessions } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { sessionTitle } from '../sessions/SessionList.js';
import { AppShell } from '../shell/AppShell.js';
import type { Session } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';

export function HistoryScreen() {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const sessions = useSessions({ archived: 'all' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const title = t(termKey('history'));

  const groups = useMemo(() => {
    const items = sessions.data?.items ?? [];
    const live = items.filter((s) => !s.archived);
    const pinned = live.filter((s) => s.pinned);
    const bySource = new Map<string, Session[]>();
    for (const s of live.filter((x) => !x.pinned))
      bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
    return { pinned, bySource, archived: items.filter((s) => s.archived) };
  }, [sessions.data]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = async (action: 'archive' | 'unarchive' | 'delete') => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (action === 'delete' && !window.confirm(t('history.confirm_delete', { count: ids.length })))
      return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'delete')
        await client.request('delete', '/sessions', { query: { ids: ids.join(',') } });
      else
        await client.request('patch', '/sessions', {
          body: { session_ids: ids, patch: { archived: action === 'archive' } },
        });
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['sessions', profile] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ session }: { session: Session }) => (
    <li className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2">
      <input
        type="checkbox"
        checked={selected.has(session.id)}
        onChange={() => toggle(session.id)}
        aria-label={t('history.select', { title: sessionTitle(session, t) })}
      />
      <Link
        to={routeOf('chat').replace(':sessionId?', session.id)}
        className="min-w-0 flex-1 truncate text-sm"
        dir="auto"
      >
        {sessionTitle(session, t)}
      </Link>
      <span className="text-xs text-faint">
        {session.last_message_at ? new Date(session.last_message_at).toLocaleDateString() : ''}
      </span>
    </li>
  );

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          disabled={busy || selected.size === 0}
          onClick={() => void bulk('archive')}
        >
          {t('history.archive')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || selected.size === 0}
          onClick={() => void bulk('unarchive')}
        >
          {t('history.unarchive')}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || selected.size === 0}
          onClick={() => void bulk('delete')}
        >
          {t('history.delete')}
        </button>
        <span className="self-center text-xs text-muted">
          {t('history.selected', { count: selected.size })}
        </span>
      </div>
      {sessions.isPending && <Spinner label={t('common.loading')} />}
      {sessions.isError && <Notice tone="danger">{describeError(sessions.error, t)}</Notice>}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      {sessions.data && sessions.data.items.length === 0 && <Notice>{t('sessions.empty')}</Notice>}
      {groups.pinned.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-1 text-sm font-medium text-muted">{t('history.pinned')}</h2>
          <ul>
            {groups.pinned.map((s) => (
              <Row key={s.id} session={s} />
            ))}
          </ul>
        </section>
      )}
      {[...groups.bySource.entries()].map(([source, items]) => (
        <details key={source} open className="mb-4">
          <summary className="cursor-pointer text-sm font-medium text-muted">
            {t(`sessions.source.${source}`)} ({items.length})
          </summary>
          <ul>
            {items.map((s) => (
              <Row key={s.id} session={s} />
            ))}
          </ul>
        </details>
      ))}
      {groups.archived.length > 0 && (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm font-medium text-muted">
            {t('history.archived')} ({groups.archived.length})
          </summary>
          <ul>
            {groups.archived.map((s) => (
              <Row key={s.id} session={s} />
            ))}
          </ul>
        </details>
      )}
    </AppShell>
  );
}
