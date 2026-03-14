/**
 * Shared ESLint Configuration for the Trading Intelligence Monorepo
 *
 * This file provides the base ESLint rules consumed by all workspace packages
 * and applications (apps/api, apps/web, packages/*). It uses the ESLint v9.x
 * flat config format (array of config objects) and enforces:
 *
 * - TypeScript strict linting (no `any` types, no unused vars)
 * - ESM module conventions
 * - Pino logger preference over console.log
 * - Modern JavaScript best practices (prefer-const, no-var)
 *
 * @see AAP Rule 0.7.1 — TypeScript strict mode, no `any` types
 * @see AAP Section 0.3.1 — ESLint ^9.x flat config format
 */

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Shared ESLint flat config array.
 *
 * Config object #1: Global ignore patterns for build artifacts and dependencies.
 * Config object #2: TypeScript/JavaScript linting rules with parser and plugin setup.
 *
 * Usage in consuming configs:
 * ```js
 * import sharedConfig from '@trading-intelligence/config/eslint';
 * export default [...sharedConfig, { /* project-specific overrides * / }];
 * ```
 */
const sharedEslintConfig = [
  // ─── Global Ignores ────────────────────────────────────────────────
  // Applies to all linted files; prevents ESLint from scanning
  // build outputs, dependency folders, and cache directories.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.turbo/**',
      'coverage/**',
    ],
  },

  // ─── TypeScript + JavaScript Rules ─────────────────────────────────
  // Applies to all .ts, .tsx, .js, and .jsx files in the workspace.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],

    languageOptions: {
      // TypeScript ESLint parser for full type-aware linting
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // Enable type-aware linting — resolves tsconfig.json per-project
        project: true,
      },
      // Node.js global variables (process, console, __dirname, etc.)
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        EventTarget: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
      },
    },

    // Explicit plugin registration required by ESLint v9.x flat config format
    plugins: {
      '@typescript-eslint': tseslint,
    },

    rules: {
      // ── @typescript-eslint/recommended baseline ──────────────────
      // Spread the recommended ruleset from @typescript-eslint v8.x
      // which includes rules like ban-ts-comment, no-array-constructor,
      // no-duplicate-enum-values, no-empty-object-type, etc.
      ...tseslint.configs.recommended.rules,

      // ── AAP Rule 0.7.1: No `any` types ──────────────────────────
      // MANDATORY — "No `any` types permitted; use `unknown` with type guards"
      // The recommended config already sets this to "error", but we
      // explicitly declare it here to make the policy crystal clear.
      '@typescript-eslint/no-explicit-any': 'error',

      // ── Unused variables with underscore exception ───────────────
      // Allow underscore-prefixed parameters (e.g., _req, _next) which
      // is a common pattern for required but intentionally unused handler
      // parameters in Express middleware and callback signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],

      // ── Console usage warning ────────────────────────────────────
      // Warn (not error) on console.log/warn/error to encourage use of
      // the Pino structured logger per AAP observability requirements.
      // Set to "warn" for gradual adoption during development.
      'no-console': 'warn',

      // ── Modern JavaScript best practices ─────────────────────────
      // Enforce const for variables that are never reassigned
      'prefer-const': 'error',

      // Forbid var declarations; use let or const instead
      'no-var': 'error',
    },
  },
];

export default sharedEslintConfig;
