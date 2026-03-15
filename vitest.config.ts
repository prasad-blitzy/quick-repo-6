/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

/**
 * Vitest Test Runner Configuration for GMGN Signal Bot Chrome Extension
 *
 * Configures:
 * - happy-dom test environment for lightweight DOM simulation
 * - Global test APIs (describe, it, expect) without explicit imports
 * - V8 coverage provider for source code and entrypoint coverage
 * - Path aliases mirroring tsconfig.json (@/, @/signals/, @/api/, @/store/)
 * - Preact JSX transformation via @preact/preset-vite plugin
 * - React-to-preact/compat aliasing for Zustand hook compatibility
 * - Chrome API mock setup for extension-specific test environments
 */
export default defineConfig({
  plugins: [
    /**
     * Preact Vite plugin — required independently from wxt.config.ts because
     * vitest.config.ts is a standalone Vite configuration. Handles JSX/TSX
     * transformation for Preact components during test execution, and provides
     * automatic React-to-preact/compat aliasing for libraries (e.g., Zustand)
     * that depend on React APIs.
     */
    preact(),
  ],

  resolve: {
    alias: {
      /**
       * Path aliases matching tsconfig.json paths configuration.
       * Vite's resolve.alias requires absolute filesystem paths for
       * directory-based aliases to resolve correctly during test execution.
       */
      '@': resolve(__dirname, './src'),
      '@/signals': resolve(__dirname, './src/signals'),
      '@/api': resolve(__dirname, './src/api'),
      '@/store': resolve(__dirname, './src/store'),

      /**
       * Preact compatibility aliases — redirects React imports to preact/compat.
       * Required for libraries like Zustand that internally import from 'react'
       * and 'react-dom'. This ensures those imports resolve to Preact's
       * compatibility layer during test execution.
       */
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },

  test: {
    /**
     * happy-dom — lightweight DOM implementation for component testing.
     * Significantly faster than jsdom while providing sufficient DOM API
     * coverage for Preact component rendering and Shadow DOM simulation.
     * Per AAP Section 0.3.1 specification.
     */
    environment: 'happy-dom',

    /**
     * Enable global test APIs (describe, it, expect, vi, beforeEach, afterEach, etc.)
     * without requiring explicit imports in every test file. This matches the
     * conventional testing ergonomics expected by the test suite.
     */
    globals: true,

    /**
     * Test file include patterns — matches all unit, integration, and component
     * test files within the tests/ directory tree. Supports both .ts (pure logic)
     * and .tsx (Preact component) test files.
     */
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
    ],

    /**
     * Directories excluded from test file discovery. Prevents vitest from
     * scanning build artifacts, WXT cache, and dependency directories.
     */
    exclude: [
      'node_modules',
      '.output',
      '.wxt',
      'dist',
    ],

    /**
     * Global test setup files executed before each test file.
     * Provides Chrome Extension API mocks (chrome.storage, chrome.runtime,
     * chrome.alarms, chrome.tabs) required by extension-specific modules.
     */
    setupFiles: [
      'tests/setup.ts',
    ],

    /**
     * V8 code coverage configuration — uses the built-in V8 coverage engine
     * for accurate line, branch, and function coverage reporting across
     * source code and entrypoint files.
     */
    coverage: {
      /** V8 coverage provider — fast and accurate, native to Node.js */
      provider: 'v8',

      /** Coverage report formats: text for CLI, JSON for CI tools, HTML for browsing */
      reporter: ['text', 'json', 'html'],

      /**
       * Source files included in coverage measurement — covers all TypeScript
       * and TSX source modules in src/ and Chrome Extension entrypoints.
       */
      include: [
        'src/**/*.ts',
        'src/**/*.tsx',
        'entrypoints/**/*.ts',
        'entrypoints/**/*.tsx',
      ],

      /**
       * Files excluded from coverage:
       * - Declaration files (.d.ts) — no executable logic
       * - Test files — measuring coverage of tests is circular
       * - Type-only modules (types.ts) — contain only interfaces and type aliases
       */
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/**/types.ts',
      ],
    },
  },
});
