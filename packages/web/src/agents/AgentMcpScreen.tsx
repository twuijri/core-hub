/**
 * An agent's MCP servers: the tools it can reach beyond its own.
 *
 * **This page writes a file; it does not open a connection.** Hermes connects to these
 * servers when it starts, so a change here takes effect on the next restart — the page
 * says so once, at the top, instead of showing a green dot nobody measured.
 *
 * **The server is a block of JSON, and it is edited as one.** Every MCP implementation
 * has its own fields (`command` and `args` for a process, `url` and headers for a socket,
 * and whatever a given server invented), so a form of fixed inputs would be wrong for
 * most of them and would drop the rest on save.
 *
 * **A key that went in does not come back.** A credential reads as `[stored]`, and saving
 * it unchanged keeps the one already in the file — so editing a command never costs the
 * person a key they cannot see.
 *
 * **Test asks Hermes.** The button has Hermes connect to the server as configured in this
 * profile, list its tools and disconnect; what Hermes says is shown under the row, its words
 * unchanged. The row itself still claims nothing about a connection nobody holds open.
 *
 * **A remote server can be signed in by OAuth from here** (DECISIONS §122): the chip says
 * whether this profile is signed in, and Connect runs Hermes's own browser sign-in
 * (`McpOAuthControls.tsx`).
 *
 * **A row folds** (owner, 2026-09-28). Its header — the switch, the name with its chips and
 * address, Test, Edit and Delete — is what shows; a press on the name opens what is under it:
 * the full address or command, the sign-in and its Reconnect / Disconnect, the last test. Edit
 * is its own button now, so opening a row never opens the editor. Which rows are open is kept
 * on this device (`mcpExpanded.ts`); a row that needs the person starts open.
 *
 * **The tools without pressing Test** (owner, 2026-09-29, DECISIONS §134). The hub keeps each
 * server's last test in the profile: the folded row says how many tools ("61 tools", or "12 of
 * 61 tools" when only some are allowed), and opening it shows them with a box each — which the
 * agent may use (`McpToolsPanel.tsx`). A server never tested is tested once, by itself, the
 * first time its row is open. A hub that keeps no tests (older) gets the page as it was.
 *
 * **A coding agent's page edits the agent's own file** (2026-09-29): Claude Code's
 * `~/.claude.json`, Gemini CLI's and Qwen Code's `settings.json` — one set for every profile,
 * read when the agent's conversation starts, and the note says that instead of Hermes's
 * restart. Test and sign-in ask Hermes, so they are Hermes's rows only. An agent whose file the
 * hub does not edit yet (`mcp_not_managed`) is told so, pointing to its Config files; the
 * Core Hub tools card works on every page, being the profile's.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { HubApiError } from '@corehub/contracts';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Segmented,
  Skeleton,
  SkeletonGroup,
  Switch,
  Textarea,
  useConfirm,
} from '../ui/index.js';
import { IconChevron, IconEdit, IconTool, IconTrash } from '../ui/icons.js';
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  needsOAuth,
  useHubTools,
  useMcpServers,
  useTestMcpServer,
  useUpdateMcpServer,
  type McpOAuthFlow,
  type McpServer,
} from './skills.js';
import { describeToolError } from './toolErrors.js';
import { HubToolsCard } from './HubToolsCard.js';
import { TestResult } from './McpTestResultView.js';
import { McpSignInForm } from './McpSignInForm.js';
import {
  McpOAuthChip,
  McpOAuthControls,
  offersOAuth,
  useMcpOAuthConnect,
} from './McpOAuthControls.js';
import { expandedKey, useMcpExpanded, writeExpanded } from './mcpExpanded.js';
import { McpToolsPanel, toolCountLabel } from './McpToolsPanel.js';

/**
 * Where each coding agent keeps the servers this page edits, as the hub finds it by default
 * (`coding-agent-mcp.ts`); an agent's own variable may move it, so it is said, not relied on.
 */
const AGENT_MCP_FILE: Readonly<Record<string, string>> = {
  'claude-code': '~/.claude.json',
  'gemini-cli': '~/.gemini/settings.json',
  'qwen-code': '~/.qwen/settings.json',
};

/** The hub does not edit this coding agent's servers yet (its reason, not a failure). */
function notManaged(error: unknown): boolean {
  return (
    error instanceof HubApiError &&
    (error.body as { details?: { reason?: string } } | undefined)?.details?.reason ===
      'mcp_not_managed'
  );
}

const TEMPLATE = `{
  "command": "npx",
  "args": ["-y", "some-mcp-server"]
}`;

export function AgentMcpScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const servers = useMcpServers(agentId);
  const [editing, setEditing] = useState<McpServer | null | undefined>(undefined);
  // Sign-ins "Add server" started, followed by their row from then on (§122).
  const [adopted, setAdopted] = useState<Record<string, McpOAuthFlow>>({});

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('mcp.title_of', { name: agent.name }) : t('nav.agent_mcp');
  // The hub's own block is the card's (contract decision §67), not a row to edit here.
  const hubTools = useHubTools(agentId);
  const managed = hubTools.data?.server_name ?? 'corehub';
  const items = (servers.data?.items ?? []).filter((server) => server.name !== managed);
  // Test and sign-in ask Hermes; a coding agent's page edits the agent's own file.
  const hermes = !agent || agent.kind === 'hermes';
  const unmanaged = servers.isError && notManaged(servers.error);
  const file = agent ? AGENT_MCP_FILE[agent.slug] : undefined;
  const note = hermes
    ? t('mcp.restart_note')
    : file
      ? t('mcp.agent_note', { name: agent?.name ?? '', path: file })
      : t('mcp.agent_note_no_path', { name: agent?.name ?? '' });

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {items.length > 0 && <Badge>{String(items.length)}</Badge>}
          {!unmanaged && (
            <Button
              className="ms-auto"
              size="sm"
              onClick={() => setEditing(null)}
              data-testid="new-mcp"
            >
              {t('mcp.new')}
            </Button>
          )}
        </div>
        {unmanaged ? (
          <Notice testId="mcp-not-managed">
            {t('mcp.not_managed', { name: agent?.name ?? '' })}
          </Notice>
        ) : (
          <Notice testId="mcp-note">{note}</Notice>
        )}
        <HubToolsCard agentId={agentId} hermes={hermes} agentName={agent?.name ?? ''} />

        {servers.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {servers.isError && !unmanaged && (
          <Notice tone="danger">{describeToolError(servers.error, t)}</Notice>
        )}
        {servers.data &&
          (items.length === 0 ? (
            <EmptyState
              icon={<IconTool size={20} />}
              title={t('mcp.none')}
              body={t('mcp.none_body')}
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="mcp-list">
              {items.map((server) => (
                <li key={server.name}>
                  <ServerRow
                    agentId={agentId}
                    hermes={hermes}
                    server={server}
                    adopted={adopted[server.name] ?? null}
                    onEdit={() => setEditing(server)}
                  />
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing !== undefined && (
        <ServerEditor
          agentId={agentId}
          hermes={hermes}
          server={editing}
          taken={(servers.data?.items ?? []).map((server) => server.name)}
          onSignInStarted={(name, flow) => {
            setAdopted((current) => ({ ...current, [name]: flow }));
            setEditing(undefined);
          }}
          onClose={() => setEditing(undefined)}
        />
      )}
    </AppShell>
  );
}

function ServerRow({
  agentId,
  hermes,
  server,
  adopted,
  onEdit,
}: {
  agentId: string | undefined;
  hermes: boolean;
  server: McpServer;
  adopted: McpOAuthFlow | null;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateMcpServer(agentId);
  const remove = useDeleteMcpServer(agentId);
  const probe = useTestMcpServer(agentId);
  const oauth = useMcpOAuthConnect(agentId, server.name, adopted);
  const { ask, dialog } = useConfirm();
  const key = expandedKey(agentId, server.name);
  const [open, setOpen] = useMcpExpanded(key, needsAttention(server));
  const bodyId = `mcp-details-${useId()}`;
  // A sign-in started from "Add server" is followed here, so the row opens to show it.
  useEffect(() => {
    if (adopted) setOpen(true);
  }, [adopted, setOpen]);
  const runTest = () => {
    setOpen(true);
    probe.mutate(server.name);
  };
  // A hub that keeps tests says so by sending `last_test` (null until the first one, §134).
  const remembers = 'last_test' in server;
  const last = server.last_test ?? null;
  // Open and never tested: test once, by itself — not again on every render or reopening.
  const autoTested = useRef(false);
  useEffect(() => {
    if (!open || !remembers || last !== null || autoTested.current) return;
    if (probe.isPending || probe.isError || probe.data) return;
    autoTested.current = true;
    probe.mutate(server.name);
  }, [open, remembers, last, probe, server.name]);
  // What the page shows: the kept test, or (a hub that keeps none) this page's own.
  const failure =
    remembers && last
      ? last.ok
        ? null
        : last.error
      : probe.data && !probe.data.ok
        ? probe.data.error
        : null;
  // Hermes said the server wants a sign-in: offer it where the failure is read (§122).
  const signInHere =
    failure !== null && offersOAuth(server) && needsOAuth(failure) ? (
      <>
        <span className="text-sm">{t('mcp.oauth.test_needs')}</span>
        <Button
          size="sm"
          variant="primary"
          data-testid={`mcp-test-connect-${server.name}`}
          onClick={() => {
            probe.reset();
            oauth.connect();
          }}
        >
          {t('mcp.oauth.connect')}
        </Button>
      </>
    ) : null;
  const address = summarise(server);

  // The header is the folded row: switch, the name (the button that opens it), Test, Edit and
  // Delete. Everything that changes a sign-in lives under it, where a stray press cannot reach.
  return (
    <div
      className="mcp-card"
      data-enabled={server.enabled || undefined}
      data-open={open}
      data-testid={`mcp-row-${server.name}`}
    >
      <div className="skill-row mcp-card-head">
        <Switch
          checked={server.enabled}
          label={t('mcp.enabled')}
          labelHidden
          testId={`mcp-toggle-${server.name}`}
          onChange={(next) => update.mutate({ name: server.name, enabled: next })}
        />
        <button
          type="button"
          className="skill-open mcp-card-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`mcp-expand-${server.name}`}
          onClick={() => setOpen(!open)}
        >
          <span className="flex items-center gap-2">
            <IconChevron size={14} className="mcp-chevron" />
            <span className="font-medium" dir="ltr">
              {server.name}
            </span>
            <Badge>{server.transport}</Badge>
            <McpOAuthChip server={server} />
            <ToolCount server={server} />
          </span>
          <span className="skill-description" dir="ltr">
            {address}
          </span>
        </button>
        {hermes && (
          <Button
            size="sm"
            variant="secondary"
            disabled={probe.isPending}
            data-testid={`mcp-test-${server.name}`}
            onClick={runTest}
          >
            {probe.isPending ? t('mcp.test.running') : t('mcp.test.button')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<IconEdit size={14} />}
          data-testid={`mcp-edit-${server.name}`}
          onClick={onEdit}
        >
          {t('common.edit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('common.delete')}
          data-testid={`mcp-delete-${server.name}`}
          onClick={() => {
            void ask({
              title: t('mcp.delete_title', { name: server.name }),
              body: t('mcp.delete_body'),
              confirmLabel: t('common.delete'),
            }).then((yes) => {
              if (yes) remove.mutate(server.name, { onSuccess: () => writeExpanded(key, null) });
            });
          }}
        >
          <IconTrash size={14} />
        </Button>
        {dialog}
      </div>
      {(update.isError || remove.isError) && (
        <Notice tone="danger">{describeToolError(update.error ?? remove.error, t)}</Notice>
      )}
      {/* Folded, the part stays mounted (hidden): a sign-in in flight keeps its progress and
          still runs its test by itself when it lands. */}
      <div
        id={bodyId}
        className="mcp-card-body"
        hidden={!open}
        data-testid={`mcp-details-${server.name}`}
      >
        {address && (
          <dl className="mcp-card-address">
            <dt className="text-xs text-muted">
              {typeof server.config.url === 'string' ? t('mcp.address') : t('mcp.command')}
            </dt>
            <dd dir="ltr">
              <code>{address}</code>
            </dd>
          </dl>
        )}
        {server.error && (
          <Notice tone="danger">
            <span dir="auto">{server.error}</span>
          </Notice>
        )}
        {probe.isError && (
          <div data-testid={`mcp-test-result-${server.name}`} data-ok="false">
            <Notice tone="danger">{describeToolError(probe.error, t)}</Notice>
          </div>
        )}
        {remembers && (last || probe.isPending) ? (
          <McpToolsPanel
            agentId={agentId}
            server={server}
            testing={probe.isPending}
            failureAction={signInHere}
          />
        ) : (
          probe.data && <TestResult name={server.name} result={probe.data} action={signInHere} />
        )}
        <McpOAuthControls
          agentId={agentId}
          server={server}
          oauth={oauth}
          onTest={() => probe.mutate(server.name)}
        />
      </div>
    </div>
  );
}

/** The folded row's count of tools, from the kept test; a failed one says so instead. */
function ToolCount({ server }: { server: McpServer }) {
  const { t } = useI18n();
  const last = server.last_test;
  if (!last) return null;
  if (!last.ok) {
    return (
      <Badge tone="danger" testId={`mcp-tool-count-${server.name}`}>
        {t('mcp.tools.failed_badge')}
      </Badge>
    );
  }
  const label = toolCountLabel(server, t);
  return label ? (
    <Badge tone={last.stale ? 'warning' : 'neutral'} testId={`mcp-tool-count-${server.name}`}>
      {label}
    </Badge>
  ) : null;
}

/**
 * A row that starts open: Hermes reported an error for it, or its sign-in ran out, went
 * unreadable, or was never made for a server that requires one.
 */
function needsAttention(server: McpServer): boolean {
  if (server.error) return true;
  const oauth = server.oauth;
  if (!oauth || !offersOAuth(server)) return false;
  if (oauth.status === 'connected') return false;
  if (oauth.status === 'not_connected') return oauth.required;
  return true;
}

/** One line a person can recognise the server by: what it runs, or where it points. */
function summarise(server: McpServer): string {
  const config = server.config;
  if (typeof config.url === 'string') return config.url;
  const command = typeof config.command === 'string' ? config.command : '';
  const args = Array.isArray(config.args) ? config.args.join(' ') : '';
  return [command, args].filter(Boolean).join(' ');
}

function ServerEditor({
  agentId,
  hermes,
  server,
  taken,
  onSignInStarted,
  onClose,
}: {
  agentId: string | undefined;
  hermes: boolean;
  server: McpServer | null;
  taken: readonly string[];
  onSignInStarted: (name: string, flow: McpOAuthFlow) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // A new server is added one of two ways: its JSON as before, or signed in by its address.
  const [mode, setMode] = useState<'json' | 'signin'>('json');
  const signingIn = !server && mode === 'signin';
  const create = useCreateMcpServer(agentId);
  const update = useUpdateMcpServer(agentId);
  const [name, setName] = useState(server?.name ?? '');
  const [draft, setDraft] = useState<string | null>(null);
  const stored = server ? JSON.stringify(omitEnabled(server.config), null, 2) : TEMPLATE;
  const text = draft ?? stored;
  const parsed = parse(text);
  const badName = name !== '' && !/^[A-Za-z0-9._-]{1,60}$/.test(name);
  const pending = create.isPending || update.isPending;

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={server ? server.name : t('mcp.new')}
      description={signingIn ? t('mcp.signin_add.note') : t('mcp.editor_note')}
      closeLabel={t('common.cancel')}
      testId="mcp-editor"
      footer={
        signingIn ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={name === '' || badName || !parsed.ok || pending}
              data-testid="save-mcp"
              onClick={() => {
                if (!parsed.ok) return;
                if (server) update.mutate({ name, config: parsed.value }, { onSuccess: onClose });
                else
                  create.mutate(
                    {
                      name,
                      // The shape decides: a `url` is a socket, a `command` is a process.
                      transport: typeof parsed.value.url === 'string' ? 'http' : 'stdio',
                      enabled: true,
                      config: parsed.value,
                    },
                    { onSuccess: onClose },
                  );
              }}
            >
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!server && hermes && (
          <Segmented
            label={t('mcp.signin_add.how')}
            value={mode}
            onChange={(value: string) => setMode(value === 'signin' ? 'signin' : 'json')}
            size="sm"
            testId="mcp-add-mode"
            options={[
              { value: 'json', label: t('mcp.signin_add.mode_json') },
              { value: 'signin', label: t('mcp.signin_add.mode_signin') },
            ]}
          />
        )}
        {signingIn && (
          <McpSignInForm
            agentId={agentId}
            taken={taken}
            onStarted={onSignInStarted}
            onCancel={onClose}
          />
        )}
        {!signingIn && !server && (
          <Field label={t('mcp.name')} {...(badName ? { error: t('mcp.name_bad') } : {})}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                placeholder="filesystem"
                value={name}
                invalid={badName}
                onChange={(event) => setName(event.target.value)}
                data-testid="mcp-name"
              />
            )}
          </Field>
        )}
        {!signingIn && (
          <>
            <Textarea
              rows={14}
              dir="ltr"
              className="skill-editor"
              aria-label={t('mcp.config')}
              value={text}
              onChange={(event) => setDraft(event.target.value)}
              data-testid="mcp-config"
            />
            {/* Said while typing, not after saving: a bracket in the wrong place is worth
                knowing about before the button is pressed. */}
            {!parsed.ok && <Notice tone="warning">{t('mcp.invalid_json')}</Notice>}
            {(create.isError || update.isError) && (
              <Notice tone="danger">{describeToolError(create.error ?? update.error, t)}</Notice>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** `enabled` is the switch in the row, not a field in the document. */
function omitEnabled(config: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = config;
  return rest;
}

function parse(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
