/**
 * An agent's seat in the room: which agent, the name the room calls it by (`@name`), what it
 * is there for, its own instructions, and the model it answers with (empty = the agent's
 * own). The agent of an existing seat does not change; a different agent is a new seat.
 */
import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../auth/client.js';
import { installedAgents } from '../chat/AgentChips.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import type { Seat } from '../types.js';
import { Button, Dialog, Field, Input, Notice, Select, Textarea } from '../ui/index.js';
import { useAddSeat, useUpdateSeat } from './queries.js';

export function SeatDialog({
  roomId,
  open,
  seat,
  onClose,
}: {
  roomId: string;
  open: boolean;
  /** The seat to edit; `null` adds one. */
  seat: Seat | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const agents = useAgents();
  const add = useAddSeat(roomId);
  const update = useUpdateSeat(roomId);
  const choices = useMemo(() => installedAgents(agents.data ?? []), [agents.data]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');

  useEffect(() => {
    if (!open) return;
    add.reset();
    update.reset();
    setAgentId(seat?.agent_id ?? choices[0]?.id ?? null);
    setName(seat?.name ?? choices[0]?.name ?? '');
    setDescription(seat?.description ?? '');
    setInstructions(seat?.instructions ?? '');
    setModel(seat?.model ?? '');
  }, [open, seat?.id]);
  useEffect(() => {
    if (open && !seat && agentId === null && choices[0]) {
      setAgentId(choices[0].id);
      setName(choices[0].name);
    }
  }, [open, seat, agentId, choices]);

  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const submit = () => {
    if (!agentId || !name.trim()) return;
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      instructions: instructions.trim() || null,
      model: model.trim() || null,
    };
    if (seat) update.mutate({ seatId: seat.id, ...body }, { onSuccess: onClose });
    else add.mutate({ agent_id: agentId, ...body }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={seat ? t('rooms.seat.edit_title') : t('rooms.seat.add_title')}
      description={t('rooms.seat.description')}
      closeLabel={t('common.cancel')}
      testId="seat-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!agentId || !name.trim()}
            loading={pending}
            onClick={submit}
            data-testid="seat-save"
          >
            {seat ? t('common.save') : t('rooms.seat.add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {choices.length === 0 && !agents.isPending ? (
          <Notice tone="warning">{t('rooms.new.no_agents')}</Notice>
        ) : (
          <Select
            value={agentId}
            onValueChange={(next) => {
              setAgentId(next);
              const agent = choices.find((a) => a.id === next);
              if (agent && !seat) setName(agent.name);
            }}
            options={choices.map((agent) => ({ value: agent.id, label: agent.name }))}
            label={t('rooms.seat.agent')}
            disabled={!!seat}
            testId="seat-agent"
          />
        )}
        <Field label={t('rooms.seat.name')} hint={t('rooms.seat.name_hint')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="seat-name"
            />
          )}
        </Field>
        <Field label={t('rooms.seat.role')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              maxLength={300}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="seat-description"
            />
          )}
        </Field>
        <Field label={t('rooms.seat.instructions')} hint={t('rooms.seat.instructions_hint')}>
          {(props) => (
            <Textarea
              {...props}
              dir="auto"
              rows={3}
              maxLength={8000}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              data-testid="seat-instructions"
            />
          )}
        </Field>
        <Field label={t('rooms.seat.model')} hint={t('rooms.seat.model_hint')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              data-testid="seat-model"
            />
          )}
        </Field>
        {error && <Notice tone="danger">{describeError(error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
