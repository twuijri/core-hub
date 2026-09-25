/**
 * What the composer's `/` commands do in an open conversation (decision §52).
 *
 * The composer knows the commands and reads them out of the text (`slashCommands.ts`); this
 * hook is the conversation's side: which commands its agent takes, and carrying each one out
 * with the operations the client already has — `sessions.compress`, `sessions.steerRun`,
 * a new chat, `sessions.fork`, archiving through `sessions.update`, the model picker — plus
 * clearing the screen, which hides what is on it until the person asks for it back and
 * deletes nothing.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useSkills } from '../agents/skills.js';
import { useForkSession, useUpdateSession } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import type { Agent, Message, Run } from '../types.js';
import type { ComboboxOption } from '../ui/Combobox.js';
import { chatHref } from './anchor.js';
import type { SlashSkill } from './Composer.js';
import { availableCommands, type SlashCommand, type SlashCommandId } from './slashCommands.js';
import type { ChatState } from './transcript.js';

export interface ChatCommands {
  commands: SlashCommand[];
  skills: SlashSkill[];
  onCommand(id: SlashCommandId, arg: string): Promise<string | void>;
  /** `sessions.compress`; absent when the agent cannot. */
  compress: (() => Promise<void>) | undefined;
  /** Why compressing waits (a run in flight), or `null`. */
  compressBlocked: string | null;
  /** The messages `/clear-screen` hid: every one up to and including this `seq`. */
  hiddenThrough: number | null;
  showHidden(): void;
}

export function useChatCommands({
  sessionId,
  state,
  agent,
  run,
  models,
  onModel,
  profileInLink,
}: {
  sessionId: string;
  state: ChatState;
  agent: Agent | undefined;
  run: Run | null | undefined;
  models: readonly ComboboxOption[];
  onModel(value: string): void;
  /** The profile to name in a chat link, when the conversation is not in the person's own. */
  profileInLink: string | null;
}): ChatCommands {
  const { t } = useI18n();
  const { client, profile } = useAuth();
  const navigate = useNavigate();
  const fork = useForkSession(sessionId);
  const update = useUpdateSession();
  const commands = useMemo(() => availableCommands(agent?.capabilities), [agent?.capabilities]);
  const offersSkills = commands.some((command) => command.id === 'skill');
  const skillList = useSkills(offersSkills ? agent?.id : undefined);
  const skills = useMemo(
    () =>
      (skillList.data?.categories ?? [])
        .flatMap((category) => category.skills)
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          key: skill.key,
          name: skill.name,
          description: skill.description ?? '',
        })),
    [skillList.data],
  );
  const [hiddenThrough, setHiddenThrough] = useState<number | null>(null);

  const compress = useCallback(
    async (focus: string | null = null) => {
      try {
        await client.request('post', '/sessions/{session_id}/compress', {
          params: { session_id: sessionId },
          body: { focus },
        });
      } catch (error) {
        throw new Error(describeError(error, t), { cause: error });
      }
    },
    [client, sessionId, t],
  );

  const onCommand = useCallback(
    async (id: SlashCommandId, arg: string): Promise<string | void> => {
      switch (id) {
        case 'compress':
          await compress(arg === '' ? null : arg);
          return;
        case 'steer': {
          // Nothing running: guidance for the next turn is simply the next message, which is
          // what Hermes itself does with a steer that has no turn to join.
          if (!run) return arg;
          const answer = await client.request(
            'post',
            '/sessions/{session_id}/runs/{run_id}/steer',
            {
              params: { session_id: sessionId, run_id: run.id },
              body: { text: arg },
            },
          );
          return (answer.data as { status: string }).status === 'queued' ? undefined : arg;
        }
        case 'new':
          navigate(`${routeOf('new_chat')}${agent ? `?agent=${agent.id}` : ''}`);
          return;
        case 'fork': {
          const session = (await fork.mutateAsync({})) as { id: string };
          navigate(chatHref(session.id, null, undefined, profileInLink));
          return;
        }
        case 'archive':
          await update.mutateAsync({ id: sessionId, patch: { archived: true }, profile });
          navigate(routeOf('new_chat'));
          return;
        case 'model': {
          const wanted = arg.trim().toLowerCase();
          if (wanted !== '') {
            const match = models.find(
              (option) =>
                option.value.toLowerCase() === wanted ||
                option.label.toLowerCase() === wanted ||
                option.value.toLowerCase().endsWith(`/${wanted}`),
            );
            if (!match) throw new Error(t('slash.model_unknown', { model: arg.trim() }));
            onModel(match.value);
            return;
          }
          // No name: the picker itself, where the person already chooses models.
          document.querySelector<HTMLElement>('[data-testid="composer-model"]')?.click();
          return;
        }
        case 'clear-screen': {
          const last = state.messages.at(-1);
          if (last) setHiddenThrough(last.seq);
          return;
        }
        default:
          // `message` commands are never handed here: they are sent as typed.
          return arg;
      }
    },
    [
      compress,
      client,
      sessionId,
      run,
      navigate,
      agent,
      fork,
      update,
      profile,
      profileInLink,
      models,
      onModel,
      state.messages,
      t,
    ],
  );

  return {
    commands,
    skills,
    onCommand,
    compress: commands.some((command) => command.id === 'compress')
      ? () => compress(null)
      : undefined,
    compressBlocked: run ? t('context_meter.wait_for_run') : null,
    hiddenThrough,
    showHidden: () => setHiddenThrough(null),
  };
}

/** The transcript without what `/clear-screen` hid. */
export function visibleMessages(messages: Message[], hiddenThrough: number | null): Message[] {
  return hiddenThrough === null
    ? messages
    : messages.filter((message) => message.seq > hiddenThrough);
}
