/**
 * A "Send message" step's targets (DECISIONS §124): Telegram — a chat id, sent by the
 * profile's own bot — and/or a conversation of this hub the words are posted in. "Send test
 * message" sends the step's words now, to the same targets, and says what each one did. The
 * same targets say where a workflow's failure alert goes (§127).
 *
 * The words are a template: before a test is sent, each variable (`{{steps.analysis.output}}`)
 * needs a value — typed, or taken from the workflow's last run — and the preview shows the
 * text that will go. Send stays off while any is empty, and the hub renders it with the run's
 * own code and refuses a variable left without one, so a phone never gets `{{…}}`.
 *
 * Telegram formatting (DECISIONS §137): the Telegram target says how Telegram reads the words —
 * plain text, HTML or MarkdownV2 — and the preview says which and draws the words formatted,
 * from a tree of Telegram's own entities (never the words' HTML put into the page).
 */
import { HubApiError } from '@corehub/contracts';
import { useState, type ReactNode } from 'react';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import {
  Button,
  Checkbox,
  Input,
  Notice,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
} from '../../ui/index.js';
import {
  toWrite,
  type Draft,
  type FailureAlert,
  type Send,
  type SendTarget,
  type WfNode,
} from './model.js';
import {
  SendTestBadAnswer,
  SendTestNoAnswer,
  useProfileConversations,
  useSendTest,
  useStepTest,
  type SendResult,
} from './queries.js';
import {
  TELEGRAM_FORMATTINGS,
  formattingOf,
  parseModeName,
  parseTelegram,
  type TgNode,
} from './telegram-preview.js';
import { fillTemplate, filledValues, missingIn, variablesIn } from './template.js';

/** Telegram's own syntax, the same in every language (Bot API "Formatting options"). */
const FORMATTING_EXAMPLES = {
  html: [
    '<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <tg-spoiler>spoiler</tg-spoiler>',
    '<code>code</code> <pre>block</pre> <a href="https://example.com">link</a> <blockquote>quote</blockquote>',
    '&lt; &gt; &amp;',
  ].join('\n'),
  markdown_v2: [
    '*bold* _italic_ __underline__ ~strike~ ||spoiler|| `code` [link](https://example.com)',
    '```block``` >quote',
    '\\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\!',
  ].join('\n'),
} as const;

/** Telegram and/or a conversation, as a `Send`'s targets. */
export function SendTargets({
  send,
  profile,
  onChange,
  testPrefix = 'workflow-send',
  formatting = false,
}: {
  send: Send;
  profile: string;
  onChange: (send: Send) => void;
  testPrefix?: string;
  /** Offer Telegram formatting (§137): a step's words; a failure alert is always plain. */
  formatting?: boolean;
}) {
  const { t } = useI18n();
  const telegram = send.targets.find((target) => target.platform === 'telegram') ?? null;
  const conversation = send.targets.find((target) => target.platform === 'core_hub') ?? null;
  const conversations = useProfileConversations(profile, !!conversation);
  const [chat, setChat] = useState(telegram?.chat_id ?? '');

  /** Replace (or remove, with `null`) the target of one platform; the others stay as they are. */
  const setTarget = (platform: string, next: SendTarget | null) => {
    const others = send.targets.filter((target) => target.platform !== platform);
    onChange({ targets: next ? [...others, next] : others });
  };

  return (
    <>
      <Checkbox
        checked={!!telegram}
        onChange={(next) =>
          setTarget(
            'telegram',
            next
              ? {
                  platform: 'telegram',
                  chat_id: cleanChatId(chat),
                  ...(formatting ? { formatting: 'plain' } : {}),
                }
              : null,
          )
        }
        label={t('workflows.send.telegram')}
        testId={`${testPrefix}-telegram`}
      />
      {telegram && (
        <>
          <Input
            value={chat}
            onChange={(event) => {
              setChat(event.target.value);
              // Everything else the target says (its formatting) stays as it is.
              setTarget('telegram', {
                ...telegram,
                platform: 'telegram',
                chat_id: cleanChatId(event.target.value),
              });
            }}
            placeholder="-1001234567890"
            aria-label={t('workflows.send.chat_id')}
            dir="ltr"
            data-testid={`${testPrefix}-chat`}
          />
          <p className="text-xs text-muted">{t('workflows.send.telegram_hint')}</p>
          {formatting && (
            <div className="flex flex-col gap-1" data-testid={`${testPrefix}-formatting-field`}>
              <p className="text-xs font-medium">{t('workflows.send.formatting')}</p>
              <Segmented
                size="sm"
                label={t('workflows.send.formatting')}
                value={formattingOf(telegram.formatting)}
                onChange={(value) => setTarget('telegram', { ...telegram, formatting: value })}
                options={TELEGRAM_FORMATTINGS.map((value) => ({
                  value,
                  label: t(`workflows.send.formatting_${value}`),
                  itemProps: { 'data-testid': `${testPrefix}-formatting-${value}` },
                }))}
                testId={`${testPrefix}-formatting`}
              />
              <p className="text-xs text-muted">
                {t(`workflows.send.formatting_${formattingOf(telegram.formatting)}_hint`)}
              </p>
              {formattingOf(telegram.formatting) !== 'plain' && (
                <code
                  dir="ltr"
                  className="block whitespace-pre-wrap break-all rounded bg-sunken p-1 text-start text-xs"
                  data-testid={`${testPrefix}-formatting-example`}
                >
                  {FORMATTING_EXAMPLES[formattingOf(telegram.formatting) as 'html' | 'markdown_v2']}
                </code>
              )}
            </div>
          )}
        </>
      )}
      <Checkbox
        checked={!!conversation}
        onChange={(next) => setTarget('core_hub', next ? { platform: 'core_hub' } : null)}
        label={t('workflows.send.conversation')}
        testId={`${testPrefix}-conversation`}
      />
      {conversation && (
        <>
          <Select
            value={conversation.session_id ?? null}
            onValueChange={(value) => {
              const picked = (conversations.data ?? []).find((each) => each.id === value);
              setTarget('core_hub', {
                platform: 'core_hub',
                session_id: picked?.id ?? null,
                title: picked?.title ?? null,
                agent_id: picked?.agent_id ?? null,
              });
            }}
            options={(conversations.data ?? []).map((each) => ({
              value: each.id,
              label: each.title || t('workflows.send.untitled'),
            }))}
            placeholder={conversation.title ?? t('workflows.send.pick')}
            label={t('workflows.send.conversation')}
            testId={`${testPrefix}-session`}
          />
          <p className="text-xs text-muted">{t('workflows.send.conversation_hint')}</p>
        </>
      )}
    </>
  );
}

/**
 * The test values typed or taken from a run, per step, for as long as the page is open: a step
 * opened again (or the editor reopened after an error) shows them again. Never saved into the
 * step — a test changes nothing in the workflow (2026-09-29).
 */
const sampleValues = new Map<string, Record<string, string>>();

/** Every value as a string: an answer that is not one is never put into a field as it is. */
function asValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [path, each] of Object.entries(value as Record<string, unknown>)) {
    if (typeof each === 'string') out[path] = each;
    else if (typeof each === 'number' || typeof each === 'boolean') out[path] = String(each);
    else if (each !== null && each !== undefined) out[path] = JSON.stringify(each);
  }
  return out;
}

/** Why the test cannot be sent yet, as a message key; `null` when it can. */
export function sendBlockedBy(send: Send, text: string): string | null {
  if (send.targets.length === 0) return 'workflows.send.blocked.no_target';
  for (const target of send.targets) {
    if (target.platform === 'telegram' && !cleanChatId(target.chat_id ?? '')) {
      return 'workflows.send.blocked.no_chat';
    }
    if (target.platform === 'core_hub' && !target.session_id && !target.agent_id) {
      return 'workflows.send.blocked.no_conversation';
    }
  }
  if (!text) return 'workflows.send.blocked.no_text';
  return null;
}

export function SendForm({
  node,
  profile,
  update,
  lastRunId = null,
  workflowId = null,
}: {
  node: WfNode;
  profile: string;
  update: (patch: Partial<WfNode>) => void;
  /** The workflow's newest run, whose values can fill the message's variables (§124). */
  lastRunId?: string | null;
  /** The saved workflow's id, named in the hub's log line for the test. */
  workflowId?: string | null;
}) {
  const { t } = useI18n();
  const send: Send = node.send ?? { targets: [] };
  const test = useSendTest(profile);
  const fromRun = useStepTest(profile);
  const text = (typeof node.input === 'string' ? node.input : '').trim();
  const variables = variablesIn(text);
  const cacheKey = `${profile}\u0000${workflowId ?? 'new'}\u0000${node.id}`;
  const [values, setStoredValues] = useState<Record<string, string>>(
    () => sampleValues.get(cacheKey) ?? {},
  );
  const setValues = (next: (current: Record<string, string>) => Record<string, string>) =>
    setStoredValues((current) => {
      const value = next(current);
      sampleValues.set(cacheKey, value);
      return value;
    });
  const [notFound, setNotFound] = useState<string[]>([]);
  const telegramTarget = send.targets.find((target) => target.platform === 'telegram') ?? null;
  /** How Telegram will read the words; `null` when the step does not send to Telegram. */
  const telegramFormatting = telegramTarget ? formattingOf(telegramTarget.formatting) : null;
  const missing = missingIn(text, values);
  const preview = fillTemplate(text, values);
  const refused = unresolvedOf(test.error);
  const blockedKey = sendBlockedBy(send, text);
  const blocked = blockedKey
    ? t(blockedKey)
    : missing.length > 0
      ? t('workflows.send.missing', { names: namesOf(missing) })
      : null;

  const fillFromLastRun = () => {
    if (!lastRunId) return;
    const single: Draft = {
      name: 'test',
      description: null,
      working_dir: null,
      nodes: [node],
      edges: [],
    };
    fromRun.mutate(
      { node: toWrite(single).nodes[0]!, workflow_run_id: lastRunId },
      {
        onSuccess: (result) => {
          const found = asValues((result as { values?: unknown } | null)?.values);
          setValues((current) => ({ ...current, ...found }));
          setNotFound(variables.filter((path) => !found[path]));
        },
      },
    );
  };

  const sendTest = () => {
    if (blocked) return;
    test.mutate({
      send: { targets: send.targets.map(cleanTarget) },
      text,
      values: filledValues(text, values),
      workflowId,
      nodeId: node.id,
    });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="workflow-send">
      <p className="text-xs font-medium">{t('workflows.send.targets')}</p>
      <SendTargets
        send={send}
        profile={profile}
        onChange={(next) => update({ send: next })}
        formatting
      />
      {variables.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="workflow-send-sample">
          <p className="text-xs font-medium">{t('workflows.send.sample_title')}</p>
          <p className="text-xs text-muted">{t('workflows.send.sample_hint')}</p>
          {lastRunId ? (
            <Button
              size="sm"
              variant="secondary"
              loading={fromRun.isPending}
              onClick={fillFromLastRun}
              data-testid="workflow-send-last-run"
            >
              {t('workflows.send.use_last_run')}
            </Button>
          ) : (
            <p className="text-xs text-muted" data-testid="workflow-send-no-run">
              {t('workflows.send.no_run')}
            </p>
          )}
          {fromRun.error && <Notice tone="danger">{describeError(fromRun.error, t)}</Notice>}
          {fromRun.isSuccess && (
            <p className="text-xs text-muted" data-testid="workflow-send-last-run-filled">
              {t('workflows.send.last_run_filled')}
            </p>
          )}
          {fromRun.isSuccess && notFound.length > 0 && (
            <p className="text-xs text-muted" data-testid="workflow-send-last-run-empty">
              {t('workflows.send.last_run_empty', { names: namesOf(notFound) })}
            </p>
          )}
          {variables.map((path) => (
            <label key={path} className="flex flex-col gap-1 text-xs">
              <code dir="ltr" className="text-start">{`{{${path}}}`}</code>
              <Textarea
                value={values[path] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setValues((current) => ({ ...current, [path]: value }));
                }}
                rows={1}
                dir="auto"
                aria-label={t('workflows.send.value_of', { path })}
                data-testid={`workflow-send-value-${path}`}
              />
            </label>
          ))}
        </section>
      )}
      {text && <SendPreview text={preview} formatting={telegramFormatting} />}
      {missing.length > 0 && (
        <div data-testid="workflow-send-missing">
          <Notice tone="warning">{t('workflows.send.missing', { names: namesOf(missing) })}</Notice>
        </div>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabledReason={blocked}
        loading={test.isPending}
        onClick={sendTest}
        data-testid="workflow-send-test"
      >
        {t('workflows.send.test')}
      </Button>
      {/* Why it cannot be pressed, in words — not only in a tooltip (2026-09-29). */}
      {/* (Variables without a value already have their own notice above.) */}
      {blockedKey && (
        <p className="text-xs text-muted" data-testid="workflow-send-blocked">
          {t(blockedKey)}
        </p>
      )}
      {test.isPending && (
        <div aria-live="polite" data-testid="workflow-send-sending">
          <Spinner label={t('workflows.send.sending')} />
        </div>
      )}
      {!test.isPending && test.error && (
        <div data-testid="workflow-send-test-error">
          <Notice tone="danger">
            {refused
              ? t('workflows.send.missing', { names: namesOf(refused) })
              : test.error instanceof SendTestNoAnswer
                ? t('workflows.send.no_answer', { seconds: test.error.seconds })
                : test.error instanceof SendTestBadAnswer
                  ? t('workflows.send.bad_answer')
                  : describeError(test.error, t)}
          </Notice>
        </div>
      )}
      {!test.isPending && test.data && <SendTestResult result={test.data} />}
    </div>
  );
}

/**
 * What will be sent (§137): the words with their values, and — when they go to Telegram — which
 * formatting Telegram reads them with, drawn formatted from Telegram's own entities. Markup
 * Telegram would refuse is said, and the words are shown as written.
 */
function SendPreview({
  text,
  formatting,
}: {
  text: string;
  formatting: 'plain' | 'html' | 'markdown_v2' | null;
}) {
  const { t } = useI18n();
  const parsed = formatting && formatting !== 'plain' ? parseTelegram(text, formatting) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium">{t('workflows.send.preview')}</p>
        {formatting && (
          <p
            className="text-xs text-muted"
            data-testid="workflow-send-formatting-label"
            data-formatting={formatting}
          >
            {t('workflows.send.preview_formatting', {
              mode:
                formatting === 'plain'
                  ? t('workflows.send.formatting_plain')
                  : parseModeName(formatting),
            })}
          </p>
        )}
      </div>
      <div
        className="whitespace-pre-wrap rounded-md border border-line p-2 text-sm"
        dir="auto"
        data-testid="workflow-send-preview"
        data-formatting={formatting ?? 'plain'}
        data-rendered={parsed?.ok ? 'formatted' : 'text'}
      >
        {parsed?.ok ? renderTelegram(parsed.nodes) : text}
      </div>
      {parsed && !parsed.ok && (
        <div data-testid="workflow-send-preview-invalid">
          <Notice tone="warning">
            {t('workflows.send.preview_invalid', {
              mode: parseModeName(formatting!),
            })}{' '}
            <code dir="ltr" className="break-all">
              {parsed.error}
            </code>
          </Notice>
        </div>
      )}
    </div>
  );
}

/** Telegram's entities as React elements; a link is shown, not followed. */
function renderTelegram(nodes: TgNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return node.text;
    const children = renderTelegram(node.children);
    switch (node.kind) {
      case 'bold':
        return <strong key={index}>{children}</strong>;
      case 'italic':
        return <em key={index}>{children}</em>;
      case 'underline':
        return <u key={index}>{children}</u>;
      case 'strike':
        return <s key={index}>{children}</s>;
      case 'spoiler':
        return (
          <span key={index} className="rounded bg-sunken px-0.5" data-entity="spoiler">
            {children}
          </span>
        );
      case 'code':
        return (
          <code key={index} className="rounded bg-sunken px-1 font-mono text-xs">
            {children}
          </code>
        );
      case 'pre':
        return (
          <pre
            key={index}
            dir="ltr"
            className="my-1 overflow-x-auto rounded bg-sunken p-2 font-mono text-xs"
          >
            {children}
          </pre>
        );
      case 'quote':
        return (
          <blockquote key={index} className="my-1 border-s-2 border-line ps-2">
            {children}
          </blockquote>
        );
      case 'link':
        return (
          <Tooltip key={index} label={node.href}>
            <span className="text-accent underline" data-entity="link" data-href={node.href}>
              {children}
            </span>
          </Tooltip>
        );
    }
  });
}

/** What a test send did: the state, where it went with the platform's ids, and each failure. */
function SendTestResult({ result }: { result: SendResult }) {
  const { t } = useI18n();
  const tone =
    result.status === 'sent' ? 'success' : result.status === 'partial' ? 'warning' : 'danger';
  return (
    <div data-testid="workflow-send-test-result" data-status={result.status}>
      <Notice tone={tone}>
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium" data-status={result.status}>
            {t(`workflows.send.status.${result.status}`)}
          </span>
          {/* The values in their own left-to-right element, so they copy clean (no marks). */}
          {result.delivered_to.map((target) => (
            <span key={target} data-testid="workflow-send-test-delivered">
              {t('workflows.send.sent_to')}:{' '}
              <code dir="ltr" className="break-all">
                {target}
              </code>
            </span>
          ))}
          {result.message_ids.length > 0 && (
            <span data-testid="workflow-send-test-ids">
              {t('workflows.send.message_ids')}:{' '}
              <code dir="ltr" className="break-all">
                {result.message_ids.join(', ')}
              </code>
            </span>
          )}
          {result.failures.map((failure) => (
            <span key={failure.target} dir="auto" className="text-danger">
              {failure.target}: {failure.reason}
            </span>
          ))}
        </div>
      </Notice>
    </div>
  );
}

/**
 * A chat id without the invisible direction marks and spaces it picks up when copied out of
 * right-to-left text: the id Telegram knows (the hub cleans it the same way).
 */
export function cleanChatId(value: string): string {
  return value.replace(/[\s\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
}

function cleanTarget(target: SendTarget): SendTarget {
  return target.platform === 'telegram' && typeof target.chat_id === 'string'
    ? { ...target, chat_id: cleanChatId(target.chat_id) }
    : target;
}

/** Variables as the template writes them, in a line (left to right: they are paths). */
function namesOf(paths: readonly string[]): string {
  return `\u2066${paths.map((path) => `{{${path}}}`).join(' ')}\u2069`;
}

/** The variables the hub said had no value (`template_unresolved`), or `null` for another error. */
function unresolvedOf(error: unknown): string[] | null {
  if (!(error instanceof HubApiError)) return null;
  const details = (error.body as { details?: { reason?: unknown; unresolved?: unknown } })?.details;
  if (details?.reason !== 'template_unresolved' || !Array.isArray(details.unresolved)) return null;
  return details.unresolved.filter((path): path is string => typeof path === 'string');
}

/** Who is told when a run of the workflow fails (§127): the inbox, and optionally targets. */
export function FailureAlertForm({
  alert,
  profile,
  onChange,
}: {
  alert: FailureAlert | null;
  profile: string;
  onChange: (alert: FailureAlert | null) => void;
}) {
  const { t } = useI18n();
  const current: FailureAlert = alert ?? { inbox: false, send: null };
  const set = (next: FailureAlert) =>
    onChange(next.inbox || next.send?.targets.length ? next : null);
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3" data-testid="workflow-alert">
      <h3 className="text-sm font-medium">{t('workflows.alert.title')}</h3>
      <Switch
        checked={current.inbox}
        onChange={(next) => set({ ...current, inbox: next })}
        label={t('workflows.alert.inbox')}
        testId="workflow-alert-inbox"
      />
      <SendTargets
        send={current.send ?? { targets: [] }}
        profile={profile}
        onChange={(send) => set({ ...current, send })}
        testPrefix="workflow-alert"
      />
      <p className="text-xs text-muted">{t('workflows.alert.hint')}</p>
    </section>
  );
}
