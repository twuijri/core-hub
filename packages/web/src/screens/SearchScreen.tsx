import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf, termKey } from '../navigation/manifest.js';
import { sessionTitle } from '../sessions/SessionList.js';
import { AppShell } from '../shell/AppShell.js';
import { CardHeader, EmptyState, Notice, Skeleton, SkeletonGroup, cardClass } from '../ui/index.js';
import { Input } from '../ui/index.js';
import { IconSearch } from '../ui/icons.js';

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
      <Input
        ref={input}
        type="search"
        inputSize="lg"
        icon={<IconSearch size={16} />}
        placeholder={t('search.placeholder')}
        aria-label={title}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {results.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <div className="mt-3 flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="3.5rem" radius="md" />
            ))}
          </div>
        </SkeletonGroup>
      )}
      {results.isError && (
        <Notice tone="danger" className="mt-3">
          {describeError(results.error, t)}
        </Notice>
      )}
      {results.data && results.data.items.length === 0 && (
        <div className="mt-3">
          <EmptyState icon={<IconSearch size={20} />} title={t('search.none')} />
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {results.data?.items.map((session) => (
          <li key={session.id}>
            <Link
              to={
                session.source === 'global_agent'
                  ? routeOf('global_agent')
                  : routeOf('chat').replace(':sessionId?', session.id)
              }
              className={cardClass('flat', 'sm', true)}
            >
              <CardHeader
                title={sessionTitle(session, t)}
                subtitle={session.match?.snippet ?? session.preview ?? ''}
              />
            </Link>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
