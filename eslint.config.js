// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      globals: { chrome: 'readonly', document: 'readonly', window: 'readonly', MutationObserver: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' },
    },
  },
  {
    // Phase 3: `src/server/assets/*.js` is vendored/hand-written *browser* JavaScript shipped
    // as-is to the client (htmx.min.js is a third-party vendored file; app.js runs in a browser
    // with DOM globals) - neither is part of the TypeScript project the rest of this config
    // targets, so both are excluded here rather than fighting the no-undef/browser-global rules
    // meant for this repo's actual Node source.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'out/**', 'data/**', 'src/server/assets/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // Standalone Node operational scripts (curl-smoke helpers etc.) - plain Node globals, not part
    // of the TypeScript source tree.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' },
    },
  },
);
