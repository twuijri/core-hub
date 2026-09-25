import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSessions } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { sessionTitle } from '../sessions/SessionList.js';
import { AppShell } from '../shell/AppShell.js';
import { CardHeader, EmptyState, Notice, Skeleton, SkeletonGroup, cardClass } from '../ui/index.js';
import { Input } from '../ui/index.js';
import { IconSearch } from '../ui/icons.js';
import { highlightParts, matchRanges } from '../ui/combobox-filter.js';
import { chatHref, globalAgentHref, HIT_CLASS } from '../chat/anchor.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles, useProfileInLink } from '../shell/profiles.js';

/** The snippet with the searched words marked, as they will be inside the conversation. */
function markedSnippet(text: string, q: string): ReactNode {
  const ranges = matchRanges(text, q);
  if (ranges.length === 0) return text;
  return highlightParts(text, ranges).map((part, index) =>
    part.hit ? (
      <mark key={index} className={HIT_CLASS}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/**
 * The search sheet over sessions, field focused at once; a result opens Chat (secondary
 * entry) at the message that matched, when the hub names one (`match.message_id`,
 * chat/anchor.ts).
 *
 * Search always looks in every profile the person may enter, whatever the top selector
 * says (owner, 2026-09-24: «نعم», ADR 0016); each result names its profile once there is
 * more than one, and opens there.
 */
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
  const results = useSessions(
    q ? { q, archived: 'all', allProfiles: true } : { archived: 'all', allProfiles: true },
  );
  const manyProfiles = useManyProfiles();
  const inLink = useProfileInLink();
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
                  ? globalAgentHref(inLink(session.profile))
                  : chatHref(session.id, session.match?.message_id, q, inLink(session.profile))
              }
              className={cardClass('flat', 'sm', true)}
              data-testid="search-result"
            >
              <CardHeader
                title={sessionTitle(session, t)}
                {...(manyProfiles
                  ? {
                      actions: (
                        <ProfileBadge profile={session.profile} testId="search-result-profile" />
                      ),
                    }
                  : {})}
                subtitle={
                  session.match ? markedSnippet(session.match.snippet, q) : (session.preview ?? '')
                }
              />
            </Link>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
