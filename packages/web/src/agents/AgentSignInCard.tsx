/**
 * Signing an installed coding agent in to its own vendor account (Kimi Code, Grok Build) by
 * device code (`agents.startSignIn`): the code and link the agent's own sign-in printed, a
 * quiet wait while the hub polls, then the outcome in words. The agent keeps the credential in
 * its own folder, for every profile; nothing here holds a token. The steps and outcomes read
 * as a provider's sign-in does (`models/SignInPanel.tsx`), with the same words.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { SIGN_IN_POLL_MS } from '../models/queries.js';
import type { Agent, ProviderSignIn } from '../types.js';
import { Button, Card, CardHeader, Notice, Spinner } from '../ui/index.js';
import { IconCopy } from '../ui/icons.js';

export function AgentSignInCard({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const [signInId, setSignInId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: async () =>
      (
        await client.request('post', '/agents/{agent_id}/sign-in', {
          params: { agent_id: agent.id },
        })
      ).data as ProviderSignIn,
    onSuccess: (signIn) => setSignInId(signIn.id),
  });
  const status = useQuery({
    queryKey: ['agents', 'sign-in', profile, agent.id, signInId] as const,
    enabled: signInId !== null,
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/sign-in/{sign_in_id}', {
          params: { agent_id: agent.id, sign_in_id: signInId as string },
        })
      ).data as ProviderSignIn,
    refetchInterval: (query) =>
      !query.state.data || query.state.data.status === 'pending' ? SIGN_IN_POLL_MS : false,
  });
  const current = status.data ?? start.data ?? null;
  const begin = () => {
    setSignInId(null);
    start.mutate();
  };

  return (
    <Card>
      <CardHeader
        title={t('agents.signin_title', { name: agent.name })}
        subtitle={t('agents.signin_hint', { name: agent.name })}
      />
      <div className="flex flex-col gap-2" data-testid="agent-sign-in">
        {start.isPending && <Spinner label={t('common.loading')} />}
        {start.isError && <Notice tone="danger">{describeError(start.error, t)}</Notice>}
        {current && (
          <>
            <p className="text-sm">{t('models.signin.steps')}</p>
            {current.user_code && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{t('models.signin.code')}</span>
                <code
                  className="rounded-md px-2 py-1 text-lg font-semibold tracking-widest"
                  dir="ltr"
                  data-testid="agent-sign-in-code"
                >
                  {current.user_code}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<IconCopy size={14} />}
                  aria-label={t('models.signin.copy')}
                  onClick={() => void navigator.clipboard?.writeText(current.user_code ?? '')}
                />
              </div>
            )}
            <a
              className="link underline"
              href={current.verification_url}
              target="_blank"
              rel="noreferrer noopener"
              dir="ltr"
              data-testid="agent-sign-in-link"
            >
              {t('models.signin.open')}
            </a>
            {current.status === 'pending' && <Spinner label={t('models.signin.waiting')} />}
            {current.status === 'approved' && (
              <Notice tone="success">
                <span data-testid="agent-sign-in-approved">
                  {t('agents.signin_approved', { name: agent.name })}
                </span>
              </Notice>
            )}
            {(current.status === 'denied' ||
              current.status === 'expired' ||
              current.status === 'failed') && (
              <Notice tone="danger">
                <span data-testid="agent-sign-in-ended" dir="auto">
                  {t(`models.signin.${current.status}`)}
                  {current.error ? ` ${current.error}` : ''}
                </span>
              </Notice>
            )}
            {status.isError && <Notice tone="danger">{describeError(status.error, t)}</Notice>}
          </>
        )}
        {(!current || current.status !== 'pending') && !start.isPending && (
          <div>
            <Button
              variant={current ? 'secondary' : 'primary'}
              onClick={begin}
              data-testid="agent-sign-in-start"
            >
              {current ? t('models.signin.retry') : t('agents.signin_action')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
