import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The committed benchmark results the Lab page bundles (pages/Lab.tsx). vitest.config.ts
      // points it at a fixture instead.
      '@bench-results': fileURLToPath(new URL('../../loadtest/results', import.meta.url)),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    // Same-origin API in development: the session cookie and the CSRF Origin check just work.
    proxy: { '/api': { target: 'http://localhost:4200' } },
  },
  preview: { port: 5175, strictPort: true },
});
