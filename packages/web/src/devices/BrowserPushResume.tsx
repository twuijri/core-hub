/**
 * After a sign-in, this browser's Web Push subscription is handed back to the hub
 * (`resumeBrowserPush`): the hub forgot it when the previous sign-in ended. Only on a sign-in
 * seen by this page — not on every load of a page already signed in, whose registration
 * still stands — and silently: it never asks for a permission. Draws nothing.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { browserEnvironment, resumeBrowserPush, type PushEnvironment } from './browserPush.js';

export function BrowserPushResume({ environment }: { environment?: PushEnvironment }) {
  const { client, user } = useAuth();
  const { language } = useI18n();
  const env = useMemo(() => environment ?? browserEnvironment(), [environment]);
  const userId = user?.id ?? null;
  const seen = useRef(userId);
  // The language at the moment of signing in is the one registered; changing it later is
  // not a sign-in.
  const locale = useRef<'ar' | 'en'>('ar');
  locale.current = language === 'en' ? 'en' : 'ar';
  useEffect(() => {
    const before = seen.current;
    seen.current = userId;
    if (!userId || before === userId) return;
    void resumeBrowserPush(client, env, { userId, locale: locale.current });
  }, [userId, client, env]);
  return null;
}
