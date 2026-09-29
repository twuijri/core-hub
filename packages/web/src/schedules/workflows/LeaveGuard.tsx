/**
 * "You have unsaved changes" (owner, 2026-09-29: a tester edited a workflow, went to another
 * page and lost the work because nothing told him to Save).
 *
 * While the editor holds unsaved work:
 * - closing or reloading the tab asks the browser's own question (`beforeunload`);
 * - a link to another page of the app — the sidebar, a link in a dialog — and the editor's
 *   own "Back" first ask here: Save and leave, Discard and leave, or Stay.
 *
 * The app's router is a `BrowserRouter`, which has no navigation blocker, so a link is
 * caught on its way down (a capture listener on `window`, before the router's own handler).
 * The browser's Back button cannot be held; the editor keeps what was left behind and offers
 * it back when the workflow is opened again (`WorkflowEditor.tsx`).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../../i18n/context.js';
import { Button, Dialog } from '../../ui/index.js';

/** The in-app address a click on this element would go to, or `null` if it leaves the app. */
export function leavingTo(target: EventTarget | null, here: string): string | null {
  const anchor = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return null;
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  const url = new URL(anchor.getAttribute('href') ?? '', window.location.href);
  if (url.origin !== window.location.origin) return null;
  const there = `${url.pathname}${url.search}${url.hash}`;
  return there === here ? null : there;
}

export function useLeaveGuard({
  unsaved,
  here,
  onSave,
  saveBlocked,
  onLeave,
}: {
  unsaved: boolean;
  /** The editor's own address, which a link may point at without leaving. */
  here: string;
  /** Saves; `true` once it is saved. */
  onSave: () => Promise<boolean>;
  /** Why Save cannot be used now (no name, problems), or `null`. */
  saveBlocked: string | null;
  /** Called just before the editor is left on purpose (after Save or Discard). */
  onLeave?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when a value is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const there = leavingTo(event.target, here);
      if (!there) return;
      event.preventDefault();
      event.stopPropagation();
      setLeave(() => () => navigate(there));
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, [unsaved, here, navigate]);

  /** Leave through the question when there is unsaved work, at once otherwise. */
  const guard = useCallback(
    (go: () => void) => {
      if (unsaved) setLeave(() => go);
      else go();
    },
    [unsaved],
  );

  const go = () => {
    const next = leave;
    setLeave(null);
    onLeave?.();
    next?.();
  };

  const dialog = (
    <Dialog
      open={leave !== null}
      onOpenChange={(open) => {
        if (!open) setLeave(null);
      }}
      title={t('workflows.leave.title')}
      description={t('workflows.leave.body')}
      size="sm"
      closeLabel={t('workflows.leave.stay')}
      testId="workflow-leave-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => setLeave(null)}
            data-testid="workflow-leave-stay"
          >
            {t('workflows.leave.stay')}
          </Button>
          <Button variant="danger-quiet" onClick={go} data-testid="workflow-leave-discard">
            {t('workflows.leave.discard')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={saveBlocked !== null}
            tooltip={saveBlocked ?? undefined}
            onClick={() => {
              setSaving(true);
              void onSave()
                .then((saved) => {
                  if (saved) go();
                })
                .catch(() => undefined)
                .finally(() => setSaving(false));
            }}
            data-testid="workflow-leave-save"
          >
            {t('workflows.leave.save')}
          </Button>
        </>
      }
    />
  );

  return { guard, dialog };
}
