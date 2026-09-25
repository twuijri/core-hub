/**
 * An agent's skills. They are files in the agent's own home, so every write is a write to
 * that folder and the list is refetched from it rather than patched here — the folder is
 * the truth, and a cache that disagreed with it would be a second, wrong truth.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUploadAttachment } from '../attachments/queries.js';
import { useAuth } from '../auth/context.js';
import type { Job } from '../types.js';

export interface Skill {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  pinned: boolean;
  source: 'builtin' | 'user' | 'external';
  use_count: number;
  updated_at: string | null;
  content: string | null;
}

export interface SkillCategory {
  key: string;
  name: string;
  description: string | null;
  skills: Skill[];
}

export const skillKeys = {
  list: (profile: string, agentId: string) => ['agent-skills', profile, agentId] as const,
  one: (profile: string, agentId: string, key: string) =>
    ['agent-skills', profile, agentId, key] as const,
};

export function useSkills(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: skillKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/skills', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { categories: SkillCategory[]; home: string | null },
    enabled: !!session && !!agentId,
  });
}

export function useSkill(agentId: string | undefined, key: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: skillKeys.one(profile, agentId ?? '', key ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: key ?? '' },
        })
      ).data as unknown as Skill,
    enabled: !!session && !!agentId && !!key,
  });
}

function useSkillInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.list(profile, agentId ?? '') });
  };
}

export function useSaveSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { key: string; content: string }) =>
      (
        await client.request('put', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: input.key },
          body: { content: input.content } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function usePatchSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { key: string; enabled?: boolean; pinned?: boolean }) =>
      (
        await client.request('patch', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: input.key },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (key: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: key },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------- MCP

export interface McpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  connected: boolean;
  tools: Array<{ name: string; description: string }>;
  error: string | null;
  config: Record<string, unknown>;
  updated_at: string;
}

export const mcpKeys = {
  list: (profile: string, agentId: string) => ['agent-mcp', profile, agentId] as const,
};

export function useMcpServers(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: mcpKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/mcp-servers', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: McpServer[] },
    enabled: !!session && !!agentId,
  });
}

function useMcpInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: mcpKeys.list(profile, agentId ?? '') });
  };
}

export function useCreateMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      name: string;
      transport: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }) =>
      (
        await client.request('post', '/agents/{agent_id}/mcp-servers', {
          params: { agent_id: agentId ?? '' },
          body: input as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useUpdateMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      name: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }) =>
      (
        await client.request('patch', '/agents/{agent_id}/mcp-servers/{server_name}', {
          params: { agent_id: agentId ?? '', server_name: input.name },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.config === undefined ? {} : { config: input.config }),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (name: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/mcp-servers/{server_name}', {
          params: { agent_id: agentId ?? '', server_name: name },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------- the hub's own tools
//
// Core Hub offers itself to the agent as an MCP server (contract decision §67). The card on
// the MCP page reads and switches it per profile; the block it writes is tested like any
// other server, by name.

export type HubToolGroupId =
  'tasks' | 'schedules' | 'conversations' | 'notifications' | 'workflows' | 'files';

export interface HubToolGroup {
  id: HubToolGroupId;
  enabled: boolean;
  allow_writes: boolean;
  tools: Array<{ name: string; access: 'read' | 'write' }>;
}

export interface HubToolCall {
  id: string;
  tool: string;
  ok: boolean;
  error_code: string | null;
  user_id: string | null;
  session_id: string | null;
  duration_ms: number;
  created_at: string;
}

export interface HubTools {
  enabled: boolean;
  available: boolean;
  unavailable_reason: 'runtime_absent' | 'hermes_profile_absent' | null;
  server_name: string;
  url: string | null;
  groups: HubToolGroup[];
  recent_calls: HubToolCall[];
  updated_at: string | null;
}

export interface HubToolsPatch {
  enabled?: boolean;
  groups?: Array<{ id: HubToolGroupId; enabled?: boolean; allow_writes?: boolean }>;
}

export const hubToolKeys = {
  get: (profile: string, agentId: string) => ['agent-hub-tools', profile, agentId] as const,
};

export function useHubTools(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: hubToolKeys.get(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/hub-tools', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as HubTools,
    enabled: !!session && !!agentId,
  });
}

export function useUpdateHubTools(agentId: string | undefined) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: HubToolsPatch) =>
      (
        await client.request('patch', '/agents/{agent_id}/hub-tools', {
          params: { agent_id: agentId ?? '' },
          body: patch as never,
        })
      ).data as unknown as HubTools,
    onSuccess: (next) => {
      queryClient.setQueryData(hubToolKeys.get(profile, agentId ?? ''), next);
      // The block is a server in the same file; the list below leaves it out by name.
      void queryClient.invalidateQueries({ queryKey: mcpKeys.list(profile, agentId ?? '') });
    },
  });
}

// ---------------------------------------------------------------- memory

export interface MemoryItem {
  id: string;
  kind: 'document' | 'entry';
  title: string;
  content: string | null;
  tags: string[];
  revision: number;
  updated_at: string | null;
}

export const memoryKeys = {
  list: (profile: string, agentId: string, search: string) =>
    ['agent-memory', profile, agentId, search] as const,
};

export function useMemory(agentId: string | undefined, search: string) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: memoryKeys.list(profile, agentId ?? '', search),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/memory', {
          params: { agent_id: agentId ?? '' },
          query: search ? { q: search } : {},
        })
      ).data as unknown as { items: MemoryItem[] },
    enabled: !!session && !!agentId,
  });
}

function useMemoryInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['agent-memory', profile, agentId ?? ''] });
  };
}

export function useSaveMemory(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMemoryInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { id: string; content: string }) =>
      (
        await client.request('put', '/agents/{agent_id}/memory/{item_id}', {
          params: { agent_id: agentId ?? '', item_id: input.id },
          body: { content: input.content } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteMemory(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMemoryInvalidation(agentId);
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/memory/{item_id}', {
          params: { agent_id: agentId ?? '', item_id: id },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// -------------------------------------------------------------- channels

export interface ChannelField {
  key: string;
  label: { ar: string; en: string };
  kind: 'text' | 'secret' | 'toggle' | 'list';
  target: 'credentials' | 'configuration';
  value: unknown;
  hint: string | null;
}

export interface Channel {
  platform: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  exclusive: boolean;
  status: 'online' | 'offline' | 'error' | 'unknown';
  error: string | null;
  /** `qr` pairs by a code (WhatsApp); `token` links by a bot token (Telegram). */
  login: 'qr' | 'token' | null;
  /** WhatsApp (its session) and Telegram (its bot): whether this profile has one, and whose. */
  link: ChannelLink | null;
  fields: ChannelField[];
}

export interface ChannelLink {
  linked: boolean;
  account_id: string | null;
  account_name: string | null;
  account_phone: string | null;
  /** Telegram: the bot's @username, without the @. */
  account_username: string | null;
}

/** The messaging gateway serving the profile's channels (`agents.listChannels`). */
export interface ChannelGateway {
  profile: string;
  state: 'running' | 'starting' | 'stopped' | 'error';
  /** `now` in a named profile; `on_restart` in the default one. */
  applies: 'now' | 'on_restart';
  error: string | null;
}

export const channelKeys = {
  list: (profile: string, agentId: string) => ['agent-channels', profile, agentId] as const,
  pairing: (profile: string, agentId: string) => ['agent-pairing', profile, agentId] as const,
};

export function useChannels(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: channelKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/channels', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: Channel[]; gateway: ChannelGateway | null },
    enabled: !!session && !!agentId,
    // A gateway that is starting says so; read again until it has said how it went.
    refetchInterval: (query) => {
      const data = query.state.data as { gateway: ChannelGateway | null } | undefined;
      return data?.gateway?.state === 'starting' ? 3000 : false;
    },
  });
}

function useChannelInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: channelKeys.list(profile, agentId ?? '') });
  };
}

export function useUpdateChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      platform: string;
      enabled?: boolean;
      credentials?: Record<string, string>;
      configuration?: Record<string, unknown>;
    }) =>
      (
        await client.request('put', '/agents/{agent_id}/channels/{platform}', {
          params: { agent_id: agentId ?? '', platform: input.platform },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.credentials ? { credentials: input.credentials } : {}),
            ...(input.configuration ? { configuration: input.configuration } : {}),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useClearChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (platform: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/channels/{platform}', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data,
    onSuccess: invalidate,
  });
}

/** Unlink WhatsApp from the profile (`agents.unlinkChannel`). */
export function useUnlinkChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (platform: string) =>
      (
        await client.request('post', '/agents/{agent_id}/channels/{platform}/unlink', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data as unknown as Channel,
    onSuccess: invalidate,
  });
}

/** Link Telegram by the token @BotFather gave (`agents.linkChannel`). */
export function useLinkChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { platform: string; token: string; allowed_users?: string[] }) =>
      (
        await client.request('post', '/agents/{agent_id}/channels/{platform}/link', {
          params: { agent_id: agentId ?? '', platform: input.platform },
          body: {
            token: input.token,
            ...(input.allowed_users ? { allowed_users: input.allowed_users } : {}),
          },
        })
      ).data as unknown as Channel,
    onSuccess: invalidate,
  });
}

/** One of a channel's own settings (`agents.getChannelSettings`). */
export interface ChannelSetting {
  key: string;
  section: 'access' | 'replies' | 'groups' | 'media' | 'advanced';
  kind: 'toggle' | 'select' | 'number' | 'text' | 'list';
  value: unknown;
  default: unknown;
  choices: string[] | null;
  min: number | null;
  max: number | null;
  /** Kept once for the profile: it changes every channel there, not only this one. */
  shared: boolean;
  source: 'config' | 'env' | null;
}

const settingsKey = (profile: string, agentId: string, platform: string) =>
  ['agent-channel-settings', profile, agentId, platform] as const;

export function useChannelSettings(agentId: string | undefined, platform: string, open: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: settingsKey(profile, agentId ?? '', platform),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/channels/{platform}/settings', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data as unknown as { platform: string; options: ChannelSetting[] },
    enabled: !!session && !!agentId && open,
  });
}

export function useUpdateChannelSettings(agentId: string | undefined, platform: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (values: Record<string, unknown>) =>
      (
        await client.request('patch', '/agents/{agent_id}/channels/{platform}/settings', {
          params: { agent_id: agentId ?? '', platform },
          body: { values } as never,
        })
      ).data as unknown as { platform: string; options: ChannelSetting[] },
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKey(profile, agentId ?? '', platform), data);
      invalidate();
    },
  });
}

// ------------------------------------------------------------ pairing approvals

export interface PairingRequest {
  platform: string;
  request_id: string;
  user_id: string;
  user_name: string | null;
  requested_at: string;
}

export interface PairedSender {
  platform: string;
  user_id: string;
  user_name: string | null;
  approved_at: string | null;
}

/** How often the waiting list is read again while the page is open. */
export const PAIRING_POLL_MS = 10_000;

/**
 * Senders waiting for approval and the approved ones, in the selected profile. Read again
 * every ten seconds while the page is open: a new request arrives as a WhatsApp message to
 * the agent, and nothing tells the page but asking.
 */
export function usePairing(agentId: string | undefined, enabled = true) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: channelKeys.pairing(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/pairing', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { pending: PairingRequest[]; approved: PairedSender[] },
    enabled: !!session && !!agentId && enabled,
    refetchInterval: PAIRING_POLL_MS,
    retry: false,
  });
}

function usePairingInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: channelKeys.pairing(profile, agentId ?? '') });
  };
}

export function useApprovePairing(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = usePairingInvalidation(agentId);
  return useMutation({
    mutationFn: async (request: { platform: string; request_id: string }) =>
      (
        await client.request(
          'post',
          '/agents/{agent_id}/pairing/{platform}/requests/{request_id}/approve',
          {
            params: {
              agent_id: agentId ?? '',
              platform: request.platform,
              request_id: request.request_id,
            },
          },
        )
      ).data,
    onSettled: invalidate,
  });
}

export function useDenyPairing(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = usePairingInvalidation(agentId);
  return useMutation({
    mutationFn: async (request: { platform: string; request_id: string }) =>
      (
        await client.request(
          'delete',
          '/agents/{agent_id}/pairing/{platform}/requests/{request_id}',
          {
            params: {
              agent_id: agentId ?? '',
              platform: request.platform,
              request_id: request.request_id,
            },
          },
        )
      ).data,
    onSettled: invalidate,
  });
}

export function useRevokePairing(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = usePairingInvalidation(agentId);
  return useMutation({
    mutationFn: async (sender: { platform: string; user_id: string }) =>
      (
        await client.request('delete', '/agents/{agent_id}/pairing/{platform}/approved/{user_id}', {
          params: { agent_id: agentId ?? '', platform: sender.platform, user_id: sender.user_id },
        })
      ).data,
    onSettled: invalidate,
  });
}

// ------------------------------------------------------------ live tools
//
// The three things these pages ask Hermes to *do* (ADR 0015): connect to an MCP server
// once, pair a channel by QR, install a pack of skills. Each acts on the selected profile.

export interface McpTestResult {
  ok: boolean;
  tools: Array<{ name: string; description: string | null }>;
  error: string | null;
  duration_ms: number;
}

export function useTestMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (name: string) =>
      (
        await client.request('post', '/agents/{agent_id}/mcp-servers/{server_name}/test', {
          params: { agent_id: agentId ?? '', server_name: name },
        })
      ).data as unknown as McpTestResult,
  });
}

/**
 * Upload the files as skill packs (`purpose: skill`), install them, and delete the uploads:
 * the installed skill lives in the agent's folder and does not need them, so they would only
 * pile up in the profile's files. They are deleted whether the import succeeded or not (a
 * refused pack is sent again as a new upload), and a failed delete never hides the import's
 * own answer. The same pack uploaded again is refused by the hub as a skill that exists.
 */
export function useImportSkills(agentId: string | undefined) {
  const { client } = useAuth();
  const { upload } = useUploadAttachment();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (files: readonly File[]) => {
      const ids: string[] = [];
      try {
        for (const file of files) ids.push((await upload({ file, purpose: 'skill' })).id);
        return (
          await client.request('post', '/agents/{agent_id}/skills', {
            params: { agent_id: agentId ?? '' },
            body: { attachment_ids: ids } as never,
          })
        ).data as unknown as { items: Skill[] };
      } finally {
        await Promise.allSettled(
          ids.map((id) =>
            client.request('delete', '/attachments/{attachment_id}', {
              params: { attachment_id: id },
            }),
          ),
        );
      }
    },
    onSuccess: invalidate,
  });
}

/** What a `channel_login` job carries while it runs (`agents.loginChannel`). */
export interface PairingState {
  status?: string;
  qr?: string | null;
  expires_at?: string | null;
  account_name?: string | null;
  account_phone?: string | null;
  /** When the agent answers on it: at once (a named profile) or after Hermes's restart. */
  applies?: 'now' | 'on_restart';
}

export function useLoginChannel(agentId: string | undefined) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (platform: string) =>
      (
        await client.request('post', '/agents/{agent_id}/channels/{platform}/login', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data as { job_id: string },
  });
}

/**
 * One job, read again every two seconds until it ends: the fallback under `/rt/jobs`, so a
 * dropped socket never leaves a QR code on screen that Hermes has already replaced.
 */
export function useJob(jobId: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['job', profile, jobId ?? ''],
    queryFn: async () =>
      (await client.request('get', '/jobs/{job_id}', { params: { job_id: jobId ?? '' } }))
        .data as unknown as Job,
    enabled: !!session && !!jobId,
    refetchInterval: (query) => {
      const status = (query.state.data as Job | undefined)?.status;
      return status === 'succeeded' || status === 'failed' || status === 'cancelled' ? false : 2000;
    },
  });
}

export function useCancelJob() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (jobId: string) =>
      (await client.request('post', '/jobs/{job_id}/cancel', { params: { job_id: jobId } })).data,
  });
}
