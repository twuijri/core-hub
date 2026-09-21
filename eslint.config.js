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
  prettier,
);
