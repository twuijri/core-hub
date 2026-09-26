/**
 * The Background button (contract decision §56; owner, 2026-09-25): beside the pending-actions
 * bar, how many things are working for the person right now — chats, tasks, schedules and
 * workflows, jobs, subagents, in every profile they may enter — opening a sheet that lists
 * them with where each lives and Stop where it can be stopped, and what finished in the last
 * day under "Finished (n)".
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { describeError } from '../auth/client.js';
import { backgroundHref, runningCount } from '../background/background.js';
import { useBackground } from '../background/queries.js';
import { useI18n } from '../i18n/context.js';
import { clock, elapsedMs } from '../subagents/subagents.js';
import type { BackgroundItem } from '../types.js';
import { Badge, Button, EmptyState, Notice, Sheet, Tooltip } from '../ui/index.js';
import { IconActivity, IconChevron, IconStop } from '../ui/icons.js';
import { ProfileBadge } from './ProfileBadge.js';
import { useManyProfiles, useProfileInLink } from './profiles.js';

const STATUS_TONE = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
} as const;

export function BackgroundTasks() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const { query, stop } = useBackground();
  const inLink = useProfileInLink();
  const running = query.data?.running ?? [];
  const finished = query.data?.finished ?? [];
  const count = runningCount(query.data);
  const label =
    count > 0 ? t('background.open_count', { count: String(count) }) : t('background.open');

  // Running rows count their time while the sheet is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || running.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, running.length]);

  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          // On a phone an empty tray steps aside for the title; it returns with its count
          // (docs/design/family.md, "Phone adaptations").
          className={`btn btn-ghost relative px-1.5 ${count === 0 ? 'max-sm:hidden' : ''}`}
          onClick={() => setOpen(true)}
          aria-label={label}
          data-testid="background-tasks"
          data-count={count}
        >
          <IconActivity />
          {count > 0 && (
            <span className="ch-pending-count" data-testid="background-count" aria-hidden>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </Tooltip>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('background.title')}
        closeLabel={t('background.close')}
        testId="background-sheet"
      >
        {stop.isError && (
          <Notice tone="danger" className="mb-3" role="alert">
            {describeError(stop.error, t)}
          </Notice>
        )}
        {query.isError && (
          <Notice tone="danger" className="mb-3" role="alert">
            {describeError(query.error, t)}
          </Notice>
        )}
        {running.length === 0 ? (
          <EmptyState
            icon={<IconActivity size={20} />}
            title={t('background.none')}
            body={t('background.none_body')}
            testId="background-none"
          />
        ) : (
          <ul className="background-list" data-testid="background-running">
            {running.map((item) => (
              <BackgroundRow
                key={item.id}
                item={item}
                now={now}
                href={backgroundHref(item, inLink)}
                stopping={stop.isPending && stop.variables?.id === item.id}
                onStop={() => stop.mutate(item)}
                onFollow={() => setOpen(false)}
              />
            ))}
          </ul>
        )}
        {finished.length > 0 && (
          <div className="background-finished">
            <button
              type="button"
              className="subagents-finished-toggle"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((value) => !value)}
              data-testid="background-finished-toggle"
            >
              <IconChevron size={12} className="subagents-chevron" data-open={showFinished} />
              {t('background.finished', { count: String(finished.length) })}
            </button>
            {showFinished && (
              <ul className="background-list" data-testid="background-finished">
                {finished.map((item) => (
                  <BackgroundRow
                    key={item.id}
                    item={item}
                    now={now}
                    href={backgroundHref(item, inLink)}
                    stopping={false}
                    onStop={() => undefined}
                    onFollow={() => setOpen(false)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

function BackgroundRow({
  item,
  now,
  href,
  stopping,
  onStop,
  onFollow,
}: {
  item: BackgroundItem;
  now: number;
  href: string | null;
  stopping: boolean;
  onStop(): void;
  onFollow(): void;
}) {
  const { t } = useI18n();
  const many = useManyProfiles();
  const ms = elapsedMs(item, now);
  const title =
    item.title.trim() ||
    (item.kind === 'job' && item.job_kind ? item.job_kind : t('sessions.untitled'));
  return (
    <li
      className="background-row"
      data-testid="background-item"
      data-kind={item.kind}
      data-status={item.status}
      data-item-id={item.id}
    >
      <div className="background-row-head">
        <Badge tone="neutral">{t(`background.kind.${item.kind}`)}</Badge>
        {many && <ProfileBadge profile={item.profile} />}
        <span className="flex-1" />
        <Badge tone={STATUS_TONE[item.status]} dot={item.status === 'running'}>
          {t(`background.status.${item.status}`)}
        </Badge>
      </div>
      <p className="background-row-title" dir="auto" data-testid="background-item-title">
        {title}
      </p>
      <div className="background-row-foot">
        {ms !== null && <span className="text-xs text-muted">{clock(ms)}</span>}
        <span className="flex-1" />
        {href && (
          <Link
            to={href}
            className="link text-sm underline"
            onClick={onFollow}
            data-testid="background-item-open"
          >
            {t('background.open_item')}
          </Link>
        )}
        {item.stoppable && (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconStop size={12} />}
            loading={stopping}
            onClick={onStop}
            data-testid="background-item-stop"
          >
            {t('background.stop')}
          </Button>
        )}
      </div>
    </li>
  );
}
