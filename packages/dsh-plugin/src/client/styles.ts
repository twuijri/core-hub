/**
 * Layout for the plugin's page and chat rows. Every colour, font, radius and border comes from
 * the harness theme's `--dsw-*` tokens (docs/web-styling.md, docs/ui-radius.md: semantic
 * `--dsw-alias-*` colours, `--dsw-font-*` type roles, `--dsw-radius-*`, 0.5px hairlines, the
 * settings-card material), so light and dark follow the harness; nothing here names a colour.
 * The controls themselves are the harness's (`harness-ui.d.ts`); this only places them.
 */
export const CSS = `
.corehub-page { display: flex; flex-direction: column; gap: 28px; color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.corehub-intro { margin: 0; font: var(--dsw-font-s-14); color: var(--dsw-alias-label-secondary); }
.corehub-section { display: flex; flex-direction: column; gap: 8px; }
.corehub-section-title { margin: 0; font: var(--dsw-font-s-strong-14); color: var(--dsw-alias-label-primary); }
.corehub-hint { margin: 0; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
.corehub-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.corehub-grow { flex: 1 1 220px; min-width: 0; }
.corehub-card { border-radius: var(--dsw-radius-xl); border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); padding: 4px 16px; }
.corehub-card-row { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 4px 0; flex-wrap: wrap; }
.corehub-card-row + .corehub-card-row { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.corehub-fact-label { flex: 0 0 140px; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary); }
.corehub-fact-value { flex: 1 1 200px; min-width: 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; display: inline-flex; align-items: center; gap: 6px; }
.corehub-mono { font-family: var(--dsw-font-markdown-code-font-family); unicode-bidi: isolate; }
.corehub-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.corehub-switch-row > span { font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary); }
.corehub-result { display: flex; align-items: flex-start; gap: 8px; font: var(--dsw-font-xs-13); white-space: pre-wrap; unicode-bidi: plaintext; }
.corehub-result[data-ok='true'] { color: var(--dsw-alias-label-secondary); }
.corehub-result[data-ok='false'] { color: var(--dsw-alias-state-error-primary); }
.corehub-result > :first-child { margin-top: 4px; flex: 0 0 auto; }
.corehub-select { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 240px; max-width: 100%; height: 34px; padding: 0 12px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13); cursor: pointer; }
.corehub-select:disabled { opacity: 0.5; cursor: default; }
.corehub-select > svg { color: var(--dsw-alias-label-tertiary); flex: 0 0 auto; }
.corehub-danger { --dsh-button-outline-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.corehub-version { margin: 0; font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-caption); }
.corehub-activity-time { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
.corehub-chat { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; }
.corehub-chat-question { align-self: flex-end; max-width: 85%; white-space: pre-wrap; unicode-bidi: plaintext; }
.corehub-chat-head { display: flex; align-items: center; gap: 8px; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary); }
.corehub-chat-head strong { font: var(--dsw-font-xs-strong-13); }
.corehub-chat-head[data-ok='true'] strong { color: var(--dsw-alias-label-primary); }
.corehub-chat-head[data-ok='false'] strong { color: var(--dsw-alias-state-error-primary); }
.corehub-chat-echo { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-markdown-code-font-family); }
`;

const STYLE_ID = 'corehub-dsh-plugin-style';

/** Adds the stylesheet once; the returned function removes it (the plugin's unload). */
export function installStyles(doc: Document = document): () => void {
  if (doc.getElementById(STYLE_ID)) return () => undefined;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
  return () => style.remove();
}
