// SPDX-License-Identifier: GPL-3.0-only
// npx tsx tests/e2e/seed-cli.ts 1.37.4 [1.35.8 ...]
import { ensureAccounts } from './accounts';
for (const v of process.argv.slice(2)) {
  const t = performance.now();
  await ensureAccounts(v);
  console.log(`${v}: e2e accounts ready in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
