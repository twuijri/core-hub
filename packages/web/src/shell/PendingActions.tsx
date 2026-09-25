/**
 * The pending-actions bar: one quiet button at the top of every screen that says how many
 * things are waiting for the person — approvals, agents' questions, workflow steps, and for
 * an admin the senders waiting to pair with a channel — and opens them as a sheet. An
 * approval or a question is answered right there (the transcript's own card); every item
 * also opens where it lives. The sheet is also the way into the global agent (NAVIGATION §4).
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { ProfileScope } from '../auth/context.js';
import { ApprovalCard } from '../chat/ApprovalCard.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { pendingHref, type PendingItem } from '../pending/pending.js';
import { usePendingActions } from '../pending/queries.js';
import { Badge, buttonClass, Card, EmptyState, Sheet, Tooltip } from '../ui/index.js';
import { IconInbox, IconSpark } from '../ui/icons.js';
import { ProfileBadge } from './ProfileBadge.js';
import { useManyProfiles, useProfileInLink } from './profiles.js';

export function PendingActions() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pending = usePendingActions();
  const inLink = useProfileInLink();
  const count = pending.items.length;
  const label = count > 0 ? t('pending.open_count', { count: String(count) }) : t('pending.open');

  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          className="btn btn-ghost relative px-1.5"
          onClick={() => setOpen(true)}
          aria-label={label}
          data-testid="pending-actions"
          data-count={count}
        >
          <IconInbox />
          {count > 0 && (
            <span className="ch-pending-count" data-testid="pending-actions-count" aria-hidden>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </Tooltip>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('pending.title')}
        closeLabel={t('pending.close')}
        testId="pending-actions-sheet"
        footer={
          <Link
            to={routeOf('global_agent')}
            className={buttonClass('secondary', 'md')}
            onClick={() => setOpen(false)}
            data-testid="pending-global-agent"
          >
            <IconSpark size={16} />
            <span className="ch-btn-label">{t('pending.global_agent')}</span>
          </Link>
        }
      >
        {count === 0 ? (
          <EmptyState
            icon={<IconInbox size={20} />}
            title={t('pending.none')}
            body={t('pending.none_body')}
            testId="pending-actions-none"
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.items.map((item) => (
              <li key={item.key}>
                <PendingRow
                  item={item}
                  href={pendingHref(item, inLink, pending.globalAgentOf)}
                  onFollow={() => setOpen(false)}
                />
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  );
}

function PendingRow({
  item,
  href,
  onFollow,
}: {
  item: PendingItem;
  href: string | null;
  onFollow: () => void;
}) {
  const { t } = useI18n();
  const many = useManyProfiles();
  const link = href && (
    <Link
      to={href}
      className="link text-sm underline"
      onClick={onFollow}
      data-testid="pending-item-open"
    >
      {t('pending.open_item')}
    </Link>
  );
  const meta = (
    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
      {many && <ProfileBadge profile={item.profile} />}
      {item.kind === 'approval' && item.approval.workflow_run_id && (
        <Badge tone="info">{t('pending.workflow_step')}</Badge>
      )}
      <span className="flex-1" />
      {link}
    </div>
  );
  if (item.kind === 'pairing') {
    return (
      <Card padding="sm" testId="pending-item" data-kind="pairing">
        {meta}
        <p className="text-sm font-medium" dir="auto">
          {t('pending.pairing', {
            name: item.request.user_name ?? item.request.user_id,
            platform: item.request.platform,
          })}
        </p>
        <p className="text-xs text-muted">{t('pending.pairing_hint')}</p>
      </Card>
    );
  }
  return (
    <div
      data-testid="pending-item"
      data-kind={item.approval.kind}
      data-session-id={item.approval.session_id ?? ''}
    >
      {meta}
      {/* Answered in the profile it waits in, whichever one the top selector shows. */}
      <ProfileScope profile={item.profile}>
        <ApprovalCard approval={item.approval} />
      </ProfileScope>
    </div>
  );
}
