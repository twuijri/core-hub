/**
 * «أدوات كور هب» / "Core Hub tools": the hub offers itself to this agent as an MCP server, in
 * groups (contract decision §67).
 *
 * **Off until an admin switches it on.** On, every group reads and none writes; each group's
 * writes are a second, separate switch — creating a task, pausing a schedule, telling the
 * person — so nothing acts on the person's behalf that nobody chose.
 *
 * **Whose hands.** The card says it plainly: a call acts for the person whose conversation it
 * is, in this profile only, never as an admin. A message arriving from a channel has no such
 * person, so the tools refuse there; the recent calls show that too, with the hub's reason.
 *
 * **Test asks Hermes**, exactly as on a server row: Hermes connects to the block the hub wrote
 * and lists the tools it was offered.
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Card, CardHeader, Notice, Switch } from '../ui/index.js';
import { TestResult } from './McpTestResultView.js';
import { describeToolError } from './toolErrors.js';
import {
  useHubTools,
  useTestMcpServer,
  useUpdateHubTools,
  type HubToolCall,
  type HubToolGroup,
} from './skills.js';
import { intlLocale } from '../i18n/index.js';

export function HubToolsCard({ agentId }: { agentId: string | undefined }) {
  const { t } = useI18n();
  const settings = useHubTools(agentId);
  const update = useUpdateHubTools(agentId);
  const probe = useTestMcpServer(agentId);
  const product = t('app.name');
  // A hub older than the card answers something else here; the card then shows nothing.
  const data = Array.isArray(settings.data?.groups) ? settings.data : undefined;

  return (
    <Card testId="hub-tools" data-enabled={data?.enabled || undefined}>
      <CardHeader
        title={t('hub_tools.title', { product })}
        subtitle={t('hub_tools.subtitle', { product })}
        actions={
          data && (
            <Switch
              checked={data.enabled}
              disabled={update.isPending || (!data.available && !data.enabled)}
              label={t('hub_tools.enabled')}
              labelHidden
              testId="hub-tools-toggle"
              onChange={(next) => update.mutate({ enabled: next })}
            />
          )
        }
      />
      <div className="flex flex-col gap-3">
        {settings.isError && <Notice tone="danger">{describeToolError(settings.error, t)}</Notice>}
        {data && !data.available && (
          <Notice tone="warning">
            {t(`hub_tools.unavailable.${data.unavailable_reason ?? 'runtime_absent'}`)}
          </Notice>
        )}
        {data && (
          <p className="text-sm text-muted" data-testid="hub-tools-acts-as">
            {t('hub_tools.acts_as')}
          </p>
        )}
        {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}

        {data && (
          <ul className="flex flex-col gap-2" data-testid="hub-tools-groups">
            {data.groups.map((group) => (
              <li key={group.id}>
                <GroupRow
                  group={group}
                  disabled={!data.enabled || update.isPending}
                  onChange={(change) => update.mutate({ groups: [{ id: group.id, ...change }] })}
                />
              </li>
            ))}
          </ul>
        )}

        {data && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!data.enabled || probe.isPending}
              data-testid="hub-tools-test"
              onClick={() => probe.mutate(data.server_name)}
            >
              {probe.isPending ? t('mcp.test.running') : t('mcp.test.button')}
            </Button>
            {data.url && (
              <span className="text-xs text-muted" dir="ltr">
                {data.url}
              </span>
            )}
          </div>
        )}
        {probe.isError && (
          <div data-testid={`mcp-test-result-${data?.server_name ?? 'corehub'}`} data-ok="false">
            <Notice tone="danger">{describeToolError(probe.error, t)}</Notice>
          </div>
        )}
        {probe.data && data && <TestResult name={data.server_name} result={probe.data} />}

        {data && <RecentCalls calls={data.recent_calls} />}
      </div>
    </Card>
  );
}

function GroupRow({
  group,
  disabled,
  onChange,
}: {
  group: HubToolGroup;
  disabled: boolean;
  onChange(change: { enabled?: boolean; allow_writes?: boolean }): void;
}) {
  const { t } = useI18n();
  const writes = group.tools.some((tool) => tool.access === 'write');
  const reads = group.tools.some((tool) => tool.access === 'read');
  return (
    <div
      className="skill-row"
      data-enabled={group.enabled || undefined}
      data-testid={`hub-group-${group.id}`}
    >
      <Switch
        checked={group.enabled}
        disabled={disabled}
        label={t(`hub_tools.group.${group.id}`)}
        labelHidden
        testId={`hub-group-toggle-${group.id}`}
        onChange={(next) => onChange({ enabled: next })}
      />
      <div className="skill-open">
        <span className="font-medium">{t(`hub_tools.group.${group.id}`)}</span>
        <span className="skill-description">{t(`hub_tools.group_about.${group.id}`)}</span>
        <ul className="mt-1 flex flex-wrap gap-1" dir="ltr">
          {group.tools.map((tool) => (
            <li key={tool.name}>
              <Badge tone={tool.access === 'write' ? 'warning' : 'neutral'}>{tool.name}</Badge>
            </li>
          ))}
        </ul>
        {!reads && <span className="text-xs text-muted">{t('hub_tools.writes_only')}</span>}
      </div>
      {writes && (
        <Switch
          checked={group.allow_writes}
          disabled={disabled || !group.enabled}
          label={t('hub_tools.allow_writes')}
          testId={`hub-group-writes-${group.id}`}
          onChange={(next) => onChange({ allow_writes: next })}
        />
      )}
    </div>
  );
}

function RecentCalls({ calls }: { calls: HubToolCall[] }) {
  const { t, language } = useI18n();
  const when = new Intl.DateTimeFormat(intlLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
  // The hub's own reasons read as sentences; any other code (a REST refusal) as itself.
  const reason = (code: string): string => {
    const key = `hub_tools.reason.${code}`;
    const text = t(key);
    return text === key ? code : text;
  };
  return (
    <section className="flex flex-col gap-1" data-testid="hub-tools-calls">
      <h4 className="text-sm font-medium">{t('hub_tools.recent')}</h4>
      {calls.length === 0 ? (
        <p className="text-sm text-muted">{t('hub_tools.no_calls')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {calls.map((call) => (
            <li
              key={call.id}
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="hub-tools-call"
              data-ok={call.ok ? 'true' : 'false'}
            >
              <Badge tone={call.ok ? 'success' : 'danger'}>
                {call.ok ? t('hub_tools.call_ok') : t('hub_tools.call_failed')}
              </Badge>
              <span dir="ltr" className="font-medium">
                {call.tool}
              </span>
              {call.error_code && <span className="text-muted">{reason(call.error_code)}</span>}
              <span className="text-xs text-muted ms-auto">
                {when.format(new Date(call.created_at))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
