// SPDX-License-Identifier: GPL-3.0-only
// Shared by the seeder and the live tests: which throwaway servers exist, and the test accounts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kdf } from '../../src/core/crypto/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const CREDS_PATH = path.join(ROOT, '_testserver', 'creds.json');

export const SERVERS: Record<string, number> = JSON.parse(fs.readFileSync(path.join(here, 'versions.json'), 'utf8')).servers;

export interface TestAccount {
  email: string;
  password: string;
  kdf: Kdf;
}
export interface Creds {
  pbkdf2: TestAccount;
  argon2: TestAccount;
}

/** Throwaway accounts, generated once into the gitignored _testserver folder. */
export function loadCreds(): Creds {
  if (fs.existsSync(CREDS_PATH)) return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')) as Creds;
  const pw = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
  const creds = {
    note: 'Throwaway test accounts for local Vaultwarden test servers. Never use against a real server.',
    pbkdf2: { email: 'test@litewarden.local', password: pw(), kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } },
    argon2: { email: 'argon@litewarden.local', password: pw(), kdf: { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 } },
  };
  fs.mkdirSync(path.dirname(CREDS_PATH), { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  return creds;
}

/**
 * Base URL of the test server for `version`. Locally: the Windows binaries on loopback ports 8301+.
 * CI (or Docker anywhere): set LW_SERVER_<version with dots as underscores>, e.g.
 * LW_SERVER_1_37_4=http://127.0.0.1:8301. Anything below 8301 is refused, so a real server can't be hit by mistake.
 */
export function serverUrl(version: string): string {
  const override = process.env[`LW_SERVER_${version.replace(/\./g, '_')}`];
  if (override) {
    const u = new URL(override);
    return u.origin;
  }
  const port = SERVERS[version];
  if (!port) throw new Error(`unknown test server version ${version}`);
  if (port < 8301) throw new Error(`refusing port ${port}`);
  return `http://127.0.0.1:${port}`;
}

/** Versions whose server answers /alive right now. */
export async function liveVersions(): Promise<string[]> {
  const up: string[] = [];
  for (const v of Object.keys(SERVERS)) {
    try {
      const r = await fetch(serverUrl(v) + '/alive', { signal: AbortSignal.timeout(1500) });
      if (r.ok) up.push(v);
    } catch {
      // not running
    }
  }
  return up;
}
