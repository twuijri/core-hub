/**
 * Knowledge: the journal, the notes and the files of this workspace, in one list.
 *
 * Three tables merged by the hub, newest first, because a client that pages three sources
 * cannot page them as one. The screen therefore has one list and one filter, and the kind
 * is a property of a row rather than a tab — which is also how you notice that a day's
 * journal entry and the file attached to it belong next to each other.
 *
 * Nothing is created here. These rows are written by what happens: a conversation that
 * attached a file, an agent that kept a note. A "new note" button would make this a notes
 * app, and it is a window onto what the hub already knows.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  EmptyState,
  Input,
  Notice,
  Segmented,
  Skeleton,
  SkeletonGroup,
} from '../ui/index.js';
import { IconKnowledge, IconSearch } from '../ui/icons.js';
import { useKnowledge, type ItemKind, type KnowledgeItem } from './queries.js';
import { intlLocale } from '../i18n/index.js';

const KINDS: Array<ItemKind | 'all'> = ['all', 'journal', 'note', 'file'];

export function KnowledgeTab() {
  const { t, language } = useI18n();
  const [kind, setKind] = useState<ItemKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const items = useKnowledge(kind, search);
  const rows = items.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={t('knowledge.kind')}
          value={kind}
          onChange={(value) => setKind(value as ItemKind | 'all')}
          options={KINDS.map((value) => ({ value, label: t(`knowledge.kind_${value}`) }))}
        />
        <Input
          className="ms-auto max-w-64"
          inputSize="sm"
          icon={<IconSearch size={14} />}
          placeholder={t('knowledge.search')}
          aria-label={t('knowledge.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="knowledge-search"
        />
      </div>
      {items.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="4rem" radius="md" />
          <Skeleton height="4rem" radius="md" />
        </SkeletonGroup>
      )}
      {items.isError && <Notice tone="danger">{describeError(items.error, t)}</Notice>}
      {items.data &&
        (rows.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<IconKnowledge size={20} />}
            // A search that found nothing is a different answer from a workspace that
            // holds nothing, and saying the wrong one sends the person looking.
            title={t(search ? 'knowledge.no_match' : 'knowledge.empty')}
            body={t(search ? 'knowledge.no_match_body' : 'knowledge.empty_body')}
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="knowledge-list">
            {rows.map((item) => (
              <Item key={item.id} item={item} language={language} />
            ))}
          </ul>
        ))}
      {items.data?.next_cursor && <p className="text-xs text-muted">{t('knowledge.more')}</p>}
    </div>
  );
}

function Item({ item, language }: { item: KnowledgeItem; language: string }) {
  const { t } = useI18n();
  const when = item.date ?? item.created_at.slice(0, 10);
  return (
    <li className="knowledge-row" data-kind={item.kind}>
      <span className="flex items-center gap-2">
        <Badge
          tone={item.kind === 'file' ? 'info' : item.kind === 'journal' ? 'accent' : 'neutral'}
        >
          {t(`knowledge.kind_${item.kind}`)}
        </Badge>
        <span className="font-medium" dir="auto">
          {item.title ?? t('knowledge.untitled')}
        </span>
        <time className="ms-auto text-xs text-muted" dateTime={when}>
          {new Intl.DateTimeFormat(intlLocale(language), {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(new Date(when))}
        </time>
      </span>
      {item.content && (
        <p className="knowledge-content" dir="auto">
          {item.content}
        </p>
      )}
      {item.tags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
      )}
    </li>
  );
}
