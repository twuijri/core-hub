/**
 * A new room: its name, and the agents to seat in it now. Each chosen agent sits under its
 * own name; more seats — the same agent twice under two names, instructions, a model — are
 * added from the room's members panel. The person who makes the room manages it.
 */
import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../auth/client.js';
import { installedAgents } from '../chat/AgentChips.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Button, Checkbox, Dialog, Field, Input, Notice } from '../ui/index.js';
import { useCreateRoom } from './queries.js';

export function NewRoomDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(roomId: string): void;
}) {
  const { t } = useI18n();
  const agents = useAgents();
  const create = useCreateRoom();
  const choices = useMemo(() => installedAgents(agents.data ?? []), [agents.data]);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPicked([]);
    setFailed([]);
    create.reset();
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const seats = choices
      .filter((agent) => picked.includes(agent.id))
      .map((agent) => ({ agent_id: agent.id, name: agent.name }));
    create.mutate(
      { name: trimmed, seats },
      {
        onSuccess: (result) => {
          const refused = result.seat_results
            .map((r, i) => (r.ok ? null : `${seats[i]?.name ?? ''}: ${r.error?.error ?? ''}`))
            .filter((line): line is string => line !== null);
          if (refused.length > 0) setFailed(refused);
          onCreated(result.room.id);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('nav.new_room')}
      description={t('rooms.new.description')}
      closeLabel={t('common.cancel')}
      testId="new-room-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={submit}
            data-testid="new-room-create"
          >
            {t('rooms.new.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label={t('rooms.new.name')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="new-room-name"
              autoFocus
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t('rooms.new.agents')}</legend>
          {choices.length === 0 && !agents.isPending && (
            <Notice tone="info">{t('rooms.new.no_agents')}</Notice>
          )}
          {choices.map((agent) => (
            <Checkbox
              key={agent.id}
              checked={picked.includes(agent.id)}
              onChange={(on) =>
                setPicked((current) =>
                  on ? [...current, agent.id] : current.filter((id) => id !== agent.id),
                )
              }
              label={agent.name}
              testId={`new-room-agent-${agent.id}`}
            />
          ))}
        </fieldset>
        {failed.length > 0 && (
          <Notice tone="warning">{t('rooms.new.seat_failed', { list: failed.join('، ') })}</Notice>
        )}
        {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      </form>
    </Dialog>
  );
}
