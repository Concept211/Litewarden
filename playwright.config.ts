// SPDX-License-Identifier: GPL-3.0-only
// E2E: the built extension (npm run build) loaded unpacked into Chromium, against the throwaway test servers
// (npm run testserver:start) and the local login-form corpus. Never a real vault.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: '_testserver/e2e-results',
  webServer: { command: 'node tests/pages/server.mjs 8411', url: 'http://127.0.0.1:8411/stacked.html', reuseExistingServer: true },
});
