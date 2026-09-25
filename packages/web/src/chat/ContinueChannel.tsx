/**
 * "Continue in Core Hub" (contract decision §58): a channel conversation is read-only in the
 * hub, so going on with it here is a new chat in the same profile, with the conversation
 * attached for the agent to read.
 *
 * The hub makes the chat and the transcript file and answers the first message
 * (`sessions.continueChannelConversation`); this hands that message to the chat screen the way
 * the new-chat screen hands over a typed one (`firstMessage.ts`), so it is sent once the chat
 * is listening and the agent's first words stream in as they come. The agent is the profile's
 * Hermes — the one the channel talked to — or, without it, the first agent that can answer.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { useProfileInLink } from '../shell/profiles.js';
import type { ContentBlock } from '../types.js';
import { Button, Dialog, Field, Notice, Textarea } from '../ui/index.js';
import { installedAgents } from './AgentChips.js';
import { chatHref } from './anchor.js';
import { putFirstMessage } from './firstMessage.js';

interface Continuation {
  session: { id: string; profile: string };
  first_message: ContentBlock[];
}

export function ContinueChannel({ id, channel }: { id: string; channel: string }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const agents = useAgents();
  const navigate = useNavigate();
  const inLink = useProfileInLink();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = installedAgents(agents.data ?? []);
  const agent = ready.find((each) => each.slug === 'hermes') ?? ready[0] ?? null;

  const go = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await client.request(
        'post',
        '/channel-conversations/{conversation_id}/continue',
        {
          params: { conversation_id: id },
          body: { agent_id: agent.id, note: note.trim() || null },
        },
      );
      const made = data as unknown as Continuation;
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      putFirstMessage(made.session.id, made.first_message);
      navigate(chatHref(made.session.id, null, undefined, inLink(made.session.profile)));
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        className="self-start"
        onClick={() => setOpen(true)}
        data-testid="channel-continue"
      >
        {t('sessions.channels.continue.button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title={t('sessions.channels.continue.title')}
        closeLabel={t('ui.close')}
        size="sm"
        testId="channel-continue-dialog"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('sessions.channels.continue.hint', { channel })}</p>
          <Field label={t('sessions.channels.continue.note')}>
            {(props) => (
              <Textarea
                {...props}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                dir="auto"
                data-testid="channel-continue-note"
              />
            )}
          </Field>
          {agents.data && !agent && (
            <Notice tone="warning">{t('sessions.channels.continue.no_agent')}</Notice>
          )}
          {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
          <Button
            className="self-start"
            disabled={!agent}
            loading={busy}
            onClick={() => void go()}
            data-testid="channel-continue-go"
          >
            {t('sessions.channels.continue.go')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
