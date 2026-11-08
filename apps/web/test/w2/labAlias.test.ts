// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Lab results in the production build', () => {
  it('maps @bench-results to loadtest/results, the folder run-bench.sh and summarize.mjs write', () => {
    const alias = (viteConfig.resolve?.alias as Record<string, string> | undefined)?.['@bench-results'];
    expect(alias && path.resolve(alias)).toBe(path.join(repoRoot, 'loadtest', 'results'));
  });
});
