import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------
  // @vitejs/plugin-react ^4.4.x enables React Fast Refresh (HMR) and the
  // automatic JSX runtime transformation so that `import React` is not
  // required in every component file (React 19 automatic runtime).
  plugins: [react()],

  // ---------------------------------------------------------------------------
  // Dev Server
  // ---------------------------------------------------------------------------
  server: {
    // Vite default dev-server port
    port: 5173,

    // API proxy — CRITICAL for development
    // Forwards all /api/* requests to the Express backend running on port 3000
    // so the frontend can call relative paths like `/api/news`, `/api/opportunities`,
    // `/api/performance`, `/api/settings/:chatId`, and `/api/health` without CORS
    // issues or hard-coded backend URLs.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Production Build
  // ---------------------------------------------------------------------------
  build: {
    // Standard output directory — matches Vercel deployment config (vercel.json)
    outDir: 'dist',

    // Enable source maps for production debugging and error tracking.
    sourcemap: true,

    // Rollup output configuration for code-splitting optimisation.
    // Combined with `React.lazy()` route-based splitting in `App.tsx`, this
    // ensures that the charting library (Recharts, ~400 KB) and core
    // React/Router framework code are isolated into dedicated vendor chunks.
    // Each chunk stays well below the 500 KB warning threshold.
    rollupOptions: {
      output: {
        manualChunks: {
          // Router — shared by every route, but small enough to justify a
          // separate chunk so updates to routing don't bust the React cache.
          'vendor-router': ['react-router-dom'],
          // Recharts — heavy charting library only used by Performance page.
          // Keeping it in its own chunk means it is only fetched when the
          // user navigates to `/performance`.
          'vendor-recharts': ['recharts'],
        },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Module Resolution
  // ---------------------------------------------------------------------------
  resolve: {
    alias: {
      // Path alias: allows `import { Foo } from '@/components/Foo'` instead of
      // deeply nested relative paths.  Must stay in sync with the `paths`
      // mapping in apps/web/tsconfig.json (`"@/*": ["./src/*"]`).
      '@': resolve(__dirname, 'src'),
    },
  },
});
