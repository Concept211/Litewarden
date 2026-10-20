// SPDX-License-Identifier: GPL-3.0-only
// Memory soak config: one long test, the built extension, a throwaway test server and the local form corpus.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'soak.spec.ts',
  workers: 1,
  reporter: [['list']],
  globalSetup: '../e2e/global-setup.ts',
  outputDir: '../../_testserver/soak/results',
  webServer: { command: 'node tests/pages/server.mjs 8411', cwd: '../..', url: 'http://127.0.0.1:8411/stacked.html', reuseExistingServer: true },
});
