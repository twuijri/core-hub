// A destination whose module has not landed yet still has a screen (parity rule 1) that says
// so explicitly — never a silent empty page (TEAM-RULES §4).
import { useParams } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { destinationsById, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { Notice } from '../ui/Notice.js';

const PHASES: Record<string, number> = {
  rooms: 1,
  tasks: 1,
  schedules: 1,
  notify: 1,
  knowledge: 4,
  plugins: 4,
  updates: 4,
  audit: 4,
  models: 2,
  devices: 3,
  agents: 2,
  auth: 2,
  sessions: 2,
};

export function phaseOf(module: string | undefined): number {
  return module ? (PHASES[module] ?? 2) : 2;
}

export function PlaceholderScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const { agentId } = useParams();
  const destination = destinationsById.get(id);
  const title = t(termKey(id));
  return (
    <AppShell title={title}>
      <h1 className="text-xl font-semibold">{title}</h1>
      {agentId && (
        <p className="mt-1 text-xs text-muted">{t('placeholder.agent', { id: agentId })}</p>
      )}
      <Notice className="mt-3">
        {t('placeholder.later', { name: title, phase: phaseOf(destination?.module) })}
      </Notice>
      {destination?.note && (
        <p className="mt-3 text-sm text-muted" dir="ltr">
          {destination.note}
        </p>
      )}
    </AppShell>
  );
}
