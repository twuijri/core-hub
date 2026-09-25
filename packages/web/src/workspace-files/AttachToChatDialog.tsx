/**
 * "Attach to chat": put a profile file into a conversation's composer.
 *
 * The hub copies the file into the attachment registry (`knowledge.attachWorkspaceFile`) —
 * the working file stays where it is, and later edits to it do not change what was sent —
 * and the chosen conversation opens with the file already in its tray, ready to go with the
 * next message (`attachments/handoff.ts`). The choice is a new chat or one of this profile's
 * recent ones; the file belongs to this profile, so another profile's chats are not offered.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { handOff } from '../attachments/handoff.js';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { chatHref } from '../chat/anchor.js';
import { useSessions } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { sessionTitle } from '../sessions/SessionList.js';
import { Button, Dialog, Notice, Skeleton } from '../ui/index.js';
import { IconPlus } from '../ui/icons.js';
import { useWorkspaceFileActions, type WorkspaceFileEntry } from './queries.js';

/** How many recent conversations the dialog offers besides a new one. */
const RECENT = 8;

export function AttachToChatDialog({
  entry,
  onClose,
}: {
  entry: WorkspaceFileEntry;
  onClose(): void;
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const sessions = useSessions();
  const { attach } = useWorkspaceFileActions();
  const [error, setError] = useState<string | null>(null);
  const recent = (sessions.data?.items ?? [])
    .filter((session) => session.source !== 'global_agent')
    .slice(0, RECENT);

  const send = async (to: string) => {
    setError(null);
    try {
      const attachment = await attach.mutateAsync(entry.path);
      handOff(profile, [attachment]);
      onClose();
      navigate(to);
    } catch (err) {
      setError(describeError(err, t));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('workspace_files.attach_title', { name: entry.name })}
      description={t('workspace_files.attach_body')}
      closeLabel={t('workspace_files.close')}
      testId="files-attach"
    >
      {error && (
        <div className="mb-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      <ul className="flex flex-col gap-1" data-testid="files-attach-targets">
        <li>
          <Button
            className="w-full justify-start"
            variant="primary"
            disabled={attach.isPending}
            onClick={() => void send(routeOf('new_chat'))}
            icon={<IconPlus size={14} />}
            data-testid="files-attach-new"
          >
            {t('workspace_files.attach_new_chat')}
          </Button>
        </li>
        {sessions.isPending && <Skeleton height="2.25rem" radius="md" />}
        {recent.map((session) => (
          <li key={session.id}>
            <Button
              className="w-full justify-start"
              variant="ghost"
              disabled={attach.isPending}
              onClick={() => void send(chatHref(session.id))}
            >
              <span className="truncate" dir="auto">
                {sessionTitle(session, t)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
