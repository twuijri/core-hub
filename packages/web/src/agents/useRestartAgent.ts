/**
 * Restarting an agent's runtime, in one place (owner, 2026-09-25).
 *
 * Two buttons ask for it — the small one beside the agent's name in its side list, and
 * «إعادة التشغيل الآن» on the Models screen's Runtime card when the settings changed after
 * Hermes last started — and both must behave the same: `agents.restart` returns a job, the
 * job is followed to its end (`useJob` reads it again until it finishes), the button stays
 * busy until then, and the end is said in a toast: «تمّت إعادة التشغيل» / "Restarted", or the
 * job's own error. Whatever depends on the runtime (the agent list, the Runtime checks) is
 * read again once it is done.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { keys } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { modelKeys } from '../models/queries.js';
import type { Agent } from '../types.js';
import { useToast } from '../ui/index.js';
import { useJob } from './skills.js';

/**
 * `agents.restart` is for owners and admins, and only where the hub supervises a runtime:
 * today that is Hermes (the server refuses every other adapter with `409 state_invalid`),
 * and not a Hermes the hub merely found (`runtime.state: not_applicable`).
 */
export function canRestart(
  agent: Pick<Agent, 'kind' | 'runtime'> | undefined,
  role: string | undefined,
): boolean {
  return (
    agent !== undefined &&
    (role === 'owner' || role === 'admin') &&
    agent.kind === 'hermes' &&
    agent.runtime.state !== 'not_applicable'
  );
}

export function useRestartAgent(agentId: string | undefined) {
  const { client, profile } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const status = job.data?.status;

  useEffect(() => {
    if (!jobId || !status || status === 'queued' || status === 'running') return;
    if (status === 'succeeded') toast({ title: t('agents.restart_done'), tone: 'success' });
    else
      toast({
        title: t('agents.restart_failed'),
        ...(job.data?.error?.error ? { body: job.data.error.error } : {}),
        tone: 'danger',
      });
    setJobId(null);
    void queryClient.invalidateQueries({ queryKey: keys.agents(profile) });
    void queryClient.invalidateQueries({ queryKey: modelKeys.runtime(profile) });
  }, [jobId, status, job.data, toast, t, queryClient, profile]);

  const restart = useCallback(async () => {
    if (!agentId || asking || jobId) return;
    setAsking(true);
    try {
      const { data } = await client.request('post', '/agents/{agent_id}/restart', {
        params: { agent_id: agentId },
      });
      setJobId(data.job_id);
    } catch (error) {
      toast({ title: t('agents.restart_failed'), body: describeError(error, t), tone: 'danger' });
    } finally {
      setAsking(false);
    }
  }, [agentId, asking, jobId, client, toast, t]);

  return { restart, pending: asking || jobId !== null };
}
