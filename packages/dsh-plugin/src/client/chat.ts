/**
 * The chat cards for `/hermes` and `/corehub`, registered into the harness's command-row slot
 * (`conversation.chat.commandview`, keyed by command name; an unoccupied key keeps the harness's
 * generic card). Hermes's answer reads like a chat reply: rendered Markdown, each paragraph in its
 * own direction, open, and labelled as Hermes on Core Hub. A `/corehub` result says plainly
 * whether it worked; the pairing code is never shown (`/corehub link ••••`).
 */
import { createElement as h, type ReactNode } from 'react';
import { commandEcho, decodeOutcome } from '../outcome.js';
import { uiLanguage, uiTranslator, type UiKey, type UiLanguage } from '../ui-strings.js';
import { MarkdownBlocks } from './markdown-view.js';
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

const GREEN = '#16a34a';
const RED = '#dc2626';
const ACCENT = '#6366f1';

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
}

function translate(language: UiLanguage | null) {
  const lang = language ?? uiLanguage('auto', browserLanguages());
  return { lang, t: uiTranslator(lang, PRODUCT_NAMES[lang]) };
}

function echoLine(text: string): ReactNode {
  return h(
    'div',
    {
      dir: 'auto',
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        opacity: 0.65,
        marginBottom: 6,
        unicodeBidi: 'plaintext',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
    },
    text,
  );
}

function badge(color: string, label: string): ReactNode {
  return h(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 11,
        background: color,
        color: '#fff',
        fontSize: 12,
        fontWeight: 700,
        flex: '0 0 auto',
      },
      'aria-hidden': true,
    },
    label,
  );
}

function card(accent: string, children: ReactNode[], lang: UiLanguage): ReactNode {
  return h(
    'div',
    {
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      'data-corehub-card': '',
      style: {
        border: '1px solid rgba(127,127,127,0.25)',
        borderInlineStart: `3px solid ${accent}`,
        borderRadius: 10,
        padding: '10px 14px',
        margin: '6px 0',
        background: 'rgba(127,127,127,0.05)',
        fontSize: 14,
      },
    },
    ...children,
  );
}

function header(icon: ReactNode, title: string, color?: string): ReactNode {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
    icon,
    h('strong', { dir: 'auto', style: { fontSize: 14, color } }, title),
  );
}

/** `/hermes <message>`: the question, then Hermes's answer as a reply. */
export function HermesCard({ node }: CommandCardProps): ReactNode {
  const { meta, body } = decodeOutcome(node.outcome?.text);
  const { lang, t } = translate(meta?.language ?? null);
  const question = (node.args ?? '').trim();
  const parts: ReactNode[] = [];
  if (question)
    parts.push(
      h(
        'div',
        {
          key: 'q',
          style: {
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            opacity: 0.75,
            fontSize: 13,
            marginBottom: 8,
          },
        },
        h('span', { style: { fontWeight: 600 } }, `${t('chat.you')}: `),
        h('bdi', null, question),
      ),
    );
  if (!node.outcome) {
    parts.push(header(badge(ACCENT, 'H'), t('chat.hermes.label')));
    parts.push(h('div', { key: 'w', style: { opacity: 0.7 } }, t('chat.hermes.thinking')));
    return card(ACCENT, parts, lang);
  }
  const ok = node.outcome.kind === 'success';
  parts.push(
    header(
      badge(ok ? ACCENT : RED, ok ? 'H' : '!'),
      ok ? t('chat.hermes.label') : t('chat.hermes.failed'),
      ok ? undefined : RED,
    ),
  );
  parts.push(h(MarkdownBlocks, { key: 'a', source: body }));
  return card(ok ? ACCENT : RED, parts, lang);
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
  const parts: ReactNode[] = [echoLine(commandEcho(command, meta?.sub ?? null, node.args))];
  if (!node.outcome) {
    parts.push(header(badge(ACCENT, '…'), t('chat.running')));
    return card(ACCENT, parts, lang);
  }
  const ok = node.outcome.kind === 'success';
  const titles = TITLES[meta?.sub ?? ''] ?? { ok: 'chat.ok' as UiKey, fail: 'chat.fail' as UiKey };
  parts.push(
    header(
      badge(ok ? GREEN : RED, ok ? '✓' : '✕'),
      t(ok ? titles.ok : titles.fail),
      ok ? GREEN : RED,
    ),
  );
  parts.push(h(MarkdownBlocks, { key: 'b', source: body }));
  if (openSettings)
    parts.push(
      h(
        'button',
        {
          key: 's',
          type: 'button',
          onClick: openSettings,
          style: {
            marginTop: 6,
            background: 'transparent',
            border: '1px solid rgba(127,127,127,0.4)',
            borderRadius: 8,
            padding: '4px 10px',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 13,
          },
        },
        t('chat.openSettings'),
      ),
    );
  return card(ok ? GREEN : RED, parts, lang);
}
