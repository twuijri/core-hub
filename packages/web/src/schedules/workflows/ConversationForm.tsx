/**
 * Which conversation an agent step talks in (DECISIONS §136): a new one for every run (the
 * default), or the same existing conversation every run, so a workflow's turns read as one
 * conversation instead of filling the chat list with one per run.
 *
 * The owner's shape: the **picker is the main control** — the profile's conversations,
 * searched by title, each with when it was last active — and pasting an id is the secondary
 * way, for a conversation the list does not show or an id that comes from the event
 * (`{{trigger.body.conversation}}`; templates only there). A plain id, picked or pasted, is
 * looked up at once and shown by its title, or with the hub's reason when the step cannot use
 * it. "Test conversation" asks the hub the run's own question without sending anything.
 */
import { useEffect, useState } from 'react';
import { describeError } from '../../auth/client.js';
import { chatHref } from '../../chat/anchor.js';
import { useI18n } from '../../i18n/context.js';
import { intlLocale } from '../../i18n/index.js';
import { Combobox } from '../../ui/Combobox.js';
import { Button, Field, Input, Notice, Radio, Switch } from '../../ui/index.js';
import type { Agent } from '../../types.js';
import { reusesConversation, type Conversation, type WfNode } from './model.js';
import {
  useConversationCheck,
  useProfileConversations,
  type ConversationCheck,
} from './queries.js';
import { variablesIn } from './template.js';

/** Invisible marks and spaces a pasted id may carry; an id is letters and digits only. */
export function cleanConversationId(value: string): string {
  return value.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A plain conversation id the hub can look up now (not a template, not half-typed). */
export function lookupId(value: string | null | undefined): string | null {
  const id = cleanConversationId(value ?? '');
  return ULID.test(id) ? id : null;
}

const TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  ready: 'success',
  busy: 'warning',
};

export function ConversationForm({
  node,
  profile,
  agents,
  update,
}: {
  node: WfNode;
  profile: string;
  agents: readonly Agent[];
  update: (patch: Partial<WfNode>) => void;
}) {
  const { t, language } = useI18n();
  const conversation: Conversation = node.conversation ?? { mode: 'new' };
  const reuse = reusesConversation(node);
  const id = conversation.session_id ?? '';
  const templated = variablesIn(id).length > 0;
  const [manual, setManual] = useState(templated);
  const list = useProfileConversations(profile, reuse);
  const check = useConversationCheck(profile);
  const literal = lookupId(id);
  const agentId = node.agent_id;

  const set = (patch: Partial<Conversation>) =>
    update({ conversation: { ...conversation, ...patch } });

  // A plain id — picked or pasted — is looked up as soon as it is whole, so the person sees
  // its title, or why the step cannot use it, without pressing anything.
  const { mutate, reset } = check;
  useEffect(() => {
    if (!reuse || !literal) {
      reset();
      return;
    }
    const timer = setTimeout(() => mutate({ sessionId: literal, agentId }), 350);
    return () => clearTimeout(timer);
  }, [reuse, literal, agentId, mutate, reset]);

  const agentName = (value: string | null | undefined) =>
    agents.find((agent) => agent.id === value)?.name ?? null;
  const when = (at: string | null | undefined) =>
    at
      ? new Intl.DateTimeFormat(intlLocale(language), {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : null;

  const options = (list.data ?? [])
    // A room seat's conversation belongs to its room (the hub refuses it too).
    .filter((row) => row.source !== 'room')
    .map((row) => {
      const active = when(row.last_message_at ?? row.updated_at);
      const agent = agentName(row.agent_id);
      return {
        value: row.id,
        label: row.title || t('workflows.send.untitled'),
        detail: [active ? t('workflows.conversation.last_active', { when: active }) : null, agent]
          .filter(Boolean)
          .join(' · '),
      };
    });

  const pick = (value: string | null) => {
    const row = (list.data ?? []).find((each) => each.id === value);
    // The conversation has one agent: the step takes it, so the two always match.
    update({
      conversation: { ...conversation, session_id: value },
      ...(row && row.agent_id !== node.agent_id ? { agent_id: row.agent_id } : {}),
    });
  };

  const result = check.data ?? null;

  return (
    <div
      className="flex flex-col gap-2 border-t border-line pt-3"
      data-testid="workflow-conversation"
    >
      <Radio
        label={t('workflows.conversation.label')}
        value={reuse ? 'reuse' : 'new'}
        onChange={(next) =>
          update({
            conversation:
              next === 'reuse'
                ? { create_if_missing: false, ...conversation, mode: 'reuse' }
                : conversation.session_id || conversation.create_if_missing
                  ? { ...conversation, mode: 'new' }
                  : null,
          })
        }
        options={[
          {
            value: 'new',
            label: t('workflows.conversation.mode_new'),
            hint: t('workflows.conversation.mode_new_hint'),
          },
          {
            value: 'reuse',
            label: t('workflows.conversation.mode_reuse'),
            hint: t('workflows.conversation.mode_reuse_hint'),
          },
        ]}
        testId="workflow-conversation-mode"
      />

      {reuse && (
        <>
          {!manual ? (
            <Field label={t('workflows.conversation.pick')}>
              {() => (
                <Combobox
                  value={literal}
                  onChange={pick}
                  options={options}
                  label={t('workflows.conversation.pick')}
                  placeholder={result?.title ?? t('workflows.conversation.pick_placeholder')}
                  status={list.isLoading ? 'loading' : list.isError ? 'error' : 'ready'}
                  errorMessage={list.isError ? describeError(list.error, t) : null}
                  testId="workflow-conversation-pick"
                  nouns={{
                    count: 'workflows.conversation.count',
                    none: 'workflows.conversation.none',
                  }}
                />
              )}
            </Field>
          ) : (
            <Field label={t('workflows.conversation.id')}>
              {(props) => (
                <Input
                  {...props}
                  value={id}
                  onChange={(event) => set({ session_id: event.target.value })}
                  placeholder="01J8QK3ZR2W7M5N4P6T8V9X0SA"
                  dir="ltr"
                  className="font-mono"
                  data-testid="workflow-conversation-id"
                />
              )}
            </Field>
          )}
          <button
            type="button"
            className="self-start text-xs text-accent underline-offset-2 hover:underline"
            onClick={() => setManual(!manual)}
            data-testid="workflow-conversation-manual"
          >
            {manual ? t('workflows.conversation.use_list') : t('workflows.conversation.paste_id')}
          </button>
          {manual && <p className="text-xs text-muted">{t('workflows.conversation.id_hint')}</p>}

          {literal && !manual && (
            <p className="text-xs text-muted">
              {t('workflows.conversation.id')}: <code dir="ltr">{literal}</code>
            </p>
          )}
          {templated && (
            <p className="text-xs text-muted" data-testid="workflow-conversation-template">
              {t('workflows.conversation.template_note')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!literal}
              loading={check.isPending}
              onClick={() => literal && mutate({ sessionId: literal, agentId })}
              data-testid="workflow-conversation-test"
            >
              {t('workflows.conversation.test')}
            </Button>
            {literal && result?.status && result.status !== 'not_found' && (
              <a
                className="text-xs text-accent underline-offset-2 hover:underline"
                href={chatHref(literal, null, undefined, profile)}
                target="_blank"
                rel="noreferrer"
              >
                {t('workflows.conversation.open')}
              </a>
            )}
          </div>
          {!literal && !templated && (
            <p className="text-xs text-muted" data-testid="workflow-conversation-blocked">
              {id.trim()
                ? t('workflows.conversation.not_an_id')
                : t('workflows.conversation.none_yet')}
            </p>
          )}
          {check.error && (
            <Notice tone="danger">
              <span className="text-xs">{describeError(check.error, t)}</span>
            </Notice>
          )}
          {result && literal && result.session_id === literal && (
            <CheckResult result={result} agentName={agentName} t={t} />
          )}

          <Switch
            checked={conversation.create_if_missing === true}
            onChange={(next) => set({ create_if_missing: next })}
            label={t('workflows.conversation.create_if_missing')}
            testId="workflow-conversation-create"
          />
          <p className="text-xs text-muted">
            {conversation.create_if_missing
              ? t('workflows.conversation.create_on_hint')
              : t('workflows.conversation.create_off_hint')}
          </p>
          {conversation.create_if_missing && (
            <Field label={t('workflows.conversation.new_title')}>
              {(props) => (
                <Input
                  {...props}
                  value={conversation.title ?? ''}
                  onChange={(event) => set({ title: event.target.value })}
                  placeholder={node.title || node.id}
                  dir="auto"
                  data-testid="workflow-conversation-title"
                />
              )}
            </Field>
          )}
          <p className="text-xs text-muted">{t('workflows.conversation.agent_hint')}</p>
        </>
      )}
    </div>
  );
}

function CheckResult({
  result,
  agentName,
  t,
}: {
  result: ConversationCheck;
  agentName: (id: string | null) => string | null;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const known = ['ready', 'busy', 'not_found', 'not_allowed', 'agent_mismatch'].includes(
    result.status,
  );
  const words = known
    ? t(`workflows.conversation.status.${result.status}`, {
        title: result.title || t('workflows.send.untitled'),
        agent: agentName(result.agent_id) ?? result.agent_id ?? '',
      })
    : (result.reason ?? result.status);
  return (
    <Notice tone={TONE[result.status] ?? 'danger'}>
      <span
        className="text-xs"
        dir="auto"
        data-testid="workflow-conversation-result"
        data-status={result.status}
      >
        {words}
      </span>
    </Notice>
  );
}
