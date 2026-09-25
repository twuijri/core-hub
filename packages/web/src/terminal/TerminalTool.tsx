/**
 * Settings → Terminal: a shell on the hub's host, for the owner only (DECISIONS §60).
 *
 * The owner asked for it, and for whom (2026-09-25): «الا خله للمشرف الرئيسي بس». The hub
 * enforces that; this page only mirrors it — the entry exists when `GET /terminal` answers
 * `200` (`queries.ts`), and anything else is said plainly here.
 *
 * - Several terminals, as tabs. Each is a session on the hub, not in the page: a reload, or a
 *   dropped connection, attaches to the live ones again and repaints them from what the hub
 *   kept, until one sits idle past the hub's timeout.
 * - Copy and paste: the buttons, or Ctrl+Shift+C / Ctrl+Shift+V (Ctrl+C stays the shell's).
 * - Resizing follows the page: the screen fits its box and tells the hub its size.
 * - The warning is always on the page, not a dismissible banner: what runs here runs on the
 *   server with the hub account's permissions.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { useRealtime } from '../realtime/context.js';
import {
  Button,
  EmptyState,
  buttonClass,
  Notice,
  Skeleton,
  SkeletonGroup,
  Spinner,
} from '../ui/index.js';
import { IconAlert, IconClose, IconCopy, IconPlus } from '../ui/icons.js';
import type { PaneHandle } from './XtermPane.js';
import {
  useTerminalStatus,
  type ExitReason,
  type TerminalSessionInfo,
  type TerminalStatus,
} from './queries.js';

const XtermPane = lazy(() => import('./XtermPane.js'));

/** Which tab was in front, so a reload comes back to it. Per tab of the browser. */
const ACTIVE_KEY = 'corehub.terminal.active';

interface Tab {
  id: string;
  n: number;
  cwd: string;
  ended: ExitReason | 'gone' | null;
}

interface Ack {
  ok: boolean;
  error?: string;
  code?: string;
  details?: { reason?: string };
  session?: TerminalSessionInfo;
  backlog?: string;
}

interface Envelope {
  payload: { terminal_id: string; data?: string; reason?: ExitReason };
}

function readActive(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(ACTIVE_KEY, id);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    // A browser that keeps nothing still has a working terminal.
  }
}

export function TerminalTool() {
  const { t } = useI18n();
  const { user } = useAuth();
  const status = useTerminalStatus({ fresh: true });
  const disabled = (
    <EmptyState
      icon={<IconAlert size={20} />}
      title={t('terminal.disabled')}
      body={t('terminal.disabled_body')}
    />
  );

  // Not the owner: the router refuses the page, the hub refuses the terminal, and nothing is
  // asked for.
  if (user?.role !== 'owner') return disabled;
  if (status.isPending) {
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="20rem" radius="md" />
      </SkeletonGroup>
    );
  }
  if (status.isError) {
    if (status.error instanceof HubApiError && status.error.status === 403) return disabled;
    return <Notice tone="danger">{describeError(status.error, t)}</Notice>;
  }
  return <TerminalWorkspace status={status.data} />;
}

function TerminalWorkspace({ status }: { status: TerminalStatus }) {
  const { t } = useI18n();
  const { homeProfile } = useAuth();
  const { socket: socketOf, epoch } = useRealtime();
  const counter = useRef(status.sessions.length);
  const [tabs, setTabs] = useState<Tab[]>(() =>
    status.sessions.map((session, index) => ({
      id: session.id,
      n: index + 1,
      cwd: session.cwd,
      ended: null,
    })),
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [active, setActive] = useState<string | null>(() => {
    const stored = readActive();
    return status.sessions.some((s) => s.id === stored) ? stored : (status.sessions[0]?.id ?? null);
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [connected, setConnected] = useState(false);
  const panes = useRef(new Map<string, PaneHandle>());
  /** What arrived for a screen that is still loading; written once it is there. */
  const early = useRef(new Map<string, string[]>());

  useEffect(() => writeActive(active), [active]);

  const markEnded = useCallback((id: string, reason: Tab['ended']) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ended: reason } : tab)));
  }, []);

  const write = useCallback((id: string, data: string) => {
    const pane = panes.current.get(id);
    if (pane) return pane.write(data);
    const queued = early.current.get(id) ?? [];
    queued.push(data);
    early.current.set(id, queued);
  }, []);

  const socket = socketOf('terminal');

  // One listener for every tab; output is routed by session id. On every (re)connection the
  // hub has forgotten which sessions this socket shows, so each live tab attaches again and
  // is repainted from the hub's copy of its recent output.
  useEffect(() => {
    const onOutput = (envelope: Envelope) => {
      const { terminal_id: id, data } = envelope.payload;
      if (data) write(id, data);
    };
    const onExited = (envelope: Envelope) => {
      const { terminal_id: id, reason } = envelope.payload;
      markEnded(id, reason ?? 'exited');
    };
    const attachAll = () => {
      setConnected(true);
      for (const tab of tabsRef.current) {
        if (tab.ended) continue;
        socket.emit('attach', { terminal_id: tab.id }, (ack: Ack) => {
          if (!ack.ok) return markEnded(tab.id, 'gone');
          const pane = panes.current.get(tab.id);
          if (pane) {
            pane.reset();
            pane.write(ack.backlog ?? '');
            const size = pane.size();
            socket.emit('resize', { terminal_id: tab.id, ...size });
          } else {
            early.current.set(tab.id, [ack.backlog ?? '']);
          }
        });
      }
    };
    const onDisconnect = () => setConnected(false);
    socket.on('terminal.output', onOutput);
    socket.on('terminal.exited', onExited);
    socket.on('connect', attachAll);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) attachAll();
    return () => {
      socket.off('terminal.output', onOutput);
      socket.off('terminal.exited', onExited);
      socket.off('connect', attachAll);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, epoch, write, markEnded]);

  const register = useCallback((id: string, handle: PaneHandle | null) => {
    if (!handle) return void panes.current.delete(id);
    panes.current.set(id, handle);
    for (const data of early.current.get(id) ?? []) handle.write(data);
    early.current.delete(id);
  }, []);

  const onInput = useCallback(
    (id: string, data: string) => {
      socket.emit('input', { terminal_id: id, data });
    },
    [socket],
  );
  const onResize = useCallback(
    (id: string, cols: number, rows: number) => {
      socket.emit('resize', { terminal_id: id, cols, rows });
    },
    [socket],
  );
  const onClipboardDenied = useCallback(() => setProblem(t('terminal.clipboard_denied')), [t]);

  const openNew = () => {
    setProblem(null);
    setOpening(true);
    const size = (active && panes.current.get(active)?.size()) || { cols: 100, rows: 30 };
    socket.emit('open', { profile: homeProfile, ...size }, (ack: Ack) => {
      setOpening(false);
      if (!ack.ok || !ack.session) {
        setProblem(
          ack.details?.reason === 'terminal_limit'
            ? t('terminal.limit', { max: status.max_sessions })
            : (ack.error ?? t('errors.unexpected')),
        );
        return;
      }
      const session = ack.session;
      counter.current += 1;
      setTabs((current) => [
        ...current,
        { id: session.id, n: counter.current, cwd: session.cwd, ended: null },
      ]);
      setActive(session.id);
    });
  };

  const closeTab = (tab: Tab) => {
    const remove = () => {
      const next = tabsRef.current.filter((other) => other.id !== tab.id);
      setTabs(next);
      setActive((current) => (current === tab.id ? (next[next.length - 1]?.id ?? null) : current));
      early.current.delete(tab.id);
    };
    if (tab.ended) return remove();
    socket.emit('close', { terminal_id: tab.id }, () => remove());
  };

  const live = tabs.filter((tab) => !tab.ended).length;
  const front = tabs.find((tab) => tab.id === active) ?? null;
  const reasonText = (reason: NonNullable<Tab['ended']>) =>
    reason === 'gone'
      ? t('terminal.gone')
      : t('terminal.ended', { reason: t(`terminal.reason_${reason}`) });

  return (
    <div className="flex flex-col gap-3" data-testid="terminal-tool">
      <Notice tone="warning" role="alert">
        <strong className="block">{t('terminal.warning')}</strong>
        <span>{t('terminal.warning_detail')}</span>
      </Notice>
      {!status.pty && <Notice tone="info">{t('terminal.no_pty')}</Notice>}
      <p className="text-sm text-muted">
        {t('terminal.idle', {
          minutes: Math.round(status.idle_timeout_seconds / 60),
          max: status.max_sessions,
        })}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t('nav.terminal')} className="flex flex-wrap gap-1">
          {tabs.map((tab) => {
            const name = t('terminal.tab', { n: tab.n });
            return (
              <span key={tab.id} className="inline-flex items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === active}
                  data-testid="terminal-tab"
                  className={buttonClass(
                    tab.id === active ? 'primary' : 'ghost',
                    'sm',
                    tab.ended ? 'opacity-60' : '',
                  )}
                  onClick={() => setActive(tab.id)}
                >
                  {name}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<IconClose size={14} />}
                  aria-label={t('terminal.close', { name })}
                  onClick={() => closeTab(tab)}
                />
              </span>
            );
          })}
        </div>
        <Button
          size="sm"
          icon={<IconPlus size={14} />}
          onClick={openNew}
          disabled={opening || !connected || live >= status.max_sessions}
          data-testid="terminal-new"
        >
          {t('terminal.new')}
        </Button>
        {front && !front.ended && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconCopy size={14} />}
              onClick={() => void panes.current.get(front.id)?.copy()}
            >
              {t('terminal.copy')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void panes.current.get(front.id)?.paste()}
            >
              {t('terminal.paste')}
            </Button>
          </>
        )}
        {!connected && <Spinner label={t('terminal.connecting')} />}
      </div>
      {problem && <Notice tone="danger">{problem}</Notice>}

      {tabs.length === 0 ? (
        <EmptyState
          icon={<IconPlus size={20} />}
          title={t('terminal.empty')}
          body={t('terminal.empty_body', { profile: homeProfile })}
        />
      ) : (
        <Suspense fallback={<Skeleton height="20rem" radius="md" />}>
          {front && (
            <p className="text-xs text-muted">
              {t('terminal.folder')}{' '}
              <bdi dir="ltr" className="font-mono">
                {front.cwd}
              </bdi>
            </p>
          )}
          {front?.ended && <Notice tone="info">{reasonText(front.ended)}</Notice>}
          {tabs.map((tab) => (
            <XtermPane
              key={tab.id}
              id={tab.id}
              active={tab.id === active}
              label={t('terminal.tab', { n: tab.n })}
              register={register}
              onInput={onInput}
              onResize={onResize}
              onClipboardDenied={onClipboardDenied}
            />
          ))}
        </Suspense>
      )}
      <p className="text-xs text-muted">{t('terminal.copy_hint')}</p>
    </div>
  );
}
