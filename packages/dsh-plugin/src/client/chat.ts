/**
 * The chat rows for `/hermes` and `/corehub`, registered into the harness's command-row slot
 * (`conversation.chat.commandview`, keyed by command name; an unoccupied key keeps the harness's
 * generic card). Built from the harness's own parts: the question in its user-message bubble,
 * Hermes's answer in its Markdown renderer (each block in its own direction), state dots, command
 * text and buttons from its shared library. A `/corehub` result says plainly whether it worked;
 * the pairing code is never shown (`/corehub link ••••`).
 */
import { createElement as h, type ReactNode } from 'react';
import {
  Button,
  CommandText,
  StateDot,
  UserMessageBubble,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { commandEcho, decodeOutcome } from '../outcome.js';
import { uiLanguage, uiTranslator, type UiKey, type UiLanguage } from '../ui-strings.js';
import { Answer, markdownLabels } from './answer.js';
import { PRODUCT_NAMES } from './product.js';

/** The command row the harness hands the card (its `CommandNode`, as far as the card reads it). */
export interface CommandRowNode {
  name: string | null;
  args: string | null;
  outcome: { kind: 'success' | 'error'; text?: string } | null;
}

export interface CommandCardProps {
  node: CommandRowNode;
  openSettings?: () => void;
}

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
}

function translate(language: UiLanguage | null) {
  const lang = language ?? uiLanguage('auto', browserLanguages());
  return { lang, t: uiTranslator(lang, PRODUCT_NAMES[lang]) };
}

function head(state: 'done' | 'error' | 'ongoing', title: string, ok: boolean | null): ReactNode {
  return h(
    'div',
    { className: 'corehub-chat-head', 'data-ok': ok === null ? undefined : String(ok) },
    h(StateDot, { state }),
    h('strong', { dir: 'auto' }, title),
  );
}

function frame(lang: UiLanguage, ...children: ReactNode[]): ReactNode {
  return h(
    'div',
    { className: 'corehub-chat', 'data-corehub-card': '', dir: lang === 'ar' ? 'rtl' : 'ltr' },
    ...children,
  );
}

/** `/hermes <message>`: the question as the person's bubble, then Hermes's answer as a reply. */
export function HermesCard({ node }: CommandCardProps): ReactNode {
  const { meta, body } = decodeOutcome(node.outcome?.text);
  const { lang, t } = translate(meta?.language ?? null);
  const question = (node.args ?? '').trim();
  const bubble = question
    ? h(UserMessageBubble, { className: 'corehub-chat-question', dir: 'auto' }, question)
    : null;
  if (!node.outcome) return frame(lang, bubble, head('ongoing', t('chat.hermes.thinking'), null));
  const ok = node.outcome.kind === 'success';
  return frame(
    lang,
    bubble,
    head(ok ? 'done' : 'error', ok ? t('chat.hermes.label') : t('chat.hermes.failed'), ok),
    h(Answer, { text: body, labels: markdownLabels(lang, t) }),
  );
}

const TITLES: Record<string, { ok: UiKey; fail: UiKey }> = {
  link: { ok: 'chat.ok.link', fail: 'chat.fail.link' },
  unlink: { ok: 'chat.ok.unlink', fail: 'chat.fail' },
  status: { ok: 'chat.ok.status', fail: 'chat.fail' },
  models: { ok: 'chat.ok.models', fail: 'chat.fail' },
  help: { ok: 'chat.ok.help', fail: 'chat.fail' },
};

/** `/corehub …`: a visible echo (without the pairing code) and a clear success or failure. */
export function CoreHubCard({ node, openSettings }: CommandCardProps): ReactNode {
  const { meta, body } = decodeOutcome(node.outcome?.text);
  const { lang, t } = translate(meta?.language ?? null);
  const command = node.name ?? 'corehub';
  const echo = h(
    'div',
    { dir: 'ltr' },
    h(CommandText, {
      text: commandEcho(command, meta?.sub ?? null, node.args),
      label: t('chat.command'),
      className: 'corehub-chat-echo',
    }),
  );
  if (!node.outcome) return frame(lang, echo, head('ongoing', t('chat.running'), null));
  const ok = node.outcome.kind === 'success';
  const titles = TITLES[meta?.sub ?? ''] ?? { ok: 'chat.ok' as UiKey, fail: 'chat.fail' as UiKey };
  return frame(
    lang,
    echo,
    head(ok ? 'done' : 'error', t(ok ? titles.ok : titles.fail), ok),
    h(Answer, { text: body, labels: markdownLabels(lang, t), variant: 'compact' }),
    openSettings
      ? h(
          'div',
          null,
          h(
            Button,
            { variant: 'outline', size: 'sm', type: 'button', onClick: openSettings },
            t('chat.openSettings'),
          ),
        )
      : null,
  );
}
