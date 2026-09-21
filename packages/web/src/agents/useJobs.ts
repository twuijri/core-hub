// `/rt/jobs`: every 202 ends here as job.completed / job.failed, and registry changes arrive
// as agent.updated. One subscription for the app; screens read the map by job id.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { JOB_EVENTS, isEnvelope } from '../realtime/envelope.js';
import type { Agent, Job } from '../types.js';

export function useJobs(): Record<string, Job> {
  const realtime = useRealtime();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  useEffect(() => {
    const socket = realtime.socket('jobs');
    const handler = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      if (raw.event === 'agent.updated') {
        const agent = raw.payload.agent as Agent;
        queryClient.setQueryData<Agent[]>(['agents', profile], (list) =>
          list?.map((a) => (a.id === agent.id ? agent : a)),
        );
        return;
      }
      const job = raw.payload.job as Job;
      setJobs((current) => ({ ...current, [job.id]: job }));
    };
    for (const name of JOB_EVENTS) socket.on(name, handler);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of JOB_EVENTS) socket.off(name, handler);
    };
  }, [profile, queryClient]);
  return jobs;
}
