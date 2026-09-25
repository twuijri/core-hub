/**
 * Approve / Deny for one sender waiting to pair with a channel: in «الموافقات» on the Channels
 * page and in the «بانتظارك» inbox alike, so both say and do the same thing.
 */
import { useI18n } from '../i18n/context.js';
import { Button } from '../ui/index.js';
import type { PairingRequest } from './skills.js';

export function PairingDecision({
  request,
  busy,
  onApprove,
  onDeny,
}: {
  request: Pick<PairingRequest, 'request_id'>;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        data-testid={`pairing-approve-${request.request_id}`}
        disabled={busy}
        onClick={onApprove}
      >
        {t('channels.pairing.approve')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`pairing-deny-${request.request_id}`}
        disabled={busy}
        onClick={onDeny}
      >
        {t('channels.pairing.deny')}
      </Button>
    </>
  );
}
