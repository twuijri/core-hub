/**
 * What Hermes found when it tested an MCP server: the tools it listed, or why it could not
 * connect, in its words. Shared by the server rows and the hub's own tools card.
 */
import { useI18n } from '../i18n/context.js';
import { Badge, Notice, Tooltip } from '../ui/index.js';
import type { McpTestResult } from './skills.js';

/** What Hermes found: the tools it listed, or why it could not connect, in its words. */
export function TestResult({ name, result }: { name: string; result: McpTestResult }) {
  const { t } = useI18n();
  if (!result.ok) {
    return (
      <div data-testid={`mcp-test-result-${name}`} data-ok="false">
        <Notice tone="danger">
          <span className="font-medium">{t('mcp.test.failed')}</span>{' '}
          <span dir="auto">{result.error}</span>
        </Notice>
      </div>
    );
  }
  return (
    <div data-testid={`mcp-test-result-${name}`} data-ok="true">
      <Notice tone="success">
        <span className="font-medium">
          {t('mcp.test.ok', {
            count: String(result.tools.length),
            seconds: (result.duration_ms / 1000).toFixed(1),
          })}
        </span>
        {result.tools.length === 0 ? (
          <span> {t('mcp.test.no_tools')}</span>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1" dir="ltr">
            {result.tools.map((tool) => (
              <li key={tool.name}>
                <Tooltip label={tool.description ?? ''}>
                  <span>
                    <Badge>{tool.name}</Badge>
                  </span>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </Notice>
    </div>
  );
}
