/**
 * Agents on this computer (ADR 0022, ADR 0025), inside This device — one section, not a page
 * of its own (owner, 2026-09-26: «كل شي خله في قسم واحد "هذا الجهاز"»).
 *
 * It shows exactly what an agent can reach, grouped so the page stays short: the switch; how
 * the hub reaches this computer (the device connection for a hub on a server, the address for
 * the hub on this computer); the shared folders (the app's own `~/Core Hub` among them); the
 * programs on this computer; and the recent use. Everything but the switch folds away.
 * Everything starts off; every change is the person's click.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useAgents } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { describeError } from '../auth/client.js';
import { useCreateMcpServer, useMcpServers, useUpdateMcpServer } from '../agents/skills.js';
import { Badge, Button, Notice, Switch } from '../ui/index.js';
import { IconChevron } from '../ui/icons.js';
import type { DesktopBridge, DesktopHelperState } from './bridge-types.js';
import { DeviceLinkPanel } from './DeviceLinkPanel.js';
import { ProgramsSection } from './ProgramsSection.js';

/** The name the helper takes among Hermes's MCP servers. */
export const HELPER_MCP_NAME = 'this-computer';
/** Which profile is asking, so the helper offers that profile's programs (ADR 0025). */
export const HELPER_PROFILE_HEADER = 'X-Corehub-Profile';

/** A part of the section that folds away; its title line stays. */
export function Fold({
  title,
  badge,
  open: initiallyOpen = false,
  testId,
  children,
}: {
  title: string;
  badge?: ReactNode;
  open?: boolean;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="ch-card ch-card-flat ch-card-pad-sm"
      data-testid={testId}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
        <IconChevron size={14} className={open ? 'rotate-180' : ''} />
        <span className="text-sm font-semibold">{title}</span>
        {badge}
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

function AddToHermes({ helper }: { helper: DesktopHelperState }) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const agents = useAgents();
  const hermes = agents.data?.find((agent) => agent.slug === 'hermes');
  const servers = useMcpServers(hermes?.id);
  const create = useCreateMcpServer(hermes?.id);
  const update = useUpdateMcpServer(hermes?.id);
  const [done, setDone] = useState(false);
  if (agents.isSuccess && !hermes) return <Notice>{t('helper.no_hermes_agent')}</Notice>;
  if (!hermes || !helper.url) return null;
  // The profile header lets the helper offer this profile's programs, and only those.
  const config = {
    url: helper.url,
    headers: { Authorization: `Bearer ${helper.token}`, [HELPER_PROFILE_HEADER]: profile },
  };
  const existing = servers.data?.items.some((server) => server.name === HELPER_MCP_NAME);
  const failure = create.error ?? update.error;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="primary"
        data-testid="helper-add-to-hermes"
        disabled={create.isPending || update.isPending || servers.isPending}
        onClick={() => {
          setDone(false);
          const onSuccess = () => setDone(true);
          if (existing)
            update.mutate({ name: HELPER_MCP_NAME, enabled: true, config }, { onSuccess });
          else
            create.mutate(
              { name: HELPER_MCP_NAME, transport: 'http', enabled: true, config },
              { onSuccess },
            );
        }}
      >
        {t('helper.add_to_hermes')}
      </Button>
      {done && (
        <Notice tone="success">{t('helper.added_to_hermes', { name: HELPER_MCP_NAME })}</Notice>
      )}
      {failure && <Notice tone="danger">{describeError(failure, t)}</Notice>}
    </div>
  );
}

export function HelperSection({ bridge, local }: { bridge: DesktopBridge; local: boolean }) {
  const { t, language } = useI18n();
  const [state, setState] = useState<DesktopHelperState | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      bridge.helper
        .get()
        .then((next) => live && setState(next))
        .catch(() => {});
    load();
    // The activity list follows what agents do while the page is open.
    const timer = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge]);

  if (!state) return null;
  const apply = (next: Promise<DesktopHelperState>) => void next.then(setState);
  const copy = (key: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => setCopied(key));
  const time = new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="helper-heading" data-testid="helper">
      <h3 id="helper-heading" className="text-sm font-semibold">
        {t('helper.title')}
      </h3>
      <p className="text-sm text-muted">{t('helper.intro')}</p>
      <Switch
        checked={state.enabled}
        onChange={(next) => apply(bridge.helper.setEnabled(next))}
        label={t('helper.enable')}
        hint={t('helper.enable_hint')}
        testId="helper-enabled"
      />
      {state.error && (
        <Notice tone="danger">{t('helper.not_running', { message: state.error })}</Notice>
      )}

      {state.enabled && (
        <>
          {local ? (
            <Fold title={t('helper.connection')} testId="helper-connection-fold">
              <p className="text-sm text-muted">{t('helper.local_note')}</p>
              {state.url && (
                <>
                  <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
                    <dt>{t('helper.address')}</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-mono" data-testid="helper-url">
                        {state.url}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copy('url', state.url ?? '')}
                      >
                        {copied === 'url' ? t('helper.copied') : t('helper.copy')}
                      </Button>
                    </dd>
                    <dt>{t('helper.token')}</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="font-mono break-all">
                        {showToken ? state.token : '•'.repeat(16)}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setShowToken((v) => !v)}>
                        {showToken ? t('helper.hide') : t('helper.show')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => copy('token', state.token)}>
                        {copied === 'token' ? t('helper.copied') : t('helper.copy')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => apply(bridge.helper.newToken())}
                      >
                        {t('helper.new_token')}
                      </Button>
                    </dd>
                  </dl>
                  <p className="text-xs text-muted">{t('helper.new_token_hint')}</p>
                  <AddToHermes helper={state} />
                </>
              )}
            </Fold>
          ) : (
            <DeviceLinkPanel bridge={bridge} />
          )}

          <Fold
            title={t('helper.folders')}
            badge={<Badge tone="neutral">{state.folders.length}</Badge>}
            open={state.folders.length === 0}
            testId="helper-folders-fold"
          >
            {state.folders.length === 0 ? (
              <p className="text-sm text-muted" data-testid="helper-no-folders">
                {t('helper.no_folders')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="helper-folders">
                {state.folders.map((folder) => (
                  <li key={folder.path} className="flex flex-wrap items-center gap-3">
                    <span dir="ltr" className="font-mono text-sm">
                      {folder.path}
                    </span>
                    {folder.path === state.defaultFolder && (
                      <Badge tone="accent" testId="helper-default-folder">
                        {t('helper.default_folder')}
                      </Badge>
                    )}
                    <Switch
                      checked={folder.write}
                      onChange={(next) => apply(bridge.helper.setFolderWrite(folder.path, next))}
                      label={t('helper.writable')}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => apply(bridge.helper.removeFolder(folder.path))}
                    >
                      {t('helper.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {state.defaultFolder && (
              <p className="text-xs text-muted">{t('helper.default_folder_hint')}</p>
            )}
            <div>
              <Button
                variant="secondary"
                data-testid="helper-add-folder"
                onClick={() => apply(bridge.helper.addFolder())}
              >
                {t('helper.add_folder')}
              </Button>
            </div>
            <Switch
              checked={state.allowOpen}
              onChange={(next) => apply(bridge.helper.setAllowOpen(next))}
              label={t('helper.allow_open')}
              hint={t('helper.allow_open_hint')}
              testId="helper-allow-open"
            />
            <h4 className="text-sm font-semibold">{t('helper.exposed')}</h4>
            <ul className="flex flex-col gap-1 text-sm" data-testid="helper-tools">
              {state.tools.map((tool) => (
                <li key={tool.name} data-tool={tool.name}>
                  {t(`helper.tool_${tool.name}`)}{' '}
                  <span dir="ltr" className="font-mono text-xs text-muted">
                    {tool.name}
                  </span>
                </li>
              ))}
            </ul>
          </Fold>

          <ProgramsSection bridge={bridge} />

          <Fold
            title={t('helper.activity')}
            badge={
              state.activity.length > 0 ? (
                <Badge tone="neutral">{state.activity.length}</Badge>
              ) : undefined
            }
            testId="helper-activity-fold"
          >
            {state.activity.length === 0 ? (
              <p className="text-sm text-muted">{t('helper.no_activity')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" data-testid="helper-activity">
                {state.activity.map((entry) => (
                  <li
                    key={`${entry.at}-${entry.tool}-${entry.target ?? ''}`}
                    className="flex flex-wrap gap-2"
                  >
                    <span className="text-muted">{time.format(new Date(entry.at))}</span>
                    {entry.program && <span dir="auto">{entry.program}</span>}
                    <span dir="ltr" className="font-mono">
                      {entry.tool}
                    </span>
                    {entry.target && (
                      <span dir="ltr" className="font-mono text-muted break-all">
                        {entry.target}
                      </span>
                    )}
                    {entry.via && (
                      <Badge tone="neutral">
                        {t(entry.via === 'hub' ? 'helper.via_hub' : 'helper.via_local')}
                      </Badge>
                    )}
                    {!entry.ok && <Badge tone="danger">{t('helper.refused')}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Fold>
        </>
      )}
    </section>
  );
}
