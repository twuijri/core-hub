/**
 * The pending-actions bar: one quiet button at the top of every screen that says how many
 * things are waiting for the person — approvals, agents' questions, workflow steps, and for
 * an admin the senders waiting to pair with a channel and the memory and skill writes the
 * agent staged for review (§102) — and opens them as a sheet. An
 * approval or a question is answered right there (the transcript's own card), and so is a
 * sender waiting to pair (Approve / Deny, the Channels page's own buttons); every item also
 * opens where it lives. The sheet is also the way into the global agent (NAVIGATION §4).
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ProfileScope } from '../auth/context.js';
import { PairingDecision } from '../agents/PairingDecision.js';
import { usePendingAnswer } from '../agents/PendingWritesCard.js';
import { describeError } from '../auth/client.js';
import { useApprovePairing, useDenyPairing } from '../agents/skills.js';
import { describeToolError } from '../agents/toolErrors.js';
import { ApprovalCard } from '../chat/ApprovalCard.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { pendingHref, type PendingItem } from '../pending/pending.js';
import { usePendingActions } from '../pending/queries.js';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Notice,
  Sheet,
  Tooltip,
} from '../ui/index.js';
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
          // On a phone an empty tray steps aside for the title; it returns with its count
          // (docs/design/family.md, "Phone adaptations").
          className={`btn btn-ghost relative px-1.5 ${count === 0 ? 'max-sm:hidden' : ''}`}
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
      {item.kind === 'approval' && item.approval.room_id && (
        <Badge tone="info">{t('pending.room_item')}</Badge>
      )}
      <span className="flex-1" />
      {link}
    </div>
  );
  if (item.kind === 'pairing') return <PairingRow item={item} meta={meta} />;
  if (item.kind === 'write') return <WriteRow item={item} meta={meta} />;
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

/**
 * A memory or skill write the agent staged for review (§58, counted here since §102): what it
 * would change, approved or rejected right here with the settings page's own answers.
 */
function WriteRow({
  item,
  meta,
}: {
  item: Extract<PendingItem, { kind: 'write' }>;
  meta: ReactNode;
}) {
  const { t } = useI18n();
  const answer = usePendingAnswer(item.agentId);
  const { write } = item;
  const busy = answer.isPending && answer.variables?.write.id === write.id;
  return (
    <Card padding="sm" testId="pending-item" data-kind="write">
      {meta}
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone={write.kind === 'memory' ? 'info' : 'accent'}>
          {write.kind === 'memory'
            ? write.target === 'user'
              ? t('agents.pending.kind_user')
              : t('agents.pending.kind_memory')
            : t('agents.pending.kind_skill')}
        </Badge>
        <span className="text-xs text-muted">{t('pending.write_hint')}</span>
      </div>
      <p className="text-sm font-medium" dir="auto">
        {write.name ? `${write.name} — ` : ''}
        {write.summary || write.action}
      </p>
      {write.content && (
        <pre
          className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs"
          dir="auto"
        >
          {write.content}
        </pre>
      )}
      {answer.isError && <Notice tone="danger">{describeError(answer.error, t)}</Notice>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={answer.isPending}
          loading={busy && answer.variables?.answer === 'approve'}
          onClick={() => answer.mutate({ write, answer: 'approve' })}
          data-testid="pending-write-approve"
        >
          {t('agents.pending.approve')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={answer.isPending}
          loading={busy && answer.variables?.answer === 'reject'}
          onClick={() => answer.mutate({ write, answer: 'reject' })}
          data-testid="pending-write-reject"
        >
          {t('agents.pending.reject')}
        </Button>
      </div>
    </Card>
  );
}

/** A sender waiting to pair: approved or denied right here, in the profile it waits in. */
function PairingRow({
  item,
  meta,
}: {
  item: Extract<PendingItem, { kind: 'pairing' }>;
  meta: ReactNode;
}) {
  const { t } = useI18n();
  const approve = useApprovePairing(item.agentId);
  const deny = useDenyPairing(item.agentId);
  const failed = approve.error ?? deny.error;
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
      {failed && <Notice tone="danger">{describeToolError(failed, t)}</Notice>}
      <div className="mt-2 flex flex-wrap gap-2">
        <PairingDecision
          request={item.request}
          busy={approve.isPending || deny.isPending}
          onApprove={() => approve.mutate(item.request)}
          onDeny={() => deny.mutate(item.request)}
        />
      </div>
    </Card>
  );
}
