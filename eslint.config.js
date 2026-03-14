/**
 * Root ESLint Configuration — Trading Intelligence Monorepo
 *
 * This file is the root ESLint configuration for the entire Turborepo + pnpm
 * workspaces monorepo. It imports the shared ESLint flat config from
 * `@trading-intelligence/config/eslint` and adds root-level overrides for
 * environment-specific globals (Node.js backend vs. browser frontend).
 *
 * Uses ESLint v9.x flat config format (array of config objects).
 *
 * @see packages/config/eslint.js — Shared base configuration
 * @see AAP Section 0.5.1 Group 1 — Root ESLint config requirement
 * @see AAP Rule 0.7.1 — TypeScript strict mode, no `any` types
 */

import sharedConfig from './packages/config/eslint.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // ─── Spread all shared base rules ──────────────────────────────────
  // Includes global ignores, TypeScript parser, @typescript-eslint plugin,
  // no-explicit-any:error, no-unused-vars with _ exception, no-console:warn,
  // prefer-const:error, no-var:error.
  ...sharedConfig,

  // ─── Frontend Browser Globals Override ─────────────────────────────
  // Adds browser-specific global variables for files under apps/web/
  // so that references to `window`, `document`, `localStorage`, etc.
  // do not trigger ESLint "no-undef" errors.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        FocusEvent: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        history: 'readonly',
        location: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
      },
    },
  },

  // ─── Test Files Relaxed Rules ──────────────────────────────────────
  // Test files may use `any` for mocking and may log to console for debugging.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/tests/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
