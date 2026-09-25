/**
 * Join by code: the code (or the whole link — the last part of it is the code), what the
 * room is before joining it, then in. A room of another profile the person may enter opens
 * there: the top selector moves to that profile, since a room lives in one.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Field, Input, Notice, Spinner } from '../ui/index.js';
import { codeFrom, useInvitePreview, useJoinRoom } from './queries.js';

export function JoinRoomDialog({
  open,
  initialCode,
  onClose,
  onJoined,
}: {
  open: boolean;
  initialCode: string;
  onClose(): void;
  onJoined(roomId: string): void;
}) {
  const { t } = useI18n();
  const { profile, setProfile } = useAuth();
  const [typed, setTyped] = useState(initialCode);
  useEffect(() => {
    if (open) setTyped(initialCode);
  }, [open, initialCode]);
  const code = codeFrom(typed);
  const preview = useInvitePreview(open ? code : '');
  const join = useJoinRoom();

  const submit = () => {
    if (!preview.data) return;
    join.mutate(code, {
      onSuccess: (room) => {
        if (room.profile !== profile) setProfile(room.profile);
        onJoined(room.id);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('nav.join_by_code')}
      description={t('rooms.join.description')}
      closeLabel={t('common.cancel')}
      testId="join-room-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!preview.data}
            loading={join.isPending}
            onClick={submit}
            data-testid="join-room-submit"
          >
            {preview.data?.already_member ? t('rooms.join.open') : t('rooms.join.join')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('rooms.join.code')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="7KQ2M9XW"
              data-testid="join-room-code"
              autoFocus
            />
          )}
        </Field>
        {preview.isFetching && <Spinner label={t('common.loading')} />}
        {preview.isError && code.length >= 4 && (
          <Notice tone="warning">{t('rooms.join.unknown')}</Notice>
        )}
        {preview.data && (
          <div data-testid="join-room-preview">
            <Notice tone="info">
              <span dir="auto">{preview.data.name}</span>
              {' · '}
              {t('rooms.counts', {
                agents: preview.data.seat_count,
                people: preview.data.member_count,
              })}
            </Notice>
          </div>
        )}
        {join.isError && <Notice tone="danger">{describeError(join.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
