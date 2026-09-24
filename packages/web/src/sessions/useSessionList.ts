/**
 * The sidebar, kept live from `/rt/sessions`.
 *
 * `session.created` / `session.updated` / `session.deleted` are profile-wide on that
 * namespace — the contract marks them "no subscription needed" — so the list can be a
 * fetch plus a subscription rather than a poll.
 *
 * It exists because of the one change a person never asks for: a session names itself
 * after its first reply (contract decision §26), and the name arrives seconds after the
 * reply, from the hub, with nothing on this screen having been clicked. Without this the
 * row would keep reading "New chat" until something else happened to refetch the list.
 *
 * An updated row is written straight into the cache rather than triggering a refetch: the
 * envelope already carries the whole `Session` document, and a refetch per event would
 * turn a busy workspace into a request per delta of the list.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { isEnvelope, type Envelope } from '../realtime/envelope.js';
import { keys, useSessions, type SessionFilters, type SessionPage } from '../hub/queries.js';
import type { Session } from '../types.js';

/**
 * `useSessions`, plus the three profile-wide events that change what it returned.
 *
 * The sessions socket hears every profile the person may enter (`profiles: 'all'`,
 * ADR 0016), so an event is applied by what it names: an updated row is replaced wherever
 * that id is cached (an id is one session in whichever list it sits), and a row that
 * appeared or went away refreshes the lists — except, when the list is one profile, an
 * event from another, which that list does not show.
 */
export function useLiveSessions(filters: SessionFilters = {}) {
  const query = useSessions(filters);
  const queryClient = useQueryClient();
  const { profile, session } = useAuth();
  const realtime = useRealtime();
  const all = filters.allProfiles === true;
  /** The one profile the list shows when it is not every profile. */
  const shown = filters.profile ?? profile;

  useEffect(() => {
    if (!session) return;
    const socket = realtime.socket('sessions');
    const pages = { queryKey: ['sessions'] } as const;

    const replace = (updated: Session) =>
      queryClient.setQueriesData<SessionPage>(
        pages,
        (page) =>
          page && {
            ...page,
            items: page.items.map((item) => (item.id === updated.id ? updated : item)),
          },
      );

    const onUpdated = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      const updated = (raw as Envelope<{ session?: Session }>).payload.session;
      if (!updated) return;
      replace(updated);
      queryClient.setQueryData(keys.session(raw.profile ?? updated.profile, updated.id), updated);
    };
    // A new session and a deleted one change *which* rows exist, and where: the order the
    // hub returns is the hub's, so the list is refetched rather than spliced here.
    const onList = (raw: unknown) => {
      if (!all && isEnvelope(raw) && raw.profile && raw.profile !== shown) return;
      void queryClient.invalidateQueries(pages);
    };

    socket.on('session.updated', onUpdated);
    socket.on('session.created', onList);
    socket.on('session.deleted', onList);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off('session.updated', onUpdated);
      socket.off('session.created', onList);
      socket.off('session.deleted', onList);
    };
  }, [queryClient, profile, shown, session, realtime, all]);

  return query;
}
