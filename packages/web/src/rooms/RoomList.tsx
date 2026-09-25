/**
 * The Rooms segment of the sidebar (NAVIGATION §1): the rooms the person is in, each with
 * how many agents and people are in it, and the segment's two actions — `New room` and
 * `Join by code`. The list is the rooms of the profile the person is in; archived rooms sit
 * behind their own toggle, as archived chats do.
 */
import { useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { Button, Notice, Segmented, SkeletonText } from '../ui/index.js';
import { IconPlus } from '../ui/icons.js';
import { JoinRoomDialog } from './JoinRoomDialog.js';
import { NewRoomDialog } from './NewRoomDialog.js';
import { useRoomListEvents, useRooms } from './queries.js';

export function roomPath(roomId: string): string {
  return `${routeOf('rooms').split('/:')[0]}/${roomId}`;
}

export function RoomList({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const rooms = useRooms(archived);
  useRoomListEvents();
  const [creating, setCreating] = useState(false);
  // A join link (`/join/<code>`) lands here with the code, and opens the join dialog.
  const joinCode = params.get('join');
  const [joining, setJoining] = useState(false);
  const joinOpen = joining || joinCode !== null;
  const closeJoin = () => {
    setJoining(false);
    if (joinCode !== null) {
      params.delete('join');
      setParams(params, { replace: true });
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="room-list">
      <div className="flex items-center gap-1 px-1">
        <Button
          variant="secondary"
          size="sm"
          icon={<IconPlus size={14} />}
          onClick={() => setCreating(true)}
          data-testid="new-room"
        >
          {t('nav.new_room')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setJoining(true)} data-testid="join-room">
          {t('nav.join_by_code')}
        </Button>
      </div>
      <Segmented
        label={t('rooms.filter')}
        value={archived ? 'archived' : 'active'}
        onChange={(value) => setArchived(value === 'archived')}
        size="sm"
        stretch
        testId="room-filter"
        options={[
          { value: 'active', label: t('rooms.active') },
          { value: 'archived', label: t('rooms.archived') },
        ]}
      />
      {rooms.isPending && <SkeletonText lines={3} label={t('common.loading')} />}
      {rooms.isError && <Notice tone="danger">{describeError(rooms.error, t)}</Notice>}
      {rooms.data && rooms.data.items.length === 0 && (
        <p className="px-2 text-xs text-muted" data-testid="rooms-empty">
          {archived ? t('rooms.none_archived') : t('rooms.none')}
        </p>
      )}
      {rooms.data && rooms.data.items.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label={t('nav.rooms')}>
          {rooms.data.items.map((room) => (
            <li key={room.id} className="session-row">
              <NavLink
                to={roomPath(room.id)}
                onClick={onOpen}
                className={({ isActive }) => `session-link ${isActive ? 'active' : ''}`}
                data-testid="room-row"
                data-room-id={room.id}
              >
                <span className="session-title-row">
                  <span className="min-w-0 truncate" dir="auto">
                    {room.name}
                  </span>
                </span>
                <span className="session-preview">
                  {t('rooms.counts', { agents: room.seats.length, people: room.member_count })}
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
      <NewRoomDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen?.();
          navigate(roomPath(id));
        }}
      />
      <JoinRoomDialog
        open={joinOpen}
        initialCode={joinCode ?? ''}
        onClose={closeJoin}
        onJoined={(id) => {
          closeJoin();
          onOpen?.();
          navigate(roomPath(id));
        }}
      />
    </div>
  );
}
