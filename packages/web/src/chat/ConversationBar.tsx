/**
 * The conversation's own controls, in the app's top bar (owner, 2026-09-26).
 *
 * They used to be a row above the messages and scrolled away with them: «لازم تكون كل هذي
 * الأشياء ثابتة». A second pinned bar would have eaten the page («بيطلع فوق كأنه شريطين»), so they
 * join the one bar that is already pinned: the title at its start, and at its end, as compact
 * icons with tooltips —
 *
 * 1. the agent (its mark and ▾; the menu continues the chat with another agent);
 * 2. the folder (an icon; its popover says the name, the whole path and why it is fixed);
 * 3. Files (an icon with the count);
 * 4. the Chat | Trajectory switch.
 *
 * The person's profile chip is already in the bar; the conversation's profile is added only when
 * it is a different one (a chat opened from "All profiles", ADR 0016).
 *
 * Where the bar is too narrow for all of it — a phone, a narrow window — the agent stays and the
 * rest moves into one "More" panel, so the bar never needs a second row.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { FilesButton, FilesSheet, filesLabel } from '../files/FilesList.js';
import { useSessionFilesContext } from '../files/context.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles } from '../shell/profiles.js';
import { TopBarActions } from '../shell/topBarSlot.js';
import { Popover, Separator, TabList } from '../ui/index.js';
import { IconFile, IconMore } from '../ui/icons.js';
import { SessionAgent } from './SessionAgent.js';
import { WorkingDirPanel, WorkingDirPicker } from './WorkingDirPicker.js';

/** Below this width of the top bar, the folder, Files and the switch go into "More". */
export const BAR_INLINE_MIN = 640;

/** How the bar lays out at a given width; 0 is "not measured yet", which shows everything. */
export function barLayout(width: number): 'inline' | 'menu' {
  return width === 0 || width >= BAR_INLINE_MIN ? 'inline' : 'menu';
}

export interface ConversationBarProps {
  sessionId: string;
  agentId: string | null;
  workingDir: string | null;
  onWorkingDir(next: string | null): void;
  /** Why the folder no longer moves; `null` while it still may. */
  lockedReason: string | null;
  /** The conversation has messages: Files and the Chat | Trajectory switch belong to it. */
  begun: boolean;
}

export function ConversationBar(props: ConversationBarProps) {
  return (
    <TopBarActions>
      <ConversationBarBody {...props} />
    </TopBarActions>
  );
}

function ConversationBarBody({
  sessionId,
  agentId,
  workingDir,
  onWorkingDir,
  lockedReason,
  begun,
}: ConversationBarProps) {
  const { t } = useI18n();
  const { profile, homeProfile } = useAuth();
  const manyProfiles = useManyProfiles();
  const [filesOpen, setFilesOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const layout = barLayout(useBarWidth(root));
  // The profile chip at the bar's end is the person's; this one is said only when it differs.
  const otherProfile = manyProfiles && profile !== homeProfile;

  const tabs = (
    <TabList
      compact
      label={t('trajectory.tabs_label')}
      testId="chat-tabs"
      items={[
        { value: 'chat', label: t('trajectory.chat_tab') },
        { value: 'trajectory', label: t('trajectory.tab') },
      ]}
    />
  );

  return (
    <div className="convo-bar" ref={root} data-testid="chat-header" data-layout={layout}>
      <SessionAgent sessionId={sessionId} agentId={agentId} compact />
      {otherProfile && <ProfileBadge profile={profile} testId="chat-profile" />}
      {layout === 'inline' ? (
        <>
          <WorkingDirPicker
            variant="bar"
            value={workingDir}
            onChange={onWorkingDir}
            lockedReason={lockedReason}
          />
          {begun && <FilesButton onOpen={() => setFilesOpen(true)} />}
          {begun && <div className="convo-tabs">{tabs}</div>}
        </>
      ) : (
        <MorePanel
          workingDir={workingDir}
          onWorkingDir={onWorkingDir}
          lockedReason={lockedReason}
          files={begun ? () => setFilesOpen(true) : null}
          tabs={begun ? tabs : null}
        />
      )}
      <FilesSheet open={filesOpen} onOpenChange={setFilesOpen} />
    </div>
  );
}

/** The width of the top bar this sits in, kept current as the window or the pane moves. */
function useBarWidth(root: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const bar = root.current?.closest('header') ?? root.current?.parentElement;
    if (!bar) return;
    const read = () => setWidth(Math.round(bar.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [root]);
  return width;
}

/** A narrow bar's "More": the folder, Files and the switch, one under the other. */
function MorePanel({
  workingDir,
  onWorkingDir,
  lockedReason,
  files,
  tabs,
}: {
  workingDir: string | null;
  onWorkingDir(next: string | null): void;
  lockedReason: string | null;
  files: (() => void) | null;
  tabs: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const count = useSessionFilesContext().files.length;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      tooltip={t('chat.bar_more')}
      testId="chat-more"
      className="convo-more"
      trigger={
        <button
          type="button"
          className="btn btn-ghost px-1.5"
          aria-label={t('chat.bar_more')}
          data-testid="chat-more-button"
        >
          <IconMore />
        </button>
      }
    >
      <section className="flex flex-col gap-2" aria-label={t('working_dir.label')}>
        <h2 className="text-xs font-medium text-muted">{t('working_dir.label')}</h2>
        <WorkingDirPanel
          value={workingDir}
          onChange={onWorkingDir}
          lockedReason={lockedReason}
          onDone={() => setOpen(false)}
        />
      </section>
      {files && (
        <>
          <Separator />
          <button
            type="button"
            className="convo-more-row"
            onClick={() => {
              setOpen(false);
              files();
            }}
            data-testid="chat-files"
            data-count={count}
          >
            <IconFile size={16} />
            <span>{filesLabel(count, t)}</span>
          </button>
        </>
      )}
      {tabs && (
        <>
          <Separator />
          {/* Choosing a view is done with the panel: it closes, the view is on screen. */}
          <div className="convo-tabs" onClick={() => setOpen(false)}>
            {tabs}
          </div>
        </>
      )}
    </Popover>
  );
}
