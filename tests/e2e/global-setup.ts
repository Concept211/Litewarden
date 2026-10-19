// SPDX-License-Identifier: GPL-3.0-only
import { liveVersions } from '../../scripts/testserver/env';
import { ensureAccounts } from './accounts';

export default async function () {
  const want = (process.env.E2E_VERSIONS ?? '1.37.4').split(',');
  const up = await liveVersions();
  const missing = want.filter((v) => !up.includes(v));
  if (missing.length) throw new Error(`Test servers not running: ${missing.join(', ')}. Start them: npm run testserver:start`);
  for (const v of want) await ensureAccounts(v);
}
