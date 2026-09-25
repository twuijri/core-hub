/**
 * Notifications: what happened while you were not looking, and what you want to be told.
 *
 * Two sections rather than two tabs, because they answer one question between them —
 * "what reached me, and what should" — and a tab would hide the second half from anybody
 * who came here to turn something off.
 *
 * **An empty inbox stays empty.** Nothing here invents a welcome notice; a hub where
 * nothing has happened says so, which is also how you can tell the wiring works.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Segmented,
  Separator,
  Skeleton,
  SkeletonGroup,
  Switch,
} from '../ui/index.js';
import { IconAlert, IconCheck } from '../ui/icons.js';
import { BrowserPushSection } from './BrowserPushSection.js';
import {
  NOTICE_KINDS,
  useMarkAllRead,
  useMarkNotice,
  useNotices,
  useNotifyPreferences,
  useSaveNotifyPreferences,
  type Notice as NoticeRow,
  type NotifyPreferences,
} from './queries.js';

export function NotificationsTab() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <Inbox />
      <Separator />
      <Preferences />
      <p className="text-xs text-muted">{t('notify.push_note')}</p>
      <Separator />
      <BrowserPushSection />
    </div>
  );
}

// --------------------------------------------------------------------- inbox

function Inbox() {
  const { t, language } = useI18n();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notices = useNotices(unreadOnly);
  const markAll = useMarkAllRead();

  const unread = notices.data?.unread_count ?? 0;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="inbox-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="inbox-heading" className="text-sm font-semibold">
          {t('notify.inbox')}
        </h3>
        {unread > 0 && <Badge tone="accent">{String(unread)}</Badge>}
        <div className="ms-auto flex items-center gap-2">
          <Segmented
            size="sm"
            label={t('notify.filter')}
            value={unreadOnly ? 'unread' : 'all'}
            onChange={(value) => setUnreadOnly(value === 'unread')}
            options={[
              { value: 'all', label: t('notify.all') },
              { value: 'unread', label: t('notify.unread') },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
            data-testid="mark-all-read"
          >
            {t('notify.mark_all')}
          </Button>
        </div>
      </div>
      {notices.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="3rem" radius="md" />
          <Skeleton height="3rem" radius="md" />
        </SkeletonGroup>
      )}
      {notices.isError && <Notice tone="danger">{describeError(notices.error, t)}</Notice>}
      {notices.data &&
        (notices.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<IconCheck size={20} />}
            title={t(unreadOnly ? 'notify.none_unread' : 'notify.none')}
            body={t('notify.none_body')}
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="notice-list">
            {notices.data.items.map((notice) => (
              <NoticeRowItem key={notice.id} notice={notice} language={language} />
            ))}
          </ul>
        ))}
    </section>
  );
}

/**
 * Where a notice leads. One that points at a conversation opens it; one that points nowhere
 * is a record, and clicking it only marks it read. The desktop app's OS notifications open
 * the same place (`desktop/effects.ts`).
 */
export function noticeTarget(notice: {
  resource: { kind: string; id: string } | null;
  profile?: string | null;
}): string | null {
  if (notice.resource?.kind === 'session')
    return routeOf('chat').replace(/:sessionId\??/, notice.resource.id);
  // A workflow waiting for a person opens its run, where it is answered.
  if (notice.resource?.kind === 'workflow_run')
    return `${routeOf('schedules')}?${new URLSearchParams({
      workflow_run: notice.resource.id,
      ...(notice.profile ? { profile: notice.profile } : {}),
    }).toString()}`;
  return null;
}

function NoticeRowItem({ notice, language }: { notice: NoticeRow; language: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const mark = useMarkNotice();
  const unread = notice.read_at === null;
  const target = noticeTarget(notice);

  return (
    <li>
      <button
        type="button"
        className="notice-row"
        data-unread={unread || undefined}
        onClick={() => {
          if (unread) mark.mutate({ id: notice.id, read: true });
          if (target) navigate(target);
        }}
      >
        <span className="notice-dot" aria-hidden={!unread}>
          {unread ? <span className="notice-dot-on" /> : null}
        </span>
        <span className="notice-text">
          <span className="notice-title" dir="auto">
            {notice.title}
          </span>
          {notice.body && (
            <span className="notice-body" dir="auto">
              {notice.body}
            </span>
          )}
        </span>
        <time className="notice-time" dateTime={notice.created_at}>
          {new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          }).format(new Date(notice.created_at))}
        </time>
        <span className="sr-only">{t(unread ? 'notify.is_unread' : 'notify.is_read')}</span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- preferences

const DEFAULT_QUIET = { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' };

function Preferences() {
  const { t } = useI18n();
  const preferences = useNotifyPreferences();
  const save = useSaveNotifyPreferences();

  if (preferences.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="10rem" radius="md" />
      </SkeletonGroup>
    );
  if (preferences.isError)
    return <Notice tone="danger">{describeError(preferences.error, t)}</Notice>;

  const current: NotifyPreferences = preferences.data ?? {
    events: {},
    quiet_hours: DEFAULT_QUIET,
  };
  const quiet = current.quiet_hours ?? DEFAULT_QUIET;
  const write = (next: NotifyPreferences) => save.mutate(next);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="notify-prefs-heading">
      <h3 id="notify-prefs-heading" className="text-sm font-semibold">
        {t('notify.what_reaches_me')}
      </h3>
      <div className="flex flex-col gap-1">
        {NOTICE_KINDS.map((kind) => {
          // A kind with no row was never turned off, so it is on.
          const on = current.events[kind]?.in_app ?? true;
          const push = current.events[kind]?.push ?? true;
          const set = (channels: { in_app: boolean; push: boolean }) =>
            write({
              ...current,
              quiet_hours: quiet,
              events: { ...current.events, [kind]: channels },
            });
          return (
            <div key={kind} className="flex flex-wrap items-center justify-between gap-x-4">
              <Switch
                checked={on}
                label={t(`notify.kind.${kind}`)}
                testId={`notify-kind-${kind}`}
                onChange={(next) => set({ in_app: next, push })}
              />
              {/* Push mirrors the inbox: a kind that is not written is not pushed either. */}
              <Switch
                checked={on && push}
                disabled={!on}
                label={t('notify.push_switch')}
                testId={`notify-push-${kind}`}
                onChange={(next) => set({ in_app: on, push: next })}
              />
            </div>
          );
        })}
      </div>
      <Switch
        checked={quiet.enabled}
        label={t('notify.quiet')}
        hint={t('notify.quiet_hint')}
        testId="notify-quiet"
        onChange={(next) => write({ ...current, quiet_hours: { ...quiet, enabled: next } })}
      />
      {quiet.enabled && (
        <div className="flex flex-wrap items-end gap-3" data-testid="quiet-window">
          <Field label={t('notify.quiet_from')}>
            {(props) => (
              <Input
                {...props}
                type="time"
                inputSize="sm"
                value={quiet.from}
                onChange={(event) =>
                  write({ ...current, quiet_hours: { ...quiet, from: event.target.value } })
                }
              />
            )}
          </Field>
          <Field label={t('notify.quiet_to')}>
            {(props) => (
              <Input
                {...props}
                type="time"
                inputSize="sm"
                value={quiet.to}
                onChange={(event) =>
                  write({ ...current, quiet_hours: { ...quiet, to: event.target.value } })
                }
              />
            )}
          </Field>
          <p className="text-xs text-muted" dir="ltr">
            {quiet.timezone}
          </p>
        </div>
      )}
      {save.isError && (
        <Notice tone="danger">
          <IconAlert size={16} /> {describeError(save.error, t)}
        </Notice>
      )}
    </section>
  );
}
