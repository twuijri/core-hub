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
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { describeError } from '../auth/client.js';
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
  Skeleton,
  SkeletonGroup,
  Switch,
  Textarea,
  useConfirm,
} from '../ui/index.js';
import { IconTool, IconTrash } from '../ui/icons.js';
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useHubTools,
  useMcpServers,
  useTestMcpServer,
  useUpdateMcpServer,
  type McpServer,
} from './skills.js';
import { describeToolError } from './toolErrors.js';
import { HubToolsCard } from './HubToolsCard.js';
import { TestResult } from './McpTestResultView.js';

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

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('mcp.title_of', { name: agent.name }) : t('nav.agent_mcp');
  // The hub's own block is the card's (contract decision §58), not a row to edit here.
  const hubTools = useHubTools(agentId);
  const managed = hubTools.data?.server_name ?? 'corehub';
  const items = (servers.data?.items ?? []).filter((server) => server.name !== managed);

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {items.length > 0 && <Badge>{String(items.length)}</Badge>}
          <Button
            className="ms-auto"
            size="sm"
            onClick={() => setEditing(null)}
            data-testid="new-mcp"
          >
            {t('mcp.new')}
          </Button>
        </div>
        <Notice>{t('mcp.restart_note')}</Notice>
        <HubToolsCard agentId={agentId} />

        {servers.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {servers.isError && <Notice tone="danger">{describeToolError(servers.error, t)}</Notice>}
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
                  <ServerRow agentId={agentId} server={server} onEdit={() => setEditing(server)} />
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing !== undefined && (
        <ServerEditor agentId={agentId} server={editing} onClose={() => setEditing(undefined)} />
      )}
    </AppShell>
  );
}

function ServerRow({
  agentId,
  server,
  onEdit,
}: {
  agentId: string | undefined;
  server: McpServer;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateMcpServer(agentId);
  const remove = useDeleteMcpServer(agentId);
  const probe = useTestMcpServer(agentId);
  const { ask, dialog } = useConfirm();

  return (
    <div className="flex flex-col gap-2">
      <div className="skill-row" data-enabled={server.enabled || undefined}>
        <Switch
          checked={server.enabled}
          label={t('mcp.enabled')}
          labelHidden
          testId={`mcp-toggle-${server.name}`}
          onChange={(next) => update.mutate({ name: server.name, enabled: next })}
        />
        <button type="button" className="skill-open" onClick={onEdit}>
          <span className="flex items-center gap-2">
            <span className="font-medium" dir="ltr">
              {server.name}
            </span>
            <Badge>{server.transport}</Badge>
          </span>
          <span className="skill-description" dir="ltr">
            {summarise(server)}
          </span>
        </button>
        <Button
          size="sm"
          variant="secondary"
          disabled={probe.isPending}
          data-testid={`mcp-test-${server.name}`}
          onClick={() => probe.mutate(server.name)}
        >
          {probe.isPending ? t('mcp.test.running') : t('mcp.test.button')}
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
              if (yes) remove.mutate(server.name);
            });
          }}
        >
          <IconTrash size={14} />
        </Button>
        {dialog}
      </div>
      {probe.isError && (
        <div data-testid={`mcp-test-result-${server.name}`} data-ok="false">
          <Notice tone="danger">{describeToolError(probe.error, t)}</Notice>
        </div>
      )}
      {probe.data && <TestResult name={server.name} result={probe.data} />}
    </div>
  );
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
  server,
  onClose,
}: {
  agentId: string | undefined;
  server: McpServer | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
      description={t('mcp.editor_note')}
      closeLabel={t('common.cancel')}
      testId="mcp-editor"
      footer={
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
      }
    >
      <div className="flex flex-col gap-3">
        {!server && (
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
          <Notice tone="danger">{describeError(create.error ?? update.error, t)}</Notice>
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
