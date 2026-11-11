import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'scripts/migrate': 'src/scripts/migrate.ts',
    'scripts/seed': 'src/scripts/seed.ts',
    'scripts/seed-bench': 'src/scripts/seed-bench.ts',
    'scripts/verify-bench': 'src/scripts/verify-bench.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Each entry is self-contained, so paths built from import.meta.url
  // (dist/scripts/migrate.js -> ../../migrations) match the source layout.
  splitting: false,
  // The shared package ships TypeScript source; bundle it instead of importing it at runtime.
  noExternal: ['@seatlock/shared'],
});
