import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    // The Lab page's results glob reads a fixture, so tests never depend on a real benchmark run.
    resolve: { alias: { '@bench-results': fileURLToPath(new URL('./test/fixtures/bench-results', import.meta.url)) } },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
      // userEvent-driven page tests take ~1 s each, several times that on a loaded machine; the
      // 5 s default made them time out there (the API suite already allows 20 s).
      testTimeout: 20_000,
    },
  }),
);
