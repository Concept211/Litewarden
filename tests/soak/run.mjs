// SPDX-License-Identifier: GPL-3.0-only
// Memory soak runner. Usage:
//   npm run soak                          12 hours, a sample every 10 minutes
//   npm run soak -- --minutes 30          short run, a sample every 2 minutes
//   npm run soak -- --minutes 60 --every 5 --version 1.35.8
// Needs `npm run build` and a running, reachable test server (npm run testserver:start). Results land in
// _testserver/soak/<run>/samples.csv and summary.json.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = { ...process.env };
if (opt('minutes')) env.SOAK_MINUTES = opt('minutes');
if (opt('every')) env.SOAK_EVERY = opt('every');
if (opt('version')) env.E2E_VERSIONS = opt('version');
const r = spawnSync('npx', ['playwright', 'test', '-c', 'tests/soak/playwright.soak.config.ts'], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
