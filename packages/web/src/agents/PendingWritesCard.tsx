/**
 * «بانتظار المراجعة» / "Waiting for review" — what Hermes's agent wrote to its memory or its
 * skills while `memory.write_approval` or `skills.write_approval` is on (contract decision §58).
 *
 * Hermes keeps each such write aside instead of saving it; here a person reads what it would
 * change and approves it (Hermes applies it with its own code) or rejects it (it is dropped).
 * The list is per profile, like the settings above it. A write Hermes cannot apply — a memory over
 * its budget — stays in the list with Hermes's words.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Schemas } from '../types.js';
import { Badge, Button, Card, CardHeader, Notice, Spinner } from '../ui/index.js';
import { intlLocale } from '../i18n/index.js';

type PendingWrite = Schemas['PendingWrite'];

export const pendingKeys = {
  list: (profile: string, agentId: string) => ['pending-writes', profile, agentId] as const,
};

export function usePendingWrites(agentId: string, enabled = true) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: pendingKeys.list(profile, agentId),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/pending-writes', {
          params: { agent_id: agentId },
        })
      ).data,
    enabled: !!session && enabled && agentId !== '',
    retry: false,
    // The agent stages writes on its own time: look again now and then.
    refetchInterval: 15_000,
  });
}

export function usePendingAnswer(agentId: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      write,
      answer,
    }: {
      write: PendingWrite;
      answer: 'approve' | 'reject';
    }) => {
      const params = { agent_id: agentId, write_kind: write.kind, write_id: write.id };
      if (answer === 'approve') {
        await client.request(
          'post',
          '/agents/{agent_id}/pending-writes/{write_kind}/{write_id}/approve',
          { params },
        );
      } else {
        await client.request(
          'delete',
          '/agents/{agent_id}/pending-writes/{write_kind}/{write_id}',
          {
            params,
          },
        );
      }
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: pendingKeys.list(profile, agentId) }),
  });
}

export function PendingWritesCard({ agentId }: { agentId: string }) {
  const { t, language } = useI18n();
  const list = usePendingWrites(agentId);
  const answer = usePendingAnswer(agentId);
  const items = list.data?.items ?? [];
  const when = (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(intlLocale(language), {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(at))
      : null;

  return (
    <Card>
      <div data-testid="pending-writes">
        <CardHeader title={t('agents.pending.title')} subtitle={t('agents.pending.subtitle')} />
        {list.isPending && <Spinner label={t('common.loading')} />}
        {list.isError && <Notice tone="danger">{describeError(list.error, t)}</Notice>}
        {answer.isError && (
          <Notice tone="danger" role="alert">
            <span data-testid="pending-error">{describeError(answer.error, t)}</span>
          </Notice>
        )}
        {list.data && items.length === 0 && (
          <p className="text-sm text-muted" data-testid="pending-empty">
            {t('agents.pending.empty')}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {items.map((write) => (
            <li
              key={`${write.kind}-${write.id}`}
              className="rounded-lg border border-line p-3"
              data-testid={`pending-write-${write.id}`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone={write.kind === 'memory' ? 'info' : 'accent'}>
                  {write.kind === 'memory'
                    ? write.target === 'user'
                      ? t('agents.pending.kind_user')
                      : t('agents.pending.kind_memory')
                    : t('agents.pending.kind_skill')}
                </Badge>
                <Badge tone="neutral">
                  {write.origin === 'background_review'
                    ? t('agents.pending.origin_review')
                    : t('agents.pending.origin_chat')}
                </Badge>
                {when(write.created_at) && (
                  <span className="text-xs text-muted">{when(write.created_at)}</span>
                )}
              </div>
              <p className="text-sm font-medium" dir="auto">
                {write.name ? `${write.name} — ` : ''}
                {write.summary || write.action}
              </p>
              {write.old_text && (
                <pre
                  className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs line-through opacity-70"
                  dir="auto"
                >
                  {write.old_text}
                </pre>
              )}
              {write.content && (
                <pre
                  className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs"
                  dir="auto"
                  data-testid={`pending-content-${write.id}`}
                >
                  {write.content}
                </pre>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  disabled={answer.isPending}
                  loading={
                    answer.isPending &&
                    answer.variables?.write.id === write.id &&
                    answer.variables.answer === 'approve'
                  }
                  onClick={() => answer.mutate({ write, answer: 'approve' })}
                  data-testid={`pending-approve-${write.id}`}
                >
                  {t('agents.pending.approve')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={answer.isPending}
                  loading={
                    answer.isPending &&
                    answer.variables?.write.id === write.id &&
                    answer.variables.answer === 'reject'
                  }
                  onClick={() => answer.mutate({ write, answer: 'reject' })}
                  data-testid={`pending-reject-${write.id}`}
                >
                  {t('agents.pending.reject')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
