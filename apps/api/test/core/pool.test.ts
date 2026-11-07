import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { createPool } from '../../src/db';

describe('createPool', () => {
  it('waits for a free connection as long as PG_CONNECT_TIMEOUT_MS says', async () => {
    const pool = createPool(loadConfig({ PG_CONNECT_TIMEOUT_MS: '7000', PG_POOL_MAX: '3' }));
    try {
      expect((pool.options as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(7000);
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });
});
