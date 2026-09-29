/**
 * An MCP server's tools, from the last test the hub kept (DECISIONS §134), and which of them the
 * agent may use.
 *
 * **No Test press to see them.** The list is the hub's memory of the last test in this profile,
 * with when it was made; a server edited since says the list may be old. A test that failed says
 * why, in Hermes's words.
 *
 * **A box per tool.** Ticked is allowed. All, None and Read-only set every box at once; Read-only
 * ticks the tools the hub reads as only looking — by the server's own `readOnlyHint` when Hermes
 * recorded one, otherwise by the verbs in the name — and each tool shows which it is, so the
 * person can correct it before saving. Saving writes Hermes's own `tools.include` /
 * `tools.exclude` (`mcpToolFilter.ts` says which), and the note under the list says what that
 * means for a tool the server adds later.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { describeError } from '../auth/client.js';
import { relativeTime, exactTime } from '../devices/format.js';
import { useI18n } from '../i18n/context.js';
import type { Translator } from '../i18n/index.js';
import { Badge, Button, Checkbox, Input, Notice, Spinner, Tooltip } from '../ui/index.js';
import { IconSearch } from '../ui/icons.js';
import {
  NO_FILTER,
  allowedBy,
  filterToSave,
  hasFilter,
  initialAllowed,
  lockedBy,
  preset,
  sameFilter,
  withLocks,
} from './mcpToolFilter.js';
import { useUpdateMcpServer, type McpServer, type McpToolAccess } from './skills.js';

/** Past this many tools the list gets a search box. */
const SEARCH_FROM = 8;

const ACCESS_TONE: Record<McpToolAccess, 'success' | 'warning' | 'neutral'> = {
  read: 'success',
  write: 'warning',
  unknown: 'neutral',
};

/** "61 tools" or "12 of 61 tools" for the folded row; null when there is no list to count. */
export function toolCountLabel(server: McpServer, t: Translator): string | null {
  const last = server.last_test;
  if (!last?.ok) return null;
  const total = last.tools.length;
  if (!hasFilter(server.tool_filter)) return t('mcp.tools.count', { count: String(total) });
  const allowed = last.tools.filter((tool) => allowedBy(server.tool_filter, tool.name)).length;
  return t('mcp.tools.count_filtered', { allowed: String(allowed), total: String(total) });
}

export function McpToolsPanel({
  agentId,
  server,
  testing,
  failureAction,
}: {
  agentId: string | undefined;
  server: McpServer;
  /** A test is running (the header's Test, or the one the first opening started). */
  testing: boolean;
  /** Under a failed test: the OAuth sign-in when Hermes said the server wants one (§122). */
  failureAction?: ReactNode;
}) {
  const { t, language } = useI18n();
  const last = server.last_test ?? null;
  const name = server.name;

  if (!last) {
    return testing ? (
      <div data-testid={`mcp-tools-testing-${name}`}>
        <Spinner label={t('mcp.tools.auto_testing')} />
      </div>
    ) : null;
  }

  const when = (
    <Tooltip label={exactTime(last.tested_at, language)}>
      <span className="text-xs text-muted" data-testid={`mcp-tested-at-${name}`}>
        {t('mcp.tools.tested_at', { when: relativeTime(last.tested_at, Date.now(), language) })}
      </span>
    </Tooltip>
  );

  return (
    <div className="mcp-tools" data-testid={`mcp-test-result-${name}`} data-ok={String(last.ok)}>
      {testing && <Spinner label={t('mcp.test.running')} />}
      {last.stale && (
        <Notice tone="warning" testId={`mcp-tools-stale-${name}`}>
          {t('mcp.tools.stale')}
        </Notice>
      )}
      {last.ok ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {t('mcp.test.ok', {
                count: String(last.tools.length),
                seconds: (last.duration_ms / 1000).toFixed(1),
              })}
            </span>
            {when}
          </div>
          {last.tools.length === 0 ? (
            <span className="text-sm text-muted">{t('mcp.test.no_tools')}</span>
          ) : (
            <ToolPicker agentId={agentId} server={server} />
          )}
        </>
      ) : (
        <Notice tone="danger">
          <span className="font-medium">{t('mcp.test.failed')}</span>{' '}
          <span dir="auto">{last.error}</span> {when}
          {failureAction ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">{failureAction}</div>
          ) : null}
        </Notice>
      )}
    </div>
  );
}

function ToolPicker({ agentId, server }: { agentId: string | undefined; server: McpServer }) {
  const { t } = useI18n();
  const update = useUpdateMcpServer(agentId);
  const tools = useMemo(() => server.last_test?.tools ?? [], [server.last_test]);
  const filter = server.tool_filter ?? NO_FILTER;
  const saved = useMemo(() => initialAllowed(filter, tools), [filter, tools]);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const allowed = draft ?? saved;
  const next = filterToSave(filter, tools, allowed);
  const dirty = draft !== null && !sameFilter(next, filter);
  const name = server.name;

  const choose = (set: Set<string>) => {
    setJustSaved(false);
    setDraft(withLocks(filter, tools, set));
  };
  const toggle = (tool: string, on: boolean) => {
    const set = new Set(allowed);
    if (on) set.add(tool);
    else set.delete(tool);
    choose(set);
  };

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(needle) ||
          (tool.description ?? '').toLowerCase().includes(needle),
      )
    : tools;
  const note =
    next.include !== null
      ? t('mcp.tools.note_include')
      : next.exclude !== null
        ? t('mcp.tools.note_exclude')
        : t('mcp.tools.note_all');

  return (
    <div className="mcp-tools-picker" data-testid={`mcp-tools-${name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('mcp.tools.heading')}</span>
        <Badge testId={`mcp-tools-allowed-${name}`}>
          {t('mcp.tools.allowed', {
            allowed: String(tools.filter((tool) => allowed.has(tool.name)).length),
            total: String(tools.length),
          })}
        </Badge>
        <span className="ms-auto flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="secondary"
            data-testid={`mcp-tools-all-${name}`}
            onClick={() => choose(preset('all', tools))}
          >
            {t('mcp.tools.all')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid={`mcp-tools-none-${name}`}
            onClick={() => choose(preset('none', tools))}
          >
            {t('mcp.tools.none')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid={`mcp-tools-read-${name}`}
            onClick={() => choose(preset('read', tools))}
          >
            {t('mcp.tools.read_only')}
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted">{t('mcp.tools.read_only_hint')}</p>
      {tools.length > SEARCH_FROM && (
        <Input
          inputSize="sm"
          icon={<IconSearch size={14} />}
          aria-label={t('mcp.tools.search')}
          placeholder={t('mcp.tools.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid={`mcp-tools-search-${name}`}
        />
      )}
      <ul className="mcp-tools-list">
        {shown.map((tool) => {
          const lock = lockedBy(filter, tool.name);
          return (
            <li key={tool.name} data-testid={`mcp-tool-${name}-${tool.name}`}>
              <Checkbox
                checked={allowed.has(tool.name)}
                disabled={lock !== null}
                testId={`mcp-tool-check-${name}-${tool.name}`}
                onChange={(on) => toggle(tool.name, on)}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <code dir="ltr">{tool.name}</code>
                    <Tooltip
                      label={
                        tool.access_source === 'annotation'
                          ? t('mcp.tools.access_annotation')
                          : t('mcp.tools.access_name')
                      }
                    >
                      <span data-access={tool.access} data-source={tool.access_source}>
                        <Badge tone={ACCESS_TONE[tool.access]}>
                          {t(`mcp.tools.access.${tool.access}`)}
                        </Badge>
                      </span>
                    </Tooltip>
                  </span>
                }
                hint={
                  <>
                    {tool.description ? <span dir="auto">{tool.description}</span> : null}
                    {lock ? (
                      <span className="block">{t('mcp.tools.locked', { pattern: lock })}</span>
                    ) : null}
                  </>
                }
              />
            </li>
          );
        })}
        {shown.length === 0 && <li className="text-sm text-muted">{t('mcp.tools.no_match')}</li>}
      </ul>
      <p className="text-xs text-muted" data-testid={`mcp-tools-note-${name}`}>
        {note}
      </p>
      {dirty && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={update.isPending}
            data-testid={`mcp-tools-save-${name}`}
            onClick={() =>
              update.mutate(
                { name, tool_filter: next },
                {
                  onSuccess: () => {
                    setDraft(null);
                    setJustSaved(true);
                  },
                },
              )
            }
          >
            {t('common.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {t('mcp.tools.undo')}
          </Button>
        </div>
      )}
      {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
      {justSaved && !dirty && (
        <Notice tone="success" testId={`mcp-tools-saved-${name}`}>
          {t('mcp.tools.saved')}
        </Notice>
      )}
    </div>
  );
}
