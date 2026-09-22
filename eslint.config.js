// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SERVER_MODULES = [
  'auth',
  'agents',
  'sessions',
  'rooms',
  'tasks',
  'schedules',
  'knowledge',
  'models',
  'devices',
  'notify',
  'updates',
  'audit',
  'plugins',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/contracts/generated/**',
      'data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The web client runs in the browser; its build/test configs and e2e harness run on Node.
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: [
      'packages/web/{tests,e2e}/**/*.{ts,tsx}',
      'packages/web/*.ts',
      'packages/ui-tokens/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Server modules must not reach into app composition or into each other's internals
    // (ARCHITECTURE §Modules): a sibling module is imported through its index.ts only.
    files: ['packages/server/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/app/*', '**/app'],
              message: 'Modules never import app/ (ARCHITECTURE §Modules).',
            },
            {
              group: [
                ...SERVER_MODULES.map((name) => `../${name}/*`),
                ...SERVER_MODULES.map((name) => `!../${name}/index.js`),
              ],
              message: 'Import a sibling module through its index.js only.',
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * The UI policy of docs/clients/DESIGN.md, enforced instead of reviewed.
     *
     * A screen never reaches for a primitive or for the browser's own furniture: the
     * native popups look nothing like the product, ignore the tokens, and are wrong in
     * dark mode and in Arabic. Everything interactive comes from `packages/web/src/ui/`,
     * which is the one place allowed to touch `radix-ui` and the raw elements (see the
     * exemption below). Adding a control means adding it there, once.
     */
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'alert',
          message: 'Use a Notice or our dialog (src/ui/ConfirmDialog.tsx), never alert().',
        },
        {
          name: 'confirm',
          message: 'Use useConfirm() from src/ui/ConfirmDialog.tsx, never confirm().',
        },
        {
          name: 'prompt',
          message: 'Ask inside the page with our own field, never prompt().',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name=/^(alert|confirm|prompt)$/]",
          message:
            "window.alert/confirm/prompt are the browser's modals; use src/ui/ConfirmDialog.tsx.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: 'A native <select> paints the OS popup; use <Select> from src/ui/Select.tsx.',
        },
        {
          selector: "JSXOpeningElement[name.name='option']",
          message: 'Options belong to <Select> from src/ui/Select.tsx, not to a native <select>.',
        },
        {
          selector: "JSXOpeningElement[name.name='optgroup']",
          message: "Use a SelectOption's `group` field with <Select> from src/ui/Select.tsx.",
        },
        {
          selector: "JSXOpeningElement[name.name='dialog']",
          message: 'Use our dialog (src/ui/ConfirmDialog.tsx), never the native <dialog>.',
        },
        {
          selector:
            "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value=/^(checkbox|radio)$/]",
          message:
            'A native checkbox or radio ignores the tokens; use <Checkbox> from src/ui/Checkbox.tsx or <Segmented> from src/ui/Segmented.tsx.',
        },
        {
          // A `title` prop on one of our components is fine (it reaches our Tooltip); on a
          // host element it is the browser's tooltip, which is the thing being banned.
          selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='title']",
          message:
            'title= is the browser tooltip; wrap the element in <Tooltip> from src/ui/Tooltip.tsx.',
        },
        {
          selector: 'ImportDeclaration[source.value=/^(radix-ui|@radix-ui\\/)/]',
          message:
            'Only packages/web/src/ui/ imports a primitive; screens import the wrapper (DESIGN §UI policy).',
        },
      ],
    },
  },
  {
    // `src/ui/` is the exemption: it is the layer that wraps the primitives and the raw
    // elements, so that no other file has to.
    files: ['packages/web/src/ui/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
