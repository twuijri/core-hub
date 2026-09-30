/**
 * "Move this sign-in to Core Hub's gateway" (DECISIONS §143), for a provider signed in to through
 * Hermes that the gateway can also sign in to (ChatGPT, xAI).
 *
 * A sign-in cannot be copied from Hermes — the vendors rotate their tokens, and two holders of one
 * would sign each other out — so the dialog says so and the person signs in once more. When that
 * sign-in is approved, the profile's model choices that named the old provider's models name the
 * new one's; the old provider stays, signed in and working, until the person removes it.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Provider, ProviderMove } from '../types.js';
import { Button, Dialog, Notice } from '../ui/index.js';
import { SignInPanel } from './SignInPanel.js';
import { useMoveToGateway } from './queries.js';

export function MoveToGatewayDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose(): void;
}) {
  const { t } = useI18n();
  const move = useMoveToGateway();
  const [moved, setMoved] = useState<ProviderMove | null>(null);
  const [approved, setApproved] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="md"
      title={t('models.subscription.move_title', { provider: provider.label })}
      closeLabel={t('ui.close')}
      testId="move-to-gateway-dialog"
    >
      <div className="flex flex-col gap-3">
        {!moved && (
          <>
            <p className="text-sm">{t('models.subscription.move_body')}</p>
            <p className="text-xs text-muted">{t('models.subscription.move_no_copy')}</p>
            {move.isError && <Notice tone="danger">{describeError(move.error, t)}</Notice>}
            <div className="ch-dialog-actions">
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                loading={move.isPending}
                onClick={() => move.mutate(provider.id, { onSuccess: setMoved })}
                data-testid="move-to-gateway-start"
              >
                {t('models.subscription.move_start')}
              </Button>
            </div>
          </>
        )}
        {moved && (
          <>
            <SignInPanel
              provider={moved.provider}
              initial={moved.sign_in}
              onApproved={() => setApproved(true)}
              onDone={onClose}
            />
            {approved && (
              <Notice tone="success">
                <span data-testid="move-to-gateway-done">
                  {t('models.subscription.move_done', { provider: provider.label })}
                </span>
              </Notice>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
