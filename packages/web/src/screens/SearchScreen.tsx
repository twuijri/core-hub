import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { sessionTitle } from '../sessions/SessionList.js';
import { AppShell } from '../shell/AppShell.js';
import { Notice, Spinner } from '../ui/Notice.js';

/** The search sheet over sessions, field focused at once; a result opens Chat (secondary entry). */
export function SearchScreen() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useSessions(q ? { q, archived: 'all' } : { archived: 'all' });
  const title = t(termKey('search'));
  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      <input
        ref={input}
        type="search"
        className="field"
        placeholder={t('search.placeholder')}
        aria-label={title}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {results.isPending && <Spinner label={t('common.loading')} />}
      {results.isError && (
        <Notice tone="danger" className="mt-3">
          {describeError(results.error, t)}
        </Notice>
      )}
      {results.data && results.data.items.length === 0 && (
        <Notice className="mt-3">{t('search.none')}</Notice>
      )}
      <ul className="mt-3 flex flex-col gap-1">
        {results.data?.items.map((session) => (
          <li key={session.id}>
            <Link
              to={
                session.source === 'global_agent'
                  ? routeOf('global_agent')
                  : routeOf('chat').replace(':sessionId?', session.id)
              }
              className="card block hover:bg-surface-2"
            >
              <span className="block font-medium" dir="auto">
                {sessionTitle(session, t)}
              </span>
              <span className="block text-xs text-muted" dir="auto">
                {session.match?.snippet ?? session.preview ?? ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
