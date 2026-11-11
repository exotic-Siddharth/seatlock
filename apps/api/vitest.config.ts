import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Creates TEST_DB_NAME if missing and applies migrations once per run.
    globalSetup: ['test/global-setup.ts'],
    // Test files share one database and one Redis DB, so they run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
