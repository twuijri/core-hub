/**
 * The plugin's browser half (the harness's client module system serves it to the Web and
 * desktop app; `dsh.client` in package.json). It registers:
 *
 * - the chat cards for `/hermes` and `/corehub` (`conversation.chat.commandview`, keyed by the
 *   command name), so Hermes's answer reads as a reply and a link result is plainly visible;
 * - the "Core Hub" settings page on the Plugins page: on the bundle's own page
 *   (`plugins.bundle.config`) and behind the row's Configure control (`plugins.row.config`).
 *
 * Slots and their props are written down from the harness's published declarations (0.2.2-rc.5,
 * dsh-client-ui-chat and dsh-client-ui-plugin-manager). React and the harness's shared UI
 * library (dsh-client-ui-primitives) come from the page's shared module table, so every control
 * is the harness's own.
 */
import { createElement as h } from 'react';
import { PanelApi } from './api.js';
import { CoreHubCard, HermesCard, type CommandRowNode } from './chat.js';
import { CoreHubPage } from './page.js';
import { COMMANDS, PLUGIN_PACKAGE, PLUGIN_ROW } from './product.js';
import { installStyles } from './styles.js';

export const name = 'corehub-client';
export const inject = ['slots'];

interface SlotOptions {
  name: string;
  key?: string;
  id?: string;
  inject?: () => Record<string, unknown>;
}

interface ClientContext {
  slots: {
    inject(slot: string, register: () => unknown): unknown;
    register(options: SlotOptions, component: (props: never) => unknown): () => void;
  };
  get?(service: string): unknown;
  effect?(execute: () => () => void): unknown;
}

export function apply(ctx: ClientContext): void {
  const api = new PanelApi();
  if (ctx.effect) ctx.effect(() => installStyles());
  else installStyles();
  const openSettings = () => {
    const nav = ctx.get?.('pluginNavigation') as { openBundle?(pkg: string): void } | undefined;
    nav?.openBundle?.(PLUGIN_PACKAGE);
  };

  ctx.slots.inject('conversation.chat.commandview', () =>
    ctx.slots.register(
      { name: 'conversation.chat.commandview', key: COMMANDS.agent },
      (props: { node: CommandRowNode }) => h(HermesCard, { node: props.node }),
    ),
  );
  ctx.slots.inject('conversation.chat.commandview', () =>
    ctx.slots.register(
      { name: 'conversation.chat.commandview', key: COMMANDS.corehub },
      (props: { node: CommandRowNode }) =>
        h(CoreHubCard, {
          node: props.node,
          ...(ctx.get?.('pluginNavigation') ? { openSettings } : {}),
        }),
    ),
  );

  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: PLUGIN_PACKAGE },
      (props: { view?: 'summary' | 'page' }) => h(CoreHubPage, { api, view: props.view ?? 'page' }),
    ),
  );
  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      { name: 'plugins.row.config', key: `${PLUGIN_PACKAGE}#${PLUGIN_ROW}` },
      (props: { view?: 'summary' | 'page' }) => h(CoreHubPage, { api, view: props.view ?? 'page' }),
    ),
  );
}
