import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps,tests}/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
