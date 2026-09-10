import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web uses Next.js's `@/` convention; vitest needs the same mapping
      // so its server-side modules can be tested outside the Next runtime.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    include: ['{packages,apps,tests}/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
