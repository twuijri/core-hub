/**
 * What a failed run says to the person.
 *
 * Two shapes, decided by the envelope's `code` and nothing else:
 *
 * - `provider_not_configured` — the one failure the hub knows the way out of. Our own
 *   sentence and a link straight to Settings → Models → Defaults come first, and the
 *   agent's own words stay underneath. They are never replaced and never hidden: they are
 *   what says *which* provider refused, and a person who reads them can act on them even
 *   when our guess about the cause is wrong.
 * - a coding agent's failure the hub recognises (owner, 2026-09-29): Goose with no provider set,
 *   Claude Code / Codex / Gemini CLI with no key or sign-in, an agent that needs its own
 *   account sign-in — our sentence naming the agent, one action where the hub has one (its
 *   Config files, Settings → Models, its sign-in), and the agent's own words underneath, which
 *   the hub now carries in full (`describeAcpError`). An agent whose card already says it has
 *   nothing to answer with (`credentials: missing`) gets its guidance whatever the words.
 * - everything else — the existing one line, the agent's message with its code.
 *
 * A component of its own because the choice between them is the whole point of the
 * change of 2026-09-22 and deserves a test that does not have to boot a chat screen.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { RuntimeChecks } from '../models/RuntimeChecks.js';
import { agentRoute, routeOf } from '../navigation/manifest.js';
import type { Agent, Message, Run, RuntimeReport } from '../types.js';
import { Button } from '../ui/index.js';
import { IconClose } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { sideOf } from './turns.js';
import { textOf } from './transcript.js';

export interface RunFailure {
  code: string;
  error: string;
  /** Code-specific details (`Run.error.details`); a spent quota names its provider and model. */
  details?: Record<string, unknown> | undefined;
}

/**
 * A spent quota the hub's model gateway recognised (ADR 0029): which provider and which model,
 * as people know them. `null` for anything else, or an older hub's run that says only the words.
 */
export function quotaOf(failure: RunFailure): { provider: string; model: string } | null {
  const details = failure.details;
  if (failure.code !== 'rate_limited' || details?.reason !== 'quota_exhausted') return null;
  const { provider, model } = details;
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : null;
}

/** The Defaults tab of the Models screen, by name — no client invents a path. */
export const DEFAULTS_ROUTE = `${routeOf('models')}?tab=auxiliary`;

type HelpAction = 'config_files' | 'models' | 'sign_in';

/** What each coding agent's known failures mean, by the words the agent and its bridge use. */
const AUTH = /auth|log ?in|sign ?in|api[ _-]?key|credential|unauthori[sz]ed|\b40[13]\b/i;
const AGENT_HELP: Readonly<Record<string, { match: RegExp; key: string; action: HelpAction }>> = {
  goose: {
    match: /provider|GOOSE_PROVIDER|GOOSE_MODEL|configure|internal error/i,
    key: 'goose_provider',
    action: 'config_files',
  },
  'claude-code': { match: AUTH, key: 'claude_auth', action: 'models' },
  codex: { match: /OPENAI_API_KEY|chatgpt/i, key: 'codex_auth', action: 'models' },
  'gemini-cli': { match: /GEMINI_API_KEY|GOOGLE_API_KEY/i, key: 'gemini_auth', action: 'models' },
  'qwen-code': { match: AUTH, key: 'provider_auth', action: 'models' },
  opencode: { match: AUTH, key: 'provider_auth', action: 'models' },
  pi: { match: AUTH, key: 'provider_auth', action: 'models' },
};

export interface AgentHelp {
  key: string;
  action: HelpAction | null;
}

/**
 * The guidance for a coding agent's failed run, or `null` when the hub does not recognise it.
 * An agent with its own account sign-in (Kimi, Grok) is sent to it; one whose card says it
 * has no key or sign-in (`credentials: missing`) gets its guidance whatever the words.
 */
export function agentHelp(
  agent: Pick<Agent, 'slug' | 'kind' | 'credentials' | 'install'> | undefined,
  failure: RunFailure,
): AgentHelp | null {
  if (!agent || agent.kind !== 'acp') return null;
  if (failure.code !== 'agent_error' && failure.code !== 'provider_unauthorized') return null;
  const text = failure.error ?? '';
  if (agent.install.sign_in && AUTH.test(text)) return { key: 'sign_in', action: 'sign_in' };
  const known = AGENT_HELP[agent.slug];
  const missing = agent.credentials === 'missing';
  if (known && (missing || known.match.test(text) || AUTH.test(text))) {
    return { key: known.key, action: known.action };
  }
  if (missing) return { key: 'provider_auth', action: 'models' };
  return null;
}

function helpRoute(action: HelpAction, agentId: string): string {
  if (action === 'config_files') return agentRoute('agent_config_files', agentId);
  if (action === 'sign_in') return agentRoute('agent_settings', agentId);
  return routeOf('models');
}

/**
 * Which message each failed run's notice hangs under (owner, 2026-09-25: «الخطا يبتل ما
 * يروح» — a failure stayed above the composer after the next run had succeeded).
 *
 * A failure belongs to the turn that failed, never to the conversation: it is drawn under
 * that run's reply, or — when the run failed before the agent wrote anything — under the
 * person's message that started it. A later run, failed or not, leaves it where it is and
 * adds nothing near the composer. `runs` is every run known: the session's live ones and
 * its failed history (`sessions.listRuns?status=failed`), so a reload keeps it in place.
 *
 * A failed reply that already says something in the agent's own words needs no second
 * line — except `provider_not_configured`, whose way out the agent's text never gives.
 */
export function failuresByMessage(
  messages: readonly Message[],
  runs: Iterable<Run>,
): Map<string, { runId: string; failure: RunFailure }> {
  const out = new Map<string, { runId: string; failure: RunFailure }>();
  for (const run of runs) {
    if (run.status !== 'failed' || !run.error) continue;
    const reply = messages.findLast(
      (m) => sideOf(m) === 'agent' && (m.id === run.output_message_id || m.run_id === run.id),
    );
    const target =
      reply ??
      messages.findLast(
        (m) => sideOf(m) === 'user' && (m.id === run.input_message_id || m.run_id === run.id),
      );
    // Not in the transcript held (an older page): nothing is drawn, and nothing elsewhere.
    if (!target) continue;
    const { code, error } = run.error;
    const details = (run.error as { details?: Record<string, unknown> }).details;
    const failure: RunFailure = { code, error, ...(details ? { details } : {}) };
    // A spent quota is said even under a reply: the agent's own words for it are an API error.
    if (
      code !== 'provider_not_configured' &&
      !quotaOf(failure) &&
      reply &&
      textOf(reply).trim() !== ''
    ) {
      continue;
    }
    out.set(target.id, { runId: run.id, failure });
  }
  return out;
}

export function RunFailureNotice({
  failure,
  runtime,
  agent,
  onDismiss,
  onPickModel,
}: {
  failure: RunFailure;
  /** The conversation's agent: a coding agent's known failures get their way out. */
  agent?: Pick<Agent, 'id' | 'slug' | 'name' | 'kind' | 'credentials' | 'install'> | undefined;
  /**
   * Which step of propagation is missing, read now rather than remembered from when the
   * run failed — the person may already have fixed half of it in another tab. Passed in
   * rather than fetched here so this component stays a pure rendering of one decision.
   */
  runtime?: RuntimeReport | undefined;
  /** Hides it in this view; the failed turn shows it again after a reload. */
  onDismiss?: (() => void) | undefined;
  /** Opens the conversation's model picker (a spent quota's way on). */
  onPickModel?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const dismiss: ReactNode = onDismiss ? (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      className="float-end -me-1 -mt-0.5"
      aria-label={t('ui.dismiss')}
      tooltip={t('ui.dismiss')}
      icon={<IconClose size={14} />}
      onClick={onDismiss}
      data-testid="run-failed-dismiss"
    />
  ) : null;
  const quota = quotaOf(failure);
  if (quota) {
    return (
      <Notice tone="danger" className="run-failure space-y-1" testId="run-failed-quota">
        {dismiss}
        <p data-testid="run-failed-reason" dir="auto">
          {t('chat.quota_exhausted', { provider: quota.provider, model: quota.model })}
        </p>
        {onPickModel && (
          <p>
            <Button
              variant="secondary"
              size="sm"
              onClick={onPickModel}
              data-testid="run-failed-pick-model"
            >
              {t('chat.quota_pick_model')}
            </Button>
          </p>
        )}
      </Notice>
    );
  }
  const help = agentHelp(agent, failure);
  if (help && agent) {
    const actionLabel =
      help.action === 'config_files'
        ? t('chat.agent_help.open_config_files', { name: agent.name })
        : help.action === 'sign_in'
          ? t('chat.agent_help.open_sign_in', { name: agent.name })
          : t('chat.agent_help.open_models');
    return (
      <Notice tone="danger" className="run-failure space-y-1" testId="run-failed-agent-help">
        {dismiss}
        <p data-testid="run-failed-reason">
          {t(`chat.agent_help.${help.key}`, { name: agent.name })}
        </p>
        {help.action && (
          <p>
            <Link
              to={helpRoute(help.action, agent.id)}
              className="link underline"
              data-testid="run-failed-action"
            >
              {actionLabel}
            </Link>
          </p>
        )}
        <p className="text-xs opacity-80" data-testid="run-failed-detail" dir="auto">
          {t('chat.agent_help.agent_said', { name: agent.name })} {failure.error}
        </p>
      </Notice>
    );
  }
  if (failure.code !== 'provider_not_configured') {
    return (
      <Notice tone="danger" className="run-failure">
        {dismiss}
        {t('chat.run_failed', { error: failure.error, code: failure.code })}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" className="run-failure space-y-1">
      {dismiss}
      <p data-testid="run-failed-reason">{t('chat.no_provider')}</p>
      <p>
        <Link to={DEFAULTS_ROUTE} className="link underline" data-testid="run-failed-action">
          {t('chat.no_provider_action')}
        </Link>
      </p>
      {runtime && <RuntimeChecks report={runtime} only="failing" />}
      <p className="text-xs opacity-80" data-testid="run-failed-detail">
        {failure.error}
      </p>
    </Notice>
  );
}
