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
 * character budget the hub enforces (`memory_too_long`). Each entry is drawn on its own, with
 * its own edit and remove, and the list says how much of its budget it takes (decision §102):
 * an agent whose memory is full cannot keep anything new, and a person should see that coming.
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
import {
  Badge,
  Button,
  Dialog,
  Notice,
  Skeleton,
  SkeletonGroup,
  Textarea,
  useConfirm,
} from '../ui/index.js';
import { IconEdit, IconPlus, IconTrash } from '../ui/icons.js';
import { entriesOf, fits, isList, joinEntries, lengthOf, listOf, toneOf } from './memoryEntries.js';
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
                <Document item={item} agentId={agentId} onEdit={() => setEditing(item)} />
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

function Document({
  item,
  onEdit,
  agentId,
}: {
  item: MemoryItem;
  onEdit: () => void;
  agentId: string | undefined;
}) {
  const { t } = useI18n();
  const list = isList(item);
  const entries = list ? listOf(item) : [];
  const empty = list ? entries.length === 0 : (item.content ?? '').trim() === '';
  const [entry, setEntry] = useState<{ index: number | null } | null>(null);
  const save = useSaveMemory(agentId);
  const confirm = useConfirm();

  const remove = async (index: number) => {
    const yes = await confirm.ask({
      title: t('memory.remove_title'),
      body: <span dir="auto">{entries[index]}</span>,
      confirmLabel: t('memory.remove'),
    });
    if (!yes) return;
    save.mutate({ id: item.id, content: joinEntries(entries.filter((_, i) => i !== index)) });
  };

  return (
    <div
      className="knowledge-row"
      data-kind={item.id === 'soul' ? 'journal' : 'note'}
      data-testid={`memory-doc-${item.id}`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(`memory.doc_${item.id}`)}</span>
        <span className="text-xs text-muted" dir="ltr">
          {item.title}
        </span>
        {item.id === 'soul' && <Badge tone="accent">{t('memory.persona')}</Badge>}
        <span className="ms-auto flex items-center gap-1">
          {list && (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPlus size={14} />}
              onClick={() => setEntry({ index: null })}
              data-testid={`memory-add-${item.id}`}
            >
              {t('memory.add_entry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} data-testid={`memory-edit-${item.id}`}>
            {t(empty ? 'memory.write' : list ? 'memory.edit_all' : 'common.edit')}
          </Button>
        </span>
      </span>
      {list && typeof item.char_limit === 'number' && (
        <BudgetMeter count={item.char_count ?? lengthOf(entries)} limit={item.char_limit} />
      )}
      {list ? (
        empty ? (
          <p className="knowledge-content">{t(`memory.empty_${item.id}`)}</p>
        ) : (
          <ol className="memory-entries" data-testid={`memory-entries-${item.id}`}>
            {entries.map((text, index) => (
              <li
                key={`${index}:${text.slice(0, 24)}`}
                className="memory-entry"
                data-testid="memory-entry"
              >
                <p className="memory-entry-text" dir="auto">
                  {text}
                </p>
                <span className="memory-entry-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<IconEdit size={14} />}
                    aria-label={t('memory.edit_entry')}
                    tooltip={t('memory.edit_entry')}
                    onClick={() => setEntry({ index })}
                    data-testid="memory-entry-edit"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<IconTrash size={14} />}
                    aria-label={t('memory.remove')}
                    tooltip={t('memory.remove')}
                    disabled={save.isPending}
                    onClick={() => void remove(index)}
                    data-testid="memory-entry-remove"
                  />
                </span>
              </li>
            ))}
          </ol>
        )
      ) : (
        <p className="knowledge-content" dir="auto">
          {empty ? t(`memory.empty_${item.id}`) : item.content}
        </p>
      )}
      {save.isError && <Notice tone="danger">{describeToolError(save.error, t)}</Notice>}
      {entry && (
        <EntryEditor
          agentId={agentId}
          item={item}
          entries={entries}
          index={entry.index}
          onClose={() => setEntry(null)}
        />
      )}
      {confirm.dialog}
    </div>
  );
}

/** «١٬٢٣٤ من ٢٬٢٠٠ حرف»: the list against its budget, as a line and a thin bar. */
function BudgetMeter({
  count,
  limit,
  testId = 'memory-budget',
}: {
  count: number;
  limit: number;
  testId?: string;
}) {
  const { t, language } = useI18n();
  const format = (value: number) =>
    new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en').format(value);
  const tone = toneOf(count, limit);
  return (
    <div
      className="memory-budget"
      data-tone={tone}
      data-testid={testId}
      data-count={count}
      data-limit={limit}
    >
      <div className="memory-budget-bar" aria-hidden>
        <span style={{ inlineSize: `${Math.min(100, Math.max(1, (count / limit) * 100))}%` }} />
      </div>
      <span className="memory-budget-text">
        {t(tone === 'danger' ? 'memory.budget_over' : 'memory.budget', {
          count: format(count),
          limit: format(limit),
        })}
      </span>
    </div>
  );
}

/** One entry, written or rewritten on its own; the rest of the list is sent unchanged. */
function EntryEditor({
  agentId,
  item,
  entries,
  index,
  onClose,
}: {
  agentId: string | undefined;
  item: MemoryItem;
  entries: string[];
  index: number | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const save = useSaveMemory(agentId);
  const [draft, setDraft] = useState(index === null ? '' : (entries[index] ?? ''));
  // What the list would be: the entry replaced (or added last), split as the agent splits it —
  // a `§` line typed inside makes two entries, which the counter then counts.
  const typed = entriesOf(draft);
  const next =
    index === null
      ? [...entries, ...typed]
      : [...entries.slice(0, index), ...typed, ...entries.slice(index + 1)];
  const current = item.char_count ?? lengthOf(entries);
  const count = lengthOf(next);
  const limit = item.char_limit ?? null;
  const ok = fits(count, current, limit);

  return (
    <Dialog
      open
      size="md"
      onOpenChange={(open) => !open && onClose()}
      title={t(index === null ? 'memory.add_entry_title' : 'memory.edit_entry_title', {
        name: t(`memory.doc_${item.id}`),
      })}
      description={t(`memory.about_${item.id}`)}
      closeLabel={t('common.cancel')}
      testId="memory-entry-editor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={save.isPending || !ok || (index === null && typed.length === 0)}
            data-testid="save-memory-entry"
            onClick={() =>
              save.mutate({ id: item.id, content: joinEntries(next) }, { onSuccess: onClose })
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Textarea
          rows={6}
          dir="auto"
          aria-label={t('memory.entry')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="memory-entry-content"
        />
        {limit !== null && <BudgetMeter count={count} limit={limit} testId="memory-entry-budget" />}
        {!ok && (
          <Notice tone="danger">
            {t('memory.too_long', { length: String(count), limit: String(limit) })}
          </Notice>
        )}
        {save.isError && <Notice tone="danger">{describeToolError(save.error, t)}</Notice>}
      </div>
    </Dialog>
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
