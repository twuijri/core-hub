/**
 * The composition rule (owner decision, 2026-09-22): a headless primitive is wrapped once
 * in `src/ui/`, and screens import that wrapper. A screen that reaches for `radix-ui`
 * directly would put styling in two places, which is exactly what the rule exists to stop —
 * so this test fails instead of a reviewer having to notice.
 *
 * Extended 2026-09-22 with the kit: the client now has a complete component set in the
 * shadcn/ui manner (our files, our tokens, Radix underneath). Three further rules keep it
 * a kit rather than a folder:
 *
 *   1. every component is exported from the one barrel, `src/ui/index.ts`;
 *   2. every component is used by at least one screen — an unused component is a design
 *      that was never tested against a real page;
 *   3. nothing in the kit writes a literal colour: every value is a token, so the themes
 *      and the WCAG contrast test can see it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');
const styles = path.join(src, 'styles');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Where a primitive may be imported: our own wrapper layer, and nowhere else. */
const ALLOWED = new Set(['ui']);

/** Every component the kit publishes, and the file it lives in. */
const KIT: Array<[component: string, file: string]> = [
  ['AlertDialog', 'AlertDialog.tsx'],
  ['Avatar', 'Avatar.tsx'],
  ['agentMark', 'brand/marks.tsx'],
  ['Badge', 'Badge.tsx'],
  ['Breadcrumb', 'Breadcrumb.tsx'],
  ['Button', 'Button.tsx'],
  ['buttonClass', 'Button.tsx'],
  ['Card', 'Card.tsx'],
  ['CardHeader', 'Card.tsx'],
  ['CardFooter', 'Card.tsx'],
  ['cardClass', 'Card.tsx'],
  ['Checkbox', 'Checkbox.tsx'],
  ['Combobox', 'Combobox.tsx'],
  ['useConfirm', 'ConfirmDialog.tsx'],
  ['ContextMenu', 'ContextMenu.tsx'],
  ['ContextMenuItem', 'ContextMenu.tsx'],
  ['Dialog', 'Dialog.tsx'],
  ['Sheet', 'Dialog.tsx'],
  ['UiDirection', 'Direction.tsx'],
  ['EmptyState', 'EmptyState.tsx'],
  ['Input', 'Input.tsx'],
  ['Textarea', 'Input.tsx'],
  ['Field', 'Label.tsx'],
  ['Label', 'Label.tsx'],
  ['Menu', 'Menu.tsx'],
  ['MenuItem', 'Menu.tsx'],
  ['Notice', 'Notice.tsx'],
  ['Spinner', 'Notice.tsx'],
  ['Popover', 'Popover.tsx'],
  ['usePrompt', 'PromptDialog.tsx'],
  ['Radio', 'Radio.tsx'],
  ['ScrollArea', 'ScrollArea.tsx'],
  ['Segmented', 'Segmented.tsx'],
  ['Select', 'Select.tsx'],
  ['Separator', 'Separator.tsx'],
  ['SidebarFrame', 'SidebarShell.tsx'],
  ['SidebarGroup', 'SidebarShell.tsx'],
  ['SidebarRow', 'SidebarShell.tsx'],
  ['Skeleton', 'Skeleton.tsx'],
  ['SkeletonGroup', 'Skeleton.tsx'],
  ['Switch', 'Switch.tsx'],
  ['Table', 'Table.tsx'],
  ['Tabs', 'Tabs.tsx'],
  ['TabPanel', 'Tabs.tsx'],
  ['ToastProvider', 'Toast.tsx'],
  ['useToast', 'Toast.tsx'],
  ['Tooltip', 'Tooltip.tsx'],
];

/** Everything outside `src/ui/`: the screens, the shell, the chat, the i18n provider. */
function outsideTheKit(): string[] {
  return walk(src)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !ALLOWED.has(path.relative(src, file).split(path.sep)[0] ?? ''));
}

describe('the UI layer', () => {
  it('is the only place that imports radix-ui', () => {
    const offenders = outsideTheKit()
      .filter((file) => /from '(radix-ui|@radix-ui\/[^']+)'/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(src, file));
    expect(offenders).toEqual([]);
  });

  it('exports a wrapper for every primitive the client uses', () => {
    for (const name of [
      'Menu.tsx',
      'Select.tsx',
      'Popover.tsx',
      'Tooltip.tsx',
      'Checkbox.tsx',
      'AlertDialog.tsx',
      'Dialog.tsx',
      'Direction.tsx',
      'Avatar.tsx',
      'ContextMenu.tsx',
      'Label.tsx',
      'Radio.tsx',
      'ScrollArea.tsx',
      'Separator.tsx',
      'Switch.tsx',
      'Tabs.tsx',
      'Toast.tsx',
    ]) {
      const text = readFileSync(path.join(src, 'ui', name), 'utf8');
      expect(text, name).toMatch(/from 'radix-ui'/);
    }
  });

  it('has no native popup or OS-painted control left in a screen', () => {
    // `pnpm lint` fails on these too (eslint.config.js §UI policy). This says the same
    // thing from the other side, so deleting the rule cannot quietly pass.
    const offenders: string[] = [];
    for (const file of outsideTheKit()) {
      const rel = path.relative(src, file);
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of [
        ['a native <select>', /<select[\s>]/],
        ['a native <dialog>', /<dialog[\s>]/],
        ['a native checkbox or radio', /type="(checkbox|radio)"/],
        ['window.confirm/alert/prompt', /\b(window\.)?(confirm|alert|prompt)\(/],
        // `title` on a host element only: <AppShell title={…}> is a prop, not a tooltip.
        ['a native title tooltip', /<[a-z][a-zA-Z0-9-]*\s[^>]*\stitle=/],
      ] as const) {
        if (pattern.test(text)) offenders.push(`${rel}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the policy is in the lint config, so CI fails on it and not only this test', () => {
    const config = readFileSync(path.resolve(src, '../../../eslint.config.js'), 'utf8');
    for (const fragment of [
      "JSXOpeningElement[name.name='select']",
      "JSXOpeningElement[name.name='dialog']",
      "JSXAttribute[name.name='title']",
      'no-restricted-globals',
      'radix-ui',
    ]) {
      expect(config, fragment).toContain(fragment);
    }
  });
});

describe('the component kit', () => {
  const barrel = readFileSync(path.join(src, 'ui', 'index.ts'), 'utf8');

  it('exports every component from the one barrel', () => {
    const missing = KIT.filter(([name]) => !new RegExp(`\\b${name}\\b`).test(barrel)).map(
      ([name]) => name,
    );
    expect(missing).toEqual([]);
  });

  it('declares each export in the file it says it lives in', () => {
    const wrong: string[] = [];
    for (const [name, file] of KIT) {
      const text = readFileSync(path.join(src, 'ui', file), 'utf8');
      if (!new RegExp(`export (function|const|type|interface) ${name}\\b`).test(text))
        wrong.push(`${name} is not declared in ui/${file}`);
    }
    expect(wrong).toEqual([]);
  });

  it('is used: every component appears in at least one screen', () => {
    // A component no screen uses is a design that was never tested against a real page.
    const screens = outsideTheKit().map((file) => readFileSync(file, 'utf8'));
    const unused = KIT.filter(
      ([name]) => !screens.some((text) => new RegExp(`\\b${name}\\b`).test(text)),
    ).map(([name]) => name);
    expect(unused).toEqual([]);
  });

  it('paints only with tokens: no literal colour anywhere in the kit stylesheet', () => {
    // A hex here would be a colour the themes cannot reach and the contrast test cannot
    // see. `black` and `white` survive only inside color-mix, where they darken a token.
    const css = readFileSync(path.join(styles, 'kit.css'), 'utf8');
    const literals = css
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line));
    expect(literals.map(([n, line]) => `${n}: ${line.trim()}`)).toEqual([]);
  });

  it('uses logical sides only, so one stylesheet serves Arabic and English', () => {
    for (const file of ['kit.css', 'chat.css', 'screens.css']) {
      const css = readFileSync(path.join(styles, file), 'utf8');
      const offenders = css
        .split('\n')
        .filter((line) => /(^|[\s;{])(margin|padding|border|inset)-(left|right)\s*:/.test(line));
      expect(offenders, file).toEqual([]);
    }
  });
});
