/**
 * The product's names in the browser half, written in by the build from `@corehub/contracts`
 * (`PRODUCT.name`, `PRODUCT.nameAr`), so the browser bundle carries no contract code and no
 * typed literal.
 */
declare const __PRODUCT_NAME__: string | undefined;
declare const __PRODUCT_NAME_AR__: string | undefined;
declare const __PLUGIN_PACKAGE__: string | undefined;
declare const __PLUGIN_ROW__: string | undefined;

export const PRODUCT_NAMES = {
  en: typeof __PRODUCT_NAME__ === 'string' ? __PRODUCT_NAME__ : 'product',
  ar: typeof __PRODUCT_NAME_AR__ === 'string' ? __PRODUCT_NAME_AR__ : 'product',
} as const;

/** The npm package (the Plugins page keys a bundle's page by it) and the row id in its patch. */
export const PLUGIN_PACKAGE =
  typeof __PLUGIN_PACKAGE__ === 'string' ? __PLUGIN_PACKAGE__ : '@corehub/dsh-plugin';
export const PLUGIN_ROW = typeof __PLUGIN_ROW__ === 'string' ? __PLUGIN_ROW__ : 'corehub';

declare const __COMMAND_NAME__: string | undefined;
declare const __AGENT_COMMAND_NAME__: string | undefined;

/** The two commands whose chat rows the plugin draws (`names.ts`). */
export const COMMANDS = {
  corehub: typeof __COMMAND_NAME__ === 'string' ? __COMMAND_NAME__ : 'corehub',
  agent: typeof __AGENT_COMMAND_NAME__ === 'string' ? __AGENT_COMMAND_NAME__ : 'hermes',
} as const;
