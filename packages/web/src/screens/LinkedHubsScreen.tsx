/**
 * «المراكز المرتبطة» / "Linked hubs" (ADR 0026): other Core Hubs linked to this one.
 *
 * What a link allows is said on the page, because it is the whole point: the two hubs see the
 * names of the agents the other shares, and a person here can ask one of them a single question
 * — answered by that agent's model, without tools, files or memory. Nothing else crosses.
 *
 * Linking takes both owners: one makes an invite (single use, 10 minutes), the other pastes it
 * under "Use an invite", and the first approves. Each side shows the other's key fingerprint to
 * compare by eye. Per hub: approve, rename, switch off, limit its questions, read its log,
 * unlink. Below: which of this hub's agents linked hubs may ask — none until switched on.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { intlLocale, type Translator } from '../i18n/index.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  Switch,
  Textarea,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import { IconCopy, IconGlobe } from '../ui/icons.js';
import {
  describePeerError,
  useAskPeerAgent,
  useCreatePeerInvite,
  useDeletePeer,
  usePeerAgents,
  usePeerEvents,
  usePeerShares,
  usePeers,
  useRequestPeer,
  useSetPeerShare,
  useUpdatePeer,
  type Peer,
  type PeerInvite,
} from '../devices/peers.js';

export function LinkedHubsScreen() {
  const { t } = useI18n();
  const title = t(termKey('linked_hubs'));
  const peers = usePeers();

  return (
    <AppShell title={title}>
      <h1 className="mb-1 text-xl font-semibold">{title}</h1>
      <p className="mb-4 max-w-prose text-sm text-muted" data-testid="linked-hubs-intro">
        {t('linked_hubs.intro')}
      </p>
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 md:grid-cols-2">
          <InviteCard />
          <RedeemCard />
        </div>
        <section className="flex flex-col gap-3" aria-labelledby="peers-heading">
          <h2 id="peers-heading" className="text-base font-semibold">
            {t('linked_hubs.peers_heading')}
          </h2>
          {peers.isPending && <Spinner label={t('common.loading')} />}
          {peers.isError && <Notice tone="danger">{describePeerError(peers.error, t)}</Notice>}
          {peers.data && peers.data.length === 0 && (
            <EmptyState icon={<IconGlobe size={20} />} title={t('linked_hubs.none')} />
          )}
          {peers.data?.map((peer) => (
            <PeerCard key={peer.id} peer={peer} />
          ))}
        </section>
        <SharesCard />
      </div>
    </AppShell>
  );
}

function InviteCard() {
  const { t, language } = useI18n();
  const create = useCreatePeerInvite();
  const [invite, setInvite] = useState<PeerInvite | null>(null);
  return (
    <Card testId="peer-invite">
      <CardHeader title={t('linked_hubs.invite_title')} subtitle={t('linked_hubs.invite_hint')} />
      <div className="flex flex-col items-start gap-3">
        <Button
          variant="primary"
          loading={create.isPending}
          data-testid="peer-invite-create"
          onClick={() => create.mutate(undefined, { onSuccess: setInvite })}
        >
          {invite ? t('linked_hubs.invite_again') : t('linked_hubs.invite_create')}
        </Button>
        {create.isError && <Notice tone="danger">{describePeerError(create.error, t)}</Notice>}
        {invite && (
          <div className="flex w-full flex-col gap-2" data-testid="peer-invite-result">
            <div className="flex w-full items-center gap-2">
              <code dir="ltr" className="min-w-0 flex-1 break-all rounded bg-surface-2 p-2 text-xs">
                {invite.url}
              </code>
              <Button
                iconOnly
                aria-label={t('linked_hubs.copy')}
                icon={<IconCopy size={16} />}
                onClick={() => void navigator.clipboard?.writeText(invite.url)}
              />
            </div>
            <p className="text-xs text-muted">
              {t('linked_hubs.invite_expires', {
                time: new Date(invite.expires_at).toLocaleTimeString(intlLocale(language)),
              })}
            </p>
            <Fingerprint value={invite.fingerprint} label={t('linked_hubs.own_fingerprint')} />
          </div>
        )}
      </div>
    </Card>
  );
}

function RedeemCard() {
  const { t } = useI18n();
  const request = useRequestPeer();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  return (
    <Card testId="peer-redeem">
      <CardHeader title={t('linked_hubs.redeem_title')} subtitle={t('linked_hubs.redeem_hint')} />
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!url.trim()) return;
          request.mutate(
            { url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) },
            {
              onSuccess: () => {
                setUrl('');
                setName('');
              },
            },
          );
        }}
      >
        <Field label={t('linked_hubs.redeem_url')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={url}
              placeholder="https://…/peer-invite/…"
              data-testid="peer-redeem-url"
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('linked_hubs.redeem_name')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              value={name}
              data-testid="peer-redeem-name"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={request.isPending}
            disabled={!url.trim()}
            data-testid="peer-redeem-submit"
          >
            {t('linked_hubs.redeem_submit')}
          </Button>
        </div>
        {request.isError && <Notice tone="danger">{describePeerError(request.error, t)}</Notice>}
        {request.isSuccess && <Notice tone="success">{t('linked_hubs.redeem_sent')}</Notice>}
      </form>
    </Card>
  );
}

function Fingerprint({ value, label }: { value: string; label: string }) {
  return (
    <p className="text-xs text-muted">
      {label}:{' '}
      <code dir="ltr" data-testid="fingerprint">
        {value}
      </code>
    </p>
  );
}

const STATUS_TONE = { linked: 'success', pending: 'warning', waiting: 'info' } as const;

function PeerCard({ peer }: { peer: Peer }) {
  const { t } = useI18n();
  const update = useUpdatePeer();
  const remove = useDeletePeer();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [open, setOpen] = useState<'agents' | 'log' | null>(null);
  const [limit, setLimit] = useState(String(peer.asks_per_hour));
  const usable = peer.enabled && peer.status !== 'pending';

  const saveLimit = () => {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      setLimit(String(peer.asks_per_hour));
      return;
    }
    if (value !== peer.asks_per_hour)
      update.mutate({ id: peer.id, patch: { asks_per_hour: value } });
  };

  return (
    <Card testId={`peer-${peer.id}`} data-status={peer.status}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span dir="auto">{peer.name}</span>
            <Badge tone={STATUS_TONE[peer.status]} testId="peer-status">
              {t(`linked_hubs.status.${peer.status}`)}
            </Badge>
            {!peer.enabled && <Badge tone="neutral">{t('linked_hubs.off')}</Badge>}
          </span>
        }
        subtitle={
          <span dir="ltr" className="break-all">
            {peer.url}
          </span>
        }
        actions={
          <Switch
            checked={peer.enabled}
            label={t('linked_hubs.enabled')}
            labelHidden
            testId="peer-enabled"
            disabled={update.isPending}
            onChange={(next) => update.mutate({ id: peer.id, patch: { enabled: next } })}
          />
        }
      />
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          {t(`linked_hubs.direction.${peer.direction}`)}
          {peer.status === 'pending' && ` ${t('linked_hubs.pending_hint')}`}
        </p>
        <Fingerprint value={peer.fingerprint} label={t('linked_hubs.their_fingerprint')} />
        <div className="flex flex-wrap items-end gap-2">
          {peer.status === 'pending' && (
            <Button
              variant="primary"
              data-testid="peer-approve"
              loading={update.isPending}
              onClick={() => update.mutate({ id: peer.id, patch: { approve: true } })}
            >
              {t('linked_hubs.approve')}
            </Button>
          )}
          <Field label={t('linked_hubs.asks_per_hour')} className="w-40">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={1000}
                inputSize="sm"
                value={limit}
                data-testid="peer-limit"
                onChange={(event) => setLimit(event.target.value)}
                onBlur={saveLimit}
              />
            )}
          </Field>
          <Button
            onClick={async () => {
              const next = await prompt.ask({
                title: t('linked_hubs.rename_title'),
                label: t('linked_hubs.rename_label'),
                initialValue: peer.name,
              });
              if (next?.trim()) update.mutate({ id: peer.id, patch: { name: next.trim() } });
            }}
          >
            {t('linked_hubs.rename')}
          </Button>
          <Button
            disabled={!usable}
            data-testid="peer-open-agents"
            onClick={() => setOpen(open === 'agents' ? null : 'agents')}
          >
            {t('linked_hubs.their_agents')}
          </Button>
          <Button
            data-testid="peer-open-log"
            onClick={() => setOpen(open === 'log' ? null : 'log')}
          >
            {t('linked_hubs.log')}
          </Button>
          <Button
            variant="danger"
            data-testid="peer-delete"
            onClick={async () => {
              const yes = await confirm.ask({
                title: t('linked_hubs.unlink_title', { name: peer.name }),
                body: t('linked_hubs.unlink_body'),
                confirmLabel: t('linked_hubs.unlink'),
              });
              if (yes) remove.mutate(peer.id);
            }}
          >
            {peer.status === 'pending' ? t('linked_hubs.refuse') : t('linked_hubs.unlink')}
          </Button>
        </div>
        {update.isError && <Notice tone="danger">{describePeerError(update.error, t)}</Notice>}
        {remove.isError && <Notice tone="danger">{describePeerError(remove.error, t)}</Notice>}
        {open === 'agents' && <PeerAgentsPanel peer={peer} />}
        {open === 'log' && <PeerLog peer={peer} />}
      </div>
      {confirm.dialog}
      {prompt.dialog}
    </Card>
  );
}

function PeerAgentsPanel({ peer }: { peer: Peer }) {
  const { t } = useI18n();
  const agents = usePeerAgents(peer.id, true);
  const ask = useAskPeerAgent();
  const [chosen, setChosen] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const shareId = chosen ?? agents.data?.[0]?.id ?? null;

  if (agents.isPending) return <Spinner label={t('common.loading')} />;
  if (agents.isError) return <Notice tone="danger">{describePeerError(agents.error, t)}</Notice>;
  if (!agents.data || agents.data.length === 0) {
    return <p className="text-sm text-muted">{t('linked_hubs.their_agents_none')}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="peer-agents">
      <ul className="flex flex-col gap-1 text-sm">
        {agents.data.map((agent) => (
          <li key={agent.id} data-testid="peer-agent">
            <span className="font-medium" dir="auto">
              {agent.name}
            </span>
            {agent.description && (
              <span className="text-muted" dir="auto">
                {' '}
                — {agent.description}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t('linked_hubs.ask_hint')}</p>
      <Select
        value={shareId}
        onValueChange={setChosen}
        label={t('linked_hubs.ask_agent')}
        options={agents.data.map((agent) => ({ value: agent.id, label: agent.name }))}
        testId="peer-ask-agent"
      />
      <Textarea
        dir="auto"
        value={question}
        aria-label={t('linked_hubs.ask_question')}
        placeholder={t('linked_hubs.ask_question')}
        data-testid="peer-ask-question"
        onChange={(event) => setQuestion(event.target.value)}
      />
      <div>
        <Button
          variant="primary"
          loading={ask.isPending}
          disabled={!shareId || !question.trim()}
          data-testid="peer-ask-send"
          onClick={() =>
            shareId && ask.mutate({ peerId: peer.id, shareId, prompt: question.trim() })
          }
        >
          {t('linked_hubs.ask_send')}
        </Button>
      </div>
      {ask.isError && <Notice tone="danger">{describePeerError(ask.error, t)}</Notice>}
      {ask.data && (
        <div
          className="whitespace-pre-wrap rounded bg-surface-2 p-3 text-sm"
          dir="auto"
          data-testid="peer-ask-answer"
        >
          {ask.data.answer}
        </div>
      )}
    </div>
  );
}

function eventText(t: Translator, kind: string): string {
  return t(`linked_hubs.event.${kind}`);
}

function PeerLog({ peer }: { peer: Peer }) {
  const { t, language } = useI18n();
  const events = usePeerEvents(peer.id, true);
  if (events.isPending) return <Spinner label={t('common.loading')} />;
  if (events.isError) return <Notice tone="danger">{describePeerError(events.error, t)}</Notice>;
  return (
    <ul className="flex flex-col gap-1 text-xs" data-testid="peer-log">
      {events.data.map((event) => (
        <li key={event.id} data-testid="peer-log-line" data-ok={String(event.ok)}>
          <span className="text-muted">{new Date(event.created_at).toLocaleString(intlLocale(language))}</span>{' '}
          {eventText(t, event.kind)}
          {event.detail && (
            <span className="text-muted" dir="auto">
              {' '}
              ({event.detail})
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SharesCard() {
  const { t } = useI18n();
  const shares = usePeerShares();
  const set = useSetPeerShare();
  return (
    <Card testId="peer-shares">
      <CardHeader title={t('linked_hubs.shares_title')} subtitle={t('linked_hubs.shares_hint')} />
      {shares.isPending && <Spinner label={t('common.loading')} />}
      {shares.isError && <Notice tone="danger">{describePeerError(shares.error, t)}</Notice>}
      {set.isError && <Notice tone="danger">{describePeerError(set.error, t)}</Notice>}
      <ul className="flex flex-col divide-y divide-line">
        {shares.data?.map((share) => (
          <li
            key={`${share.profile}:${share.agent_id}`}
            className="flex items-center justify-between gap-3 py-2"
          >
            <span className="text-sm">
              <span dir="auto">{share.name}</span>{' '}
              <span className="text-muted" dir="auto">
                · {share.profile}
              </span>
            </span>
            <Switch
              checked={share.shared}
              label={t('linked_hubs.share_label', { name: share.name, profile: share.profile })}
              labelHidden
              testId={`peer-share-${share.profile}-${share.agent_id}`}
              disabled={set.isPending}
              onChange={(next) =>
                set.mutate({ profile: share.profile, agent_id: share.agent_id, shared: next })
              }
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
