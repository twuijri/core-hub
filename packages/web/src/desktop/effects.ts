/**
 * What the signed-in shell does for the desktop app (no-ops in a browser): a
 * `corehub://open/…` link or a clicked OS notification opens its page, the app's menus
 * follow the web client's language, the dock / taskbar badge shows the unread count, and a
 * new notice is also shown by the OS.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { noticeTarget } from '../notify/NotificationsTab.js';
import { useUnreadCount } from '../notify/queries.js';
import { isEnvelope } from '../realtime/envelope.js';
import { desktopBridge } from './desktop.js';

export function useDesktopEffects(): void {
  const navigate = useNavigate();
  const { language } = useI18n();
  const unread = useUnreadCount();
  useEffect(() => desktopBridge()?.onOpenPath((path) => void navigate(path)), [navigate]);
  useEffect(() => desktopBridge()?.setLanguage(language), [language]);
  useEffect(() => desktopBridge()?.setUnreadCount(unread), [unread]);
}

/** `notice.created` from `/rt/devices`, handed to the OS when there is a desktop app. */
export function notifyDesktop(envelope: unknown): void {
  const bridge = desktopBridge();
  if (!bridge || !isEnvelope(envelope)) return;
  const notice = (envelope.payload as { notice?: unknown }).notice as
    | {
        title?: unknown;
        body?: unknown;
        profile?: string | null;
        resource?: { kind: string; id: string } | null;
      }
    | undefined;
  if (!notice || typeof notice.title !== 'string') return;
  bridge.notify({
    title: notice.title,
    body: typeof notice.body === 'string' ? notice.body : null,
    path: noticeTarget({ resource: notice.resource ?? null, profile: notice.profile ?? null }),
  });
}
