/**
 * An agent's memory: the three documents it reads about itself and about you.
 *
 *   الشخصية  `SOUL.md`             who it is — read at the start of every conversation
 *   الذاكرة  `memories/MEMORY.md`  what it learned and chose to keep
 *   عنك      `memories/USER.md`    what it knows about the person it is talking to
 *
 * The files are Hermes's own, in the selected profile: what the agent kept during a
 * conversation shows here, and what a person writes here reaches its next conversation.
 * The two memory lists are short entries separated by a line holding only `§`, within a
 * character budget the hub enforces (`memory_too_long`).
 *
 * Three rows, always. A document the agent has not written yet is shown empty rather
 * than hidden: "nothing has been written about you" is an answer, and a page that had
 * two rows here and three there would read as a bug.
 *
 * **There is no delete.** Removing the persona does not leave an agent with none; it
 * leaves it with an unpredictable one. Emptying is an edit, and that is the only
 * operation offered.
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import { Badge, Button, Dialog, Notice, Skeleton, SkeletonGroup, Textarea } from '../ui/index.js';
import { useMemory, useSaveMemory, type MemoryItem } from './skills.js';
import { describeToolError } from './toolErrors.js';

export function AgentMemoryScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const memory = useMemory(agentId, '');
  const [editing, setEditing] = useState<MemoryItem | null>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('memory.title_of', { name: agent.name }) : t('nav.agent_memory');

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-xs text-muted">{t('memory.note')}</p>

        {memory.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="5rem" radius="md" />
            <Skeleton height="5rem" radius="md" />
          </SkeletonGroup>
        )}
        {memory.isError && <Notice tone="danger">{describeToolError(memory.error, t)}</Notice>}
        {memory.data && (
          <ul className="flex flex-col gap-2" data-testid="memory-list">
            {memory.data.items.map((item) => (
              <li key={item.id}>
                <Document item={item} onEdit={() => setEditing(item)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <MemoryEditor agentId={agentId} item={editing} onClose={() => setEditing(null)} />
      )}
    </AppShell>
  );
}

function Document({ item, onEdit }: { item: MemoryItem; onEdit: () => void }) {
  const { t } = useI18n();
  const empty = (item.content ?? '').trim() === '';
  return (
    <div className="knowledge-row" data-kind={item.id === 'soul' ? 'journal' : 'note'}>
      <span className="flex items-center gap-2">
        <span className="font-medium">{t(`memory.doc_${item.id}`)}</span>
        <span className="text-xs text-muted" dir="ltr">
          {item.title}
        </span>
        {item.id === 'soul' && <Badge tone="accent">{t('memory.persona')}</Badge>}
        <Button
          className="ms-auto"
          size="sm"
          variant="ghost"
          onClick={onEdit}
          data-testid={`memory-edit-${item.id}`}
        >
          {t(empty ? 'memory.write' : 'common.edit')}
        </Button>
      </span>
      <p className="knowledge-content" dir="auto">
        {empty ? t(`memory.empty_${item.id}`) : item.content}
      </p>
    </div>
  );
}

function MemoryEditor({
  agentId,
  item,
  onClose,
}: {
  agentId: string | undefined;
  item: MemoryItem;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const save = useSaveMemory(agentId);
  const [draft, setDraft] = useState<string | null>(null);
  const content = draft ?? item.content ?? '';

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={t(`memory.doc_${item.id}`)}
      description={t(`memory.about_${item.id}`)}
      closeLabel={t('common.cancel')}
      testId="memory-editor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={save.isPending}
            data-testid="save-memory"
            onClick={() => save.mutate({ id: item.id, content }, { onSuccess: onClose })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Textarea
          rows={16}
          dir="auto"
          aria-label={t('memory.content')}
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="memory-content"
        />
        {item.id !== 'soul' && <p className="text-xs text-muted">{t('memory.entries_hint')}</p>}
        {save.isError && <Notice tone="danger">{describeToolError(save.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
