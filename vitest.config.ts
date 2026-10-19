// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 30_000 } },
      // Needs the throwaway test servers: npm run testserver:start, then npm run testserver:seed
      { test: { name: 'live', include: ['tests/live/**/*.test.ts'], environment: 'node', testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false } },
    ],
  },
});
