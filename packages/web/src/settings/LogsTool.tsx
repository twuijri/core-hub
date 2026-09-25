/**
 * Settings → Logs (`audit.listLogLines`, contract decision §51): what the hub and every
 * Hermes gateway wrote lately, from the rings the hub keeps in memory.
 *
 * The filters are the hub's, so the last 5000 lines are searched where they are kept rather
 * than 200 of them here. Live tail asks every three seconds for the lines after the last one
 * shown, and stops while the tab is hidden. Download saves what is shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRODUCT } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Input, Notice, Segmented, Select, Spinner, Switch } from '../ui/index.js';
import { IconDownload, IconSearch } from '../ui/icons.js';
import { appendTail, logText, saveText, usePageVisible, type LogLine } from './live.js';

type Source = 'all' | 'hub' | 'hermes' | 'errors';
type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogPage {
  lines: LogLine[];
  last_seq: number;
  capacity: number;
  sources: Array<{ source: 'hub' | 'hermes'; profile: string | null; lines: number }>;
}

const LIMITS = [200, 1000, 5000] as const;
const TAIL_MS = 3_000;
const SEARCH_DEBOUNCE_MS = 300;

export function LogsTool() {
  const { t } = useI18n();
  const { client, session } = useAuth();
  const visible = usePageVisible();

  const [source, setSource] = useState<Source>('all');
  const [profile, setProfile] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>('debug');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState<number>(200);
  const [tail, setTail] = useState(true);

  const [lines, setLines] = useState<LogLine[]>([]);
  const [sources, setSources] = useState<LogPage['sources']>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // A profile only narrows Hermes lines; the hub's own and "errors only" take none.
  const profileFilter = source === 'hermes' ? profile : null;
  const query = useMemo(
    () => ({
      source,
      ...(profileFilter ? { profile: profileFilter } : {}),
      ...(source === 'errors' ? {} : { level }),
      ...(q ? { q } : {}),
      limit,
    }),
    [source, profileFilter, level, q, limit],
  );

  const fetchPage = useCallback(
    async (after?: number) =>
      (
        await client.request('get', '/audit/logs/lines', {
          query: after === undefined ? query : { ...query, after },
        })
      ).data as LogPage,
    [client, query],
  );

  // A new filter is a new page.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    fetchPage().then(
      (page) => {
        if (cancelled) return;
        setLines(page.lines);
        setSources(page.sources);
        setLastSeq(page.last_seq);
        setError(null);
        setLoading(false);
        stick.current = true;
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(failure);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPage, session]);

  // The tail: only what is newer than the newest line the hub had last time.
  useEffect(() => {
    if (!tail || !visible || loading || !session) return;
    let cancelled = false;
    const timer = setInterval(() => {
      fetchPage(lastSeq).then(
        (page) => {
          if (cancelled) return;
          if (page.lines.length > 0) setLines((shown) => appendTail(shown, page.lines, limit));
          setSources(page.sources);
          setLastSeq(page.last_seq);
          setError(null);
        },
        (failure: unknown) => {
          if (!cancelled) setError(failure);
        },
      );
    }, TAIL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tail, visible, loading, session, fetchPage, lastSeq, limit]);

  // Follow the newest line while the reader is at the bottom; leave them where they are
  // when they scrolled up to read.
  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [lines]);

  const hermesProfiles = sources
    .filter((entry) => entry.source === 'hermes' && entry.profile)
    .map((entry) => entry.profile!);
  const where = (line: LogLine) =>
    line.source === 'hub'
      ? t('logview.hub')
      : line.profile === 'tui'
        ? t('logview.tui')
        : t('logview.hermes_of', { profile: line.profile ?? 'default' });

  const download = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    saveText(logText(lines), `${PRODUCT.id}-logs-${stamp}.log`);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="logs-tool">
      <p className="text-xs text-muted">{t('logview.kept')}</p>
      <div className="ch-logs-controls">
        <Segmented
          size="sm"
          label={t('logview.source')}
          value={source}
          onChange={(value) => setSource(value as Source)}
          options={(['all', 'hub', 'hermes', 'errors'] as const).map((value) => ({
            value,
            label: t(`logview.source_${value}`),
            itemProps: { 'data-testid': `logs-source-${value}` },
          }))}
        />
        {source === 'hermes' && (
          <Select
            label={t('logview.profile')}
            placeholder={t('logview.all_profiles')}
            value={profile}
            onValueChange={setProfile}
            options={hermesProfiles.map((name) => ({
              value: name,
              label: name === 'tui' ? t('logview.tui') : name,
            }))}
            testId="logs-profile"
          />
        )}
        {source !== 'errors' && (
          <Select
            label={t('logview.level')}
            value={level}
            onValueChange={(value) => setLevel((value as Level | null) ?? 'debug')}
            options={(['debug', 'info', 'warn', 'error'] as const).map((value) => ({
              value,
              label: t(`logview.level_${value}`),
            }))}
            testId="logs-level"
          />
        )}
        <Input
          inputSize="sm"
          type="search"
          dir="auto"
          icon={<IconSearch size={14} />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('logview.search')}
          aria-label={t('logview.search')}
          data-testid="logs-search"
        />
      </div>
      <div className="ch-logs-controls">
        <Segmented
          size="sm"
          label={t('logview.lines')}
          value={String(limit)}
          onChange={(value) => setLimit(Number(value))}
          options={LIMITS.map((count) => ({
            value: String(count),
            label: t('logview.last_n', { count }),
            itemProps: { 'data-testid': `logs-limit-${count}` },
          }))}
        />
        <Switch
          checked={tail}
          onChange={setTail}
          label={t('logview.tail')}
          testId="logs-tail"
          {...(tail && !visible ? { hint: t('logview.tail_paused') } : {})}
        />
        <Button
          size="sm"
          onClick={download}
          disabled={lines.length === 0}
          data-testid="logs-download"
        >
          <IconDownload size={14} />
          {t('logview.download')}
        </Button>
      </div>

      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      {loading ? (
        <Spinner label={t('common.loading')} />
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted" data-testid="logs-empty">
          {q ? t('logview.no_match') : t('logview.empty')}
        </p>
      ) : (
        <ol
          ref={listRef}
          className="ch-logs-list"
          data-testid="logs-lines"
          aria-live="off"
          onScroll={(event) => {
            const list = event.currentTarget;
            stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
          }}
        >
          {lines.map((line) => (
            <li key={line.seq} className="ch-logs-line" data-level={line.level}>
              <time className="ch-logs-time" dateTime={line.at}>
                {line.at.slice(11, 19)}
              </time>
              <Badge
                tone={
                  line.level === 'error'
                    ? 'danger'
                    : line.level === 'warn'
                      ? 'warning'
                      : line.level === 'info'
                        ? 'info'
                        : 'neutral'
                }
              >
                {t(`logview.level_short_${line.level}`)}
              </Badge>
              <span className="ch-logs-where">{where(line)}</span>
              <span className="ch-logs-message" dir="auto">
                {line.message}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted" data-testid="logs-count">
        {t('logview.showing', { count: lines.length })}
      </p>
    </div>
  );
}
