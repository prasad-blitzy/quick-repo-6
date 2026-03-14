/**
 * Root ESLint Configuration — Trading Intelligence Monorepo
 *
 * This is the canonical root ESLint configuration for the entire Turborepo +
 * pnpm workspaces monorepo. It uses the ESLint v9.x flat config format (array
 * of config objects) and orchestrates:
 *
 * 1. Shared base rules from `packages/config/eslint.js` (ignores, TypeScript
 *    parser, plugin registration, no-console, no-explicit-any, no-unused-vars,
 *    prefer-const, no-var).
 * 2. Root-level overrides that add Node.js built-in AND browser global variable
 *    definitions — both environments coexist in this monorepo (apps/api runs
 *    Node.js, apps/web runs in browsers).
 * 3. The `@typescript-eslint/explicit-function-return-type` rule set to "off"
 *    to allow TypeScript's type inference for function return types, improving
 *    developer ergonomics without sacrificing type safety (the compiler still
 *    infers and enforces return types).
 * 4. Relaxed rules for test files — `no-explicit-any` and `no-console` are
 *    disabled in test/spec files where mocking and debug logging are expected.
 *
 * Per-app and per-package ESLint configs (if any) should import this root
 * config and add their own overrides.
 *
 * @see packages/config/eslint.js — Shared base ESLint configuration
 * @see AAP Section 0.5.1 Group 1 — Root-level configuration files
 * @see AAP Rule 0.7.1 — TypeScript strict mode, no `any` types permitted
 * @see AAP Rule 0.7.2 — Financial data precision (strict types)
 */

// ─── External Imports ────────────────────────────────────────────────────────
// TypeScript ESLint parser — enables ESLint to parse .ts/.tsx files with full
// type awareness, supporting TypeScript-specific syntax and type information.
import tsparser from '@typescript-eslint/parser';

// TypeScript ESLint plugin — provides the recommended rule set and TypeScript-
// specific rules (no-explicit-any, no-unused-vars, etc.). The `configs`
// property exposes pre-defined rule collections for spreading into flat config.
import tseslint from '@typescript-eslint/eslint-plugin';

// Global variable definitions — provides per-environment globals (Node.js
// built-ins, browser APIs) so ESLint does not flag legitimate global references
// as "no-undef" errors. Required for ESLint v9 flat config since environment
// definitions are no longer bundled.
import globals from 'globals';

// ─── Internal Imports ────────────────────────────────────────────────────────
// Shared ESLint flat config array from the monorepo's config package. Contains
// global ignore patterns (node_modules, dist, .turbo, coverage), TypeScript
// parser and plugin setup, and base rules for the entire monorepo.
import sharedEslintConfig from './packages/config/eslint.js';

// ─── Root ESLint Flat Config ─────────────────────────────────────────────────

/**
 * Complete root ESLint flat config array for the Trading Intelligence monorepo.
 *
 * Config objects are applied in order — later objects override earlier ones for
 * the same files and properties. The structure is:
 *
 * 1. Shared config (ignores + parser + plugin + base rules)
 * 2. Root overrides (globals + explicit-function-return-type)
 * 3. Test file relaxations (allow any + console in tests)
 *
 * @type {import('eslint').Linter.Config[]}
 */
const eslintConfig = [
  // ── 0. Root-Level Global Ignores ───────────────────────────────────────────
  // Supplement the shared config ignores with deep-match patterns. The shared
  // config uses `dist/**` which only matches the root dist/ folder. These
  // patterns ensure build artifacts in ALL workspace packages are ignored
  // (e.g., packages/types/dist/, packages/utils/dist/).
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  // ── 1. Shared Base Configuration ───────────────────────────────────────────
  // Spread the shared config array from packages/config/eslint.js.
  // This includes:
  //   - Config #1: Global ignores (node_modules, dist, .turbo, coverage)
  //   - Config #2: File patterns (.ts, .tsx, .js, .jsx), TypeScript parser,
  //     @typescript-eslint plugin, and all base rules:
  //       • @typescript-eslint/recommended rule set (spread)
  //       • @typescript-eslint/no-explicit-any: "error"
  //       • @typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_" }]
  //       • no-console: "warn"
  //       • prefer-const: "error"
  //       • no-var: "error"
  ...sharedEslintConfig,

  // ── 2. Root-Level Overrides ────────────────────────────────────────────────
  // Applies to all TypeScript and JavaScript files in the monorepo.
  // Adds environment globals and root-specific rule overrides.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],

    languageOptions: {
      // Re-declare the TypeScript parser for root-level config consistency.
      // The shared config already sets this, but we explicitly reference it
      // here to ensure the parser is applied even if overrides are consumed
      // independently.
      parser: tsparser,

      // Merge Node.js built-in globals and browser globals.
      // - nodeBuiltin: process, Buffer, console, setTimeout, __dirname, etc.
      //   Required for apps/api backend code.
      // - browser: window, document, navigator, localStorage, fetch, etc.
      //   Required for apps/web frontend code.
      //
      // Both are spread because both environments exist in this monorepo.
      // ESLint flat config merges globals from multiple config objects, so
      // files in apps/api will correctly see Node.js globals and files in
      // apps/web will correctly see browser globals.
      globals: {
        ...globals.nodeBuiltin,
        ...globals.browser,
      },
    },

    // Explicit plugin registration for the root config object.
    // Required by ESLint v9.x flat config — plugins must be registered as
    // key-value pairs where the key is the rule prefix and the value is the
    // plugin module.
    plugins: {
      '@typescript-eslint': tseslint,
    },

    rules: {
      // Spread the @typescript-eslint/recommended rule set to ensure all
      // recommended TypeScript rules are active at the root level. This
      // includes ban-ts-comment, no-array-constructor, no-duplicate-enum-values,
      // no-empty-object-type, no-explicit-any, no-extra-non-null-assertion,
      // no-misused-new, no-namespace, no-non-null-asserted-optional-chain,
      // no-require-imports, no-this-alias, no-unnecessary-type-constraint,
      // no-unsafe-declaration-merging, no-unsafe-function-type, no-unused-vars,
      // no-wrapper-object-types, and prefer-as-const.
      ...tseslint.configs.recommended.rules,

      // ─ AAP Rule 0.7.1: No `any` types ─────────────────────────────────
      // Explicitly set to "error" to enforce the AAP mandate:
      // "No `any` types permitted; use `unknown` with type guards"
      // The recommended config already sets this, but we declare it here
      // for absolute clarity and to prevent accidental overrides.
      '@typescript-eslint/no-explicit-any': 'error',

      // ─ Unused variables with underscore exception ──────────────────────
      // Allow underscore-prefixed parameters (e.g., _req, _next, _err) which
      // are a common pattern for required but intentionally unused handler
      // parameters in Express middleware, callback signatures, and event
      // handlers throughout the backend and frontend.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],

      // ─ Explicit function return types: OFF ─────────────────────────────
      // Disabled to allow TypeScript's powerful type inference for function
      // return types. This improves developer ergonomics without sacrificing
      // type safety — the TypeScript compiler still infers and enforces
      // return types. Explicit annotations are only needed where inference
      // cannot determine the type (e.g., overloaded functions, complex
      // generics).
      '@typescript-eslint/explicit-function-return-type': 'off',

      // ─ Console usage warning ───────────────────────────────────────────
      // Warn (not error) on console.log/warn/error to encourage use of the
      // Pino structured logger per AAP observability requirements (Section
      // 0.1.1: "Pino structured logging"). Set to "warn" for gradual
      // adoption during development.
      'no-console': 'warn',

      // ─ Modern JavaScript best practices ────────────────────────────────
      // Enforce const for variables that are never reassigned
      'prefer-const': 'error',

      // Forbid var declarations; use let or const instead
      'no-var': 'error',
    },
  },

  // ── 3. Root-Level Config Files Override ──────────────────────────────────────
  // Root-level JavaScript config files (.eslintrc.js, eslint.config.js,
  // packages/config/eslint.js) are plain JS that do not need TypeScript
  // project-based type checking. The shared config sets `parserOptions.project:
  // true` which requires a tsconfig.json — these files are not covered by any
  // tsconfig. Disable project mode for these specific files.
  {
    files: [
      '*.js',
      '*.mjs',
      '*.cjs',
      'packages/config/*.js',
    ],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
  },

  // ── 4. Test File Rule Relaxations ──────────────────────────────────────────
  // Test files (*.test.ts, *.spec.ts, tests/**) have relaxed rules because:
  // - Mocking libraries often require `any` for flexible mock types
  // - Console logging is useful for test debugging and CI output
  // - Test assertions may need loose typing for edge case validation
  // - Test files are excluded from app tsconfig.json ("exclude": ["tests/**"])
  //   so project-based type-aware linting is disabled here to prevent
  //   "file not found in any of the provided project(s)" parser errors.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/tests/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        // Disable project-based type-aware linting for test files because
        // per-app tsconfig.json files exclude test directories. Without this
        // override, ESLint throws "file not found in any provided project(s)".
        project: false,
      },
    },
    rules: {
      // Allow `any` in test files for mock object construction and
      // flexible assertion patterns
      '@typescript-eslint/no-explicit-any': 'off',

      // Allow console.log in tests for debugging output and test runner
      // compatibility
      'no-console': 'off',
    },
  },
];

export default eslintConfig;
