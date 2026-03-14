import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: '.',
  modules: [],
  vite: () => ({
    plugins: [preact()],
    resolve: {
      alias: {
        'react': 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
  }),
  manifest: {
    name: 'GMGN Signal Bot',
    description: 'Automated memecoin trading signal generation for GMGN.ai',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'alarms',
      'offscreen',
      'activeTab',
    ],
    host_permissions: [
      'https://gmgn.ai/*',
      'https://public-api.birdeye.so/*',
      'https://api.helius.xyz/*',
      'https://api.rugcheck.xyz/*',
      'https://api.gopluslabs.io/*',
      'https://price.jup.ag/*',
      'https://api.dexscreener.com/*',
      'https://api.groq.com/*',
      'https://api.anthropic.com/*',
    ],
  },
});
