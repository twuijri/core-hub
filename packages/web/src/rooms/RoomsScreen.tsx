/**
 * The Rooms destination (`/rooms/:roomId?`): one room open — its transcript, its composer
 * and its members — or, with none open, the way to make or join one.
 *
 * In a room the person's own messages are on the right, as in a chat; everyone else — the
 * other people and the agents — on the left, each with a name, because in a room "the other
 * side" is several speakers (owner to confirm, DECISIONS §69). While a seat works the strip
 * above the composer says who, and what tool it is using; people typing are said there too.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { AgentFace, useAgentIdentities } from '../agents/identity.js';
import { Markdown } from '../chat/Markdown.js';
import { Attachments } from '../chat/MessageView.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import type { Message, RoomDetail, Seat } from '../types.js';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  Sheet,
  SkeletonText,
  Switch,
  Field,
  Input,
  Select,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import {
  IconStop,
  IconArchive,
  IconCopy,
  IconMore,
  IconPlus,
  IconSpark,
  IconTrash,
  IconUnarchive,
} from '../ui/icons.js';
import { RoomComposer } from './RoomComposer.js';
import { SeatDialog } from './SeatDialog.js';
import { useProjects } from '../tasks/queries.js';
import {
  useLinkProject,
  usePutMemory,
  useRefreshMemory,
  useClearContext,
  useContinueHandoff,
  useHandoffs,
  useStopSeat,
  useDeleteRoom,
  usePostMessage,
  useRemoveMember,
  useRemoveSeat,
  useRoom,
  useRoomStream,
  useRotateInvite,
  useUpdateRoom,
} from './queries.js';
import { textOf, type RoomTranscript } from './transcript.js';

export function RoomsScreen() {
  const { t } = useI18n();
  const { roomId } = useParams();
  if (!roomId) {
    return (
      <AppShell title={t('nav.rooms')}>
        <h1 className="text-xl font-semibold">{t('nav.rooms')}</h1>
        <div className="mt-4">
          <EmptyState
            icon={<IconSpark size={20} />}
            title={t('rooms.pick_title')}
            body={t('rooms.pick_body')}
            testId="rooms-pick"
          />
        </div>
      </AppShell>
    );
  }
  return <RoomView key={roomId} roomId={roomId} />;
}

function RoomView({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const room = useRoom(roomId);
  const stream = useRoomStream(roomId);
  const post = usePostMessage(roomId);
  const [membersOpen, setMembersOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const detail = room.data;
  const title = detail?.name ?? t('nav.rooms');

  const lastId = stream.state.messages.at(-1)?.id;
  const lastLength = textOf(stream.state.messages.at(-1) ?? { content: [] }).length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastId, lastLength]);

  if (stream.gone || (room.isError && !detail)) {
    return (
      <AppShell title={title}>
        <Notice tone="warning">
          {stream.gone === 'removed'
            ? t('rooms.removed')
            : stream.gone === 'deleted'
              ? t('rooms.deleted')
              : describeError(room.error, t)}{' '}
          <Link className="link underline" to={routeOf('rooms').split('/:')[0] ?? '/rooms'}>
            {t('rooms.back')}
          </Link>
        </Notice>
      </AppShell>
    );
  }

  const seats = detail?.seats ?? [];
  const lead = seats.find((seat) => seat.id === detail?.lead_seat_id) ?? null;
  const archived = !!detail?.archived_at;

  return (
    <AppShell title={title}>
      <div className="flex min-h-0 flex-1 gap-4" data-testid="room-screen" data-room-id={roomId}>
        <div className="chat-flow min-w-0" data-empty="false">
          <RoomHeader
            room={detail}
            onMembers={() => setMembersOpen(true)}
            onGone={() => navigate(routeOf('rooms').split('/:')[0] ?? '/rooms')}
          />
          {archived && (
            <Notice tone="info" className="mb-2">
              {t('rooms.archived_notice')}
            </Notice>
          )}
          <div className="chat-stream chat-turns" data-testid="room-transcript">
            {stream.status === 'loading' && <SkeletonText lines={3} label={t('common.loading')} />}
            {stream.status === 'error' && (
              <Notice tone="danger">{describeError(stream.error, t)}</Notice>
            )}
            {stream.state.hasMore && (
              <div className="chat-older">
                <Button variant="ghost" size="sm" onClick={() => void stream.loadOlder()}>
                  {t('rooms.older')}
                </Button>
              </div>
            )}
            {stream.status === 'ready' && stream.state.messages.length === 0 && (
              <p className="py-6 text-center text-sm text-muted" data-testid="room-empty">
                {seats.length === 0 ? t('rooms.empty_no_seats') : t('rooms.empty')}
              </p>
            )}
            {stream.state.messages.map((message, index) => (
              <RoomMessage
                key={message.id}
                message={message}
                grouped={sameSpeaker(stream.state.messages[index - 1], message)}
                seats={seats}
              />
            ))}
            <div ref={bottom} />
          </div>
          {detail && <HandoffBar room={detail} revision={stream.state.messages.length} />}
          <Activity state={stream.state} seats={seats} />
          <RoomComposer
            seats={seats.map((seat) => ({ id: seat.id, name: seat.name }))}
            allowAll={detail?.can_mention_all ?? false}
            leadName={lead?.name ?? null}
            disabledReason={archived ? t('rooms.archived_notice') : null}
            sending={post.isPending}
            onTyping={stream.typing}
            onSend={async (content, mentions) => {
              try {
                await post.mutateAsync({ content, mentions });
                return true;
              } catch {
                return false;
              }
            }}
          />
          {post.isError && <Notice tone="danger">{describeError(post.error, t)}</Notice>}
        </div>
        {detail && (
          <aside className="room-panel hidden lg:flex" aria-label={t('rooms.members.title')}>
            <MembersPanel room={detail} />
          </aside>
        )}
      </div>
      {detail && (
        <Sheet
          open={membersOpen}
          onOpenChange={setMembersOpen}
          title={t('rooms.members.title')}
          closeLabel={t('common.cancel')}
          testId="room-members-sheet"
        >
          <MembersPanel room={detail} />
        </Sheet>
      )}
    </AppShell>
  );
}

function sameSpeaker(previous: Message | undefined, message: Message): boolean {
  if (!previous || previous.role === 'system' || message.role === 'system') return false;
  return (
    previous.author.kind === message.author.kind &&
    previous.author.id === message.author.id &&
    previous.seat_id === message.seat_id
  );
}

function RoomMessage({
  message,
  grouped,
  seats,
}: {
  message: Message;
  grouped: boolean;
  seats: readonly Seat[];
}) {
  const { t } = useI18n();
  const { session } = useAuth();
  const identityOf = useAgentIdentities();
  const text = textOf(message);
  if (message.role === 'system') {
    return (
      <article className="msg-system" data-testid="room-message-system">
        <span dir="auto">{text}</span>
      </article>
    );
  }
  const mine = message.author.kind === 'user' && message.author.id === session?.user.id;
  const agent = message.author.kind === 'agent';
  // A seat's reply: the seat's own name, the face of the agent sitting in it
  // (agents/identity.tsx) — never the hub's placeholder «agent».
  const seat = agent ? seats.find((candidate) => candidate.id === message.seat_id) : undefined;
  const identity = agent
    ? identityOf(
        seat?.agent_id ?? message.author.id,
        seat?.name ?? message.author.name,
        t('chat.assistant'),
      )
    : null;
  const name = mine ? t('chat.you') : (identity?.name ?? message.author.name);
  const streaming = message.status === 'streaming';
  const handoffTo = message.handoff
    ? (seats.find((seat) => seat.id === message.handoff?.to_seat_id)?.name ?? null)
    : null;
  return (
    <article
      className="msg"
      data-side={mine ? 'user' : 'agent'}
      data-grouped={grouped ? 'true' : 'false'}
      data-testid={agent ? 'room-message-agent' : 'room-message-person'}
      data-status={message.status}
      data-seat-id={message.seat_id ?? undefined}
    >
      {!mine &&
        (grouped ? (
          <span className="msg-gutter" aria-hidden />
        ) : identity ? (
          <AgentFace identity={identity} size="sm" testId="room-agent-face" />
        ) : (
          <Avatar name={name} size="sm" tone="neutral" />
        ))}
      <div className="msg-stack">
        {!grouped && (
          <header className="msg-head">
            <span className="msg-name" dir="auto">
              {name}
            </span>
            {agent && <Badge>{t('rooms.agent_badge')}</Badge>}
            {streaming && <Badge tone="info">{t('chat.streaming')}</Badge>}
            {message.status === 'failed' && <Badge tone="danger">{t('chat.failed')}</Badge>}
            {message.status === 'interrupted' && (
              <Badge tone="warning">{t('chat.interrupted')}</Badge>
            )}
          </header>
        )}
        {mine ? (
          text ? (
            <div className="msg-bubble msg-user">
              <p dir="auto">{text}</p>
            </div>
          ) : null
        ) : agent ? (
          <div className="msg-agent-body">
            {text ? (
              <Markdown text={text} />
            ) : streaming ? (
              <span className="run-dots" aria-label={t('rooms.activity.working', { name })}>
                <span className="run-dot" />
                <span className="run-dot" />
                <span className="run-dot" />
              </span>
            ) : null}
          </div>
        ) : text ? (
          <div className="msg-bubble room-other">
            <p dir="auto">{text}</p>
          </div>
        ) : null}
        <Attachments message={message} />
        {handoffTo && (
          <p className="text-xs text-muted" data-testid="room-handoff-note">
            {t('rooms.handoff_to', { name: handoffTo })}
          </p>
        )}
      </div>
    </article>
  );
}

/** Who is working or typing, above the composer. */
function Activity({ state, seats }: { state: RoomTranscript; seats: readonly Seat[] }) {
  const { t } = useI18n();
  const busy = seats.filter((seat) => seat.status !== 'idle' && seat.status !== 'offline');
  const typing = Object.values(state.typing);
  const tool = Object.values(state.tools).find((name) => name);
  if (busy.length === 0 && typing.length === 0) return null;
  return (
    <div className="room-activity" role="status" data-testid="room-activity">
      {busy.map((seat) => (
        <span key={seat.id} className="run-status" data-testid="room-activity-seat">
          <span className="run-dots" aria-hidden>
            <span className="run-dot" />
            <span className="run-dot" />
            <span className="run-dot" />
          </span>
          <span className="run-status-word">
            {seat.status === 'queued'
              ? t('rooms.activity.queued', { name: seat.name })
              : seat.status === 'waiting_approval'
                ? t('rooms.activity.waiting', { name: seat.name })
                : seat.status === 'thinking'
                  ? t('rooms.activity.thinking', { name: seat.name })
                  : t('rooms.activity.working', { name: seat.name })}
          </span>
          {tool && busy.length === 1 && <span className="run-status-step">{tool}</span>}
        </span>
      ))}
      {typing.length > 0 && (
        <span className="text-xs text-muted" data-testid="room-typing">
          {t('rooms.activity.typing', { names: typing.join('، ') })}
        </span>
      )}
    </div>
  );
}

function RoomHeader({
  room,
  onMembers,
  onGone,
}: {
  room: RoomDetail | undefined;
  onMembers(): void;
  onGone(): void;
}) {
  const { t } = useI18n();
  const update = useUpdateRoom(room?.id ?? '');
  const remove = useDeleteRoom();
  const leave = useRemoveMember(room?.id ?? '');
  const { session } = useAuth();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const clear = useClearContext(room?.id ?? '');
  if (!room) return <SkeletonText lines={1} label={t('common.loading')} />;
  const own = room.members.find((member) => member.user_id === session?.user.id);

  const rename = async () => {
    const name = await prompt.ask({
      title: t('rooms.rename'),
      label: t('rooms.new.name'),
      initialValue: room.name,
      confirmLabel: t('common.save'),
    });
    if (name?.trim()) update.mutate({ name: name.trim() });
  };
  const destroy = async () => {
    const yes = await confirm.ask({
      title: t('rooms.delete_title'),
      body: t('rooms.delete_body', { name: room.name }),
    });
    if (yes) remove.mutate(room.id, { onSuccess: onGone });
  };
  const forget = async () => {
    const yes = await confirm.ask({
      title: t('rooms.clear.title'),
      body: t('rooms.clear.body'),
      confirmLabel: t('rooms.clear.confirm'),
    });
    if (yes) clear.mutate();
  };
  const leaveRoom = async () => {
    if (!own) return;
    const yes = await confirm.ask({
      title: t('rooms.leave_title'),
      body: t('rooms.leave_body', { name: room.name }),
      confirmLabel: t('rooms.leave'),
    });
    if (yes) leave.mutate(own.id, { onSuccess: onGone });
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="room-header">
      <h1 className="min-w-0 truncate text-lg font-semibold" dir="auto" data-testid="room-title">
        {room.name}
      </h1>
      <Badge>{t('rooms.counts', { agents: room.seats.length, people: room.member_count })}</Badge>
      <span className="ms-auto flex items-center gap-1">
        <span className="lg:hidden">
          <Button
            variant="ghost"
            size="sm"

            onClick={onMembers}
            data-testid="room-members-open"
          >
            {t('rooms.members.title')}
          </Button>
        </span>
        {room.can_manage && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setInviteOpen(true)}
            data-testid="room-invite"
          >
            {t('rooms.invite.button')}
          </Button>
        )}
        <Menu
          tooltip={t('common.more')}
          align="end"
          testId="room-menu"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('common.more')}
              icon={<IconMore size={16} />}
              data-testid="room-menu-trigger"
            />
          }
        >
          {room.can_manage ? (
            <>
              <MenuItem onSelect={() => void rename()}>{t('rooms.rename')}</MenuItem>
              <MenuItem onSelect={() => setSettingsOpen(true)}>
                {t('rooms.settings.title')}
              </MenuItem>
              <MenuItem onSelect={() => void forget()}>{t('rooms.clear.menu')}</MenuItem>
              <MenuItem
                icon={room.archived_at ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
                onSelect={() => update.mutate({ archived: !room.archived_at })}
              >
                {room.archived_at ? t('rooms.unarchive') : t('rooms.archive')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                tone="danger"
                icon={<IconTrash size={14} />}
                onSelect={() => void destroy()}
              >
                {t('common.delete')}
              </MenuItem>
            </>
          ) : (
            <MenuItem tone="danger" onSelect={() => void leaveRoom()}>
              {t('rooms.leave')}
            </MenuItem>
          )}
        </Menu>
      </span>
      {(update.isError || remove.isError || leave.isError) && (
        <Notice tone="danger">
          {describeError(update.error ?? remove.error ?? leave.error, t)}
        </Notice>
      )}
      {prompt.dialog}
      {confirm.dialog}
      <InviteDialog room={room} open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <RoomSettingsDialog room={room} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function InviteDialog({
  room,
  open,
  onClose,
}: {
  room: RoomDetail;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const rotate = useRotateInvite(room.id);
  const [copied, setCopied] = useState(false);
  const code = rotate.data?.invite_code ?? room.invite_code ?? '';
  const link = rotate.data?.join_url ?? `${window.location.origin}/join/${code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('rooms.invite.title')}
      description={t('rooms.invite.description')}
      closeLabel={t('common.cancel')}
      testId="room-invite-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            loading={rotate.isPending}
            onClick={() => rotate.mutate()}
            data-testid="room-invite-rotate"
          >
            {t('rooms.invite.rotate')}
          </Button>
          <Button variant="primary" icon={<IconCopy size={14} />} onClick={() => void copy()}>
            {copied ? t('rooms.invite.copied') : t('rooms.invite.copy')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p
          className="text-2xl font-semibold tracking-widest"
          dir="ltr"
          data-testid="room-invite-code"
        >
          {code}
        </p>
        <p className="break-all text-xs text-muted" dir="ltr">
          {link}
        </p>
        {rotate.isError && <Notice tone="danger">{describeError(rotate.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}

function MembersPanel({ room }: { room: RoomDetail }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const removeSeat = useRemoveSeat(room.id);
  const stop = useStopSeat(room.id);
  const removeMember = useRemoveMember(room.id);
  const update = useUpdateRoom(room.id);
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Seat | null>(null);
  const [adding, setAdding] = useState(false);
  const agents = useMemo(() => room.seats, [room.seats]);

  return (
    <div className="flex w-full flex-col gap-4" data-testid="room-members">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('rooms.members.agents')}</h2>
          {room.can_manage && (
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto"
              icon={<IconPlus size={14} />}
              onClick={() => setAdding(true)}
              data-testid="room-add-seat"
            >
              {t('rooms.seat.add')}
            </Button>
          )}
        </div>
        {agents.length === 0 && (
          <p className="text-xs text-muted">{t('rooms.members.no_agents')}</p>
        )}
        <ul className="flex flex-col gap-1">
          {agents.map((seat) => (
            <li
              key={seat.id}
              className="room-member"
              data-testid="room-seat"
              data-seat-id={seat.id}
            >
              <SeatFace seat={seat} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1">
                  <span className="truncate text-sm font-medium" dir="auto">
                    @{seat.name}
                  </span>
                  {seat.id === room.lead_seat_id && (
                    <Badge tone="info">{t('rooms.members.lead')}</Badge>
                  )}
                  {seat.status !== 'idle' && (
                    <Badge tone="warning">{t(`rooms.status.${seat.status}`)}</Badge>
                  )}
                </span>
                <span className="truncate text-xs text-muted" dir="auto">
                  {[seat.description, seat.model ?? t('rooms.members.default_model')]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {seat.status !== 'idle' && seat.status !== 'offline' && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('rooms.members.stop', { name: seat.name })}
                  tooltip={t('rooms.members.stop', { name: seat.name })}
                  icon={<IconStop size={14} />}
                  onClick={() => stop.mutate(seat.id)}
                  data-testid="room-seat-stop"
                />
              )}
              {room.can_manage && (
                <Menu
                  tooltip={t('common.more')}
                  align="end"
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={t('common.more')}
                      icon={<IconMore size={14} />}
                      data-testid="room-seat-menu"
                    />
                  }
                >
                  <MenuItem onSelect={() => setEditing(seat)}>{t('common.edit')}</MenuItem>
                  {seat.id !== room.lead_seat_id && (
                    <MenuItem onSelect={() => update.mutate({ lead_seat_id: seat.id })}>
                      {t('rooms.members.make_lead')}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    onSelect={() =>
                      void confirm
                        .ask({
                          title: t('rooms.seat.remove_title'),
                          body: t('rooms.seat.remove_body', { name: seat.name }),
                          confirmLabel: t('rooms.seat.remove'),
                        })
                        .then((yes) => yes && removeSeat.mutate(seat.id))
                    }
                  >
                    {t('rooms.seat.remove')}
                  </MenuItem>
                </Menu>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('rooms.members.people')}</h2>
        <ul className="flex flex-col gap-1">
          {room.members.map((member) => (
            <li key={member.id} className="room-member" data-testid="room-person">
              <Avatar name={member.name} size="sm" tone="neutral" />
              <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
                {member.name}
              </span>
              {member.role === 'owner' && <Badge>{t('rooms.members.owner')}</Badge>}
              <span
                className={`room-presence ${member.online ? 'is-online' : ''}`}
                aria-label={member.online ? t('rooms.members.online') : t('rooms.members.offline')}
              />
              {room.can_manage &&
                member.role !== 'owner' &&
                member.user_id !== session?.user.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeMember.mutate(member.id)}
                    data-testid="room-remove-person"
                  >
                    {t('rooms.members.remove')}
                  </Button>
                )}
            </li>
          ))}
        </ul>
      </section>
      <MemorySection room={room} />
      {(removeSeat.isError || removeMember.isError || update.isError) && (
        <Notice tone="danger">
          {describeError(removeSeat.error ?? removeMember.error ?? update.error, t)}
        </Notice>
      )}
      {confirm.dialog}
      <SeatDialog
        roomId={room.id}
        open={adding || editing !== null}
        seat={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

/**
 * Agents passing the turn: the chain going on now, and the last one the guard stopped, with
 * the one more round a person may give it.
 */
function HandoffBar({ room, revision }: { room: RoomDetail; revision: number }) {
  const { t } = useI18n();
  const chains = useHandoffs(
    room.id,
    `${revision}:${room.handoff_chains.map((c) => c.status).join()}`,
  );
  const more = useContinueHandoff(room.id);
  const name = (id: string) => room.seats.find((seat) => seat.id === id)?.name ?? '?';
  const active = room.handoff_chains[0];
  // Only the newest chain: an older stopped one was overtaken by what the room did since.
  const newest = chains.data?.items[0];
  const stopped =
    newest && newest.status === 'stopped' && !newest.continue_used ? newest : undefined;
  if (!active && !stopped) return null;
  return (
    <div className="room-activity mb-2" data-testid="room-handoff">
      {active && (
        <span className="text-xs text-muted" data-testid="room-handoff-active">
          {t('rooms.handoff.active', {
            from: name(active.from_seat_id),
            to: name(active.to_seat_id),
            depth: active.depth,
          })}
        </span>
      )}
      {!active && stopped && (
        <Notice tone="warning">
          {t(`rooms.handoff.stopped_${stopped.stop_reason ?? 'interrupted'}`, {
            from: name(stopped.from_seat_id),
            to: name(stopped.to_seat_id),
          })}{' '}
          {stopped.stop_reason !== 'interrupted' && (
            <Button
              variant="secondary"
              size="sm"
              loading={more.isPending}
              onClick={() => more.mutate(stopped.id)}
              data-testid="room-handoff-continue"
            >
              {t('rooms.handoff.continue')}
            </Button>
          )}
        </Notice>
      )}
    </div>
  );
}

/** How the room behaves: `@all`, and whether and how far agents pass the turn. */
function RoomSettingsDialog({
  room,
  open,
  onClose,
}: {
  room: RoomDetail;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const update = useUpdateRoom(room.id);
  const link = useLinkProject();
  const projects = useProjects();
  const linked =
    projects.data?.items.find(
      (project) => (project as { report_room_id?: string | null }).report_room_id === room.id,
    )?.id ?? null;
  const [project, setProject] = useState<string | null>(linked);
  const [all, setAll] = useState(room.can_mention_all);
  const [handoff, setHandoff] = useState(room.handoff.enabled);
  const [depth, setDepth] = useState(String(room.handoff.max_depth ?? ''));
  useEffect(() => {
    if (!open) return;
    setAll(room.can_mention_all);
    setHandoff(room.handoff.enabled);
    setDepth(String(room.handoff.max_depth ?? ''));
    setProject(linked);
    update.reset();
  }, [open, linked]);
  const save = async () => {
    await update.mutateAsync({
      can_mention_all: all,
      handoff: { enabled: handoff, max_depth: parsed },
    });
    if (project !== linked) {
      if (linked) await link.mutateAsync({ projectId: linked, roomId: null });
      if (project) await link.mutateAsync({ projectId: project, roomId: room.id });
    }
    onClose();
  };
  const parsed = depth.trim() === '' ? null : Number(depth);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('rooms.settings.title')}
      closeLabel={t('common.cancel')}
      testId="room-settings-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={update.isPending || link.isPending}
            onClick={() => void save().catch(() => {})}
            data-testid="room-settings-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Switch checked={all} onChange={setAll} label={t('rooms.settings.mention_all')} />
        <Switch checked={handoff} onChange={setHandoff} label={t('rooms.settings.handoff')} />
        <Field label={t('rooms.settings.max_depth')} hint={t('rooms.settings.max_depth_hint')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              inputMode="numeric"
              value={depth}
              disabled={!handoff}
              invalid={!valid}
              onChange={(event) => setDepth(event.target.value)}
              data-testid="room-settings-depth"
            />
          )}
        </Field>
        <Select
          value={project}
          onValueChange={setProject}
          options={(projects.data?.items ?? []).map((row) => ({ value: row.id, label: row.name }))}
          label={t('rooms.settings.project')}
          placeholder={t('rooms.settings.project_none')}
          testId="room-settings-project"
        />
        <p className="text-xs text-muted">{t('rooms.settings.project_hint')}</p>
        {(update.isError || link.isError) && (
          <Notice tone="danger">{describeError(update.error ?? link.error, t)}</Notice>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The room's summary: what agents are told of what came before the messages they are shown.
 * The manager may have it rewritten now or write it by hand.
 */
function MemorySection({ room }: { room: RoomDetail }) {
  const { t } = useI18n();
  const refresh = useRefreshMemory(room.id);
  const put = usePutMemory(room.id);
  const prompt = usePrompt();
  const memory = room.memory;
  const edit = async () => {
    const summary = await prompt.ask({
      title: t('rooms.memory.edit'),
      label: t('rooms.memory.title'),
      initialValue: memory.summary ?? '',
      confirmLabel: t('common.save'),
    });
    if (summary !== null) put.mutate(summary);
  };
  return (
    <section className="flex flex-col gap-2" data-testid="room-memory">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('rooms.memory.title')}</h2>
        {memory.status === 'summarizing' && <Badge tone="info">{t('rooms.memory.working')}</Badge>}
        {memory.status === 'error' && <Badge tone="danger">{t('rooms.memory.failed')}</Badge>}
      </div>
      <p
        className="whitespace-pre-wrap text-xs text-muted"
        dir="auto"
        data-testid="room-memory-text"
      >
        {memory.summary ?? t('rooms.memory.none')}
      </p>
      {memory.error && <p className="text-xs text-danger-soft-text">{memory.error}</p>}
      {room.can_manage && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            loading={refresh.isPending}
            disabled={memory.status === 'summarizing'}
            onClick={() => refresh.mutate()}
            data-testid="room-memory-refresh"
          >
            {t('rooms.memory.refresh')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void edit()}>
            {t('rooms.memory.edit')}
          </Button>
        </div>
      )}
      {(refresh.isError || put.isError) && (
        <Notice tone="danger">{describeError(refresh.error ?? put.error, t)}</Notice>
      )}
      {prompt.dialog}
    </section>
  );
}

/** A seat's face: the agent in it, under the seat's own name. */
function SeatFace({ seat }: { seat: Seat }) {
  const identityOf = useAgentIdentities();
  return (
    <AgentFace
      identity={identityOf(seat.agent_id, seat.name, seat.name)}
      size="sm"
      testId="seat-face"
    />
  );
}
