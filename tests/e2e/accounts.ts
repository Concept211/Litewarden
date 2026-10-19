// SPDX-License-Identifier: GPL-3.0-only
// E2E accounts on the throwaway test servers (never the real vault):
//  - e2e@:      the seeded 2,000-item vault plus logins for the local test-page corpus (corpus.lw.test)
//  - empty@:    an empty vault
//  - twofa@:    a small vault behind authenticator two-step login
import fs from 'node:fs';
import path from 'node:path';
import { Api } from '../../src/core/api';
import { webCrypto as C } from '../../src/core/crypto';
import { totp } from '../../src/core/totp';
import { genPersonalItems, type SeedItem } from '../../scripts/testserver/content.mjs';
import { ROOT, serverUrl } from '../../scripts/testserver/env';
import { buildCipher, loginAccount, register } from '../../scripts/testserver/seed';

export const CORPUS_PORT = 8411;
export const CORPUS = `http://corpus.lw.test:${CORPUS_PORT}`;
/** A different site, for the cross-origin iframe page. */
export const OTHER = `http://frames.example-lw.test:${CORPUS_PORT}`;

export interface E2ECreds {
  main: { email: string; password: string };
  empty: { email: string; password: string };
  twofa: { email: string; password: string; secret?: string };
}

const CREDS = path.join(ROOT, '_testserver', 'e2e-creds.json');
const KDF = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };

export function e2eCreds(): E2ECreds {
  if (fs.existsSync(CREDS)) return JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const pw = () => 'e2e-' + Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString('base64url');
  const c: E2ECreds = {
    main: { email: 'e2e@litewarden.local', password: pw() },
    empty: { email: 'empty@litewarden.local', password: pw() },
    twofa: { email: 'twofa@litewarden.local', password: pw() },
  };
  fs.writeFileSync(CREDS, JSON.stringify({ note: 'Throwaway e2e accounts on local test servers only.', ...c }, null, 2));
  return c;
}

/** Logins the corpus pages fill. Passwords are fake and only exist on the test servers. */
export const CORPUS_LOGINS: SeedItem[] = [
  { type: 1, name: 'Corpus · Alice', notes: 'Recovery codes are in the blue folder.', login: { username: 'alice@corpus.test', password: 'alice-Pa55-word', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: CORPUS, match: null }] } },
  { type: 1, name: 'Corpus · Bob', login: { username: 'bob', password: 'bob-S3cret!', totp: null, uris: [{ uri: CORPUS, match: null }] } },
  { type: 1, name: 'Frames · Carol', login: { username: 'carol@frames.test', password: 'carol-Fr4me', totp: null, uris: [{ uri: OTHER, match: null }] } },
] as SeedItem[];

async function addItems(server: string, a: { email: string; password: string }, items: SeedItem[]) {
  const { api, userKey } = await loginAccount(server, { ...a, kdf: KDF });
  const sync = await api.sync();
  if (sync.ciphers.length >= items.length) return sync.ciphers.length;
  const have = new Set<string>();
  for (const c of sync.ciphers) have.add(String(await C.decryptString(c.name, userKey).catch(() => '')));
  const todo = items.filter((it) => !have.has(it.name));
  if (!todo.length) return sync.ciphers.length;
  const ciphers = [];
  for (const it of todo) ciphers.push(await buildCipher(it, userKey, { encryptedFor: sync.profile.id }));
  // Import in chunks (keeps request bodies modest on older servers).
  for (let i = 0; i < ciphers.length; i += 500) await api.req('POST', '/api/ciphers/import', { json: { ciphers: ciphers.slice(i, i + 500), folders: [], folderRelationships: [] } });
  return sync.ciphers.length + todo.length;
}

export async function ensureAccounts(version: string): Promise<E2ECreds> {
  const server = serverUrl(version);
  const c = e2eCreds();
  for (const a of [c.main, c.empty, c.twofa]) await register(new Api(server), a.email, a.password, KDF);
  await addItems(server, c.main, [...CORPUS_LOGINS, ...genPersonalItems(1337, 2000)]);
  // Once two-step login is on, the seeding login needs a code; the item is already there by then.
  await addItems(server, c.twofa, CORPUS_LOGINS.slice(0, 1)).catch((e: Error) => {
    if (e.name !== 'TwoFactorRequired') throw e;
  });
  // Two-step login for twofa@ (once per server; the secret is the same everywhere so one creds file works).
  const api = new Api(server);
  const mk = await C.deriveMasterKey(c.twofa.password, c.twofa.email, await api.prelogin(c.twofa.email));
  const mph = await C.masterPasswordHash(mk, c.twofa.password);
  try {
    await api.loginPassword(c.twofa.email, mph);
    const gen = await api.req<{ key: string; enabled?: boolean }>('POST', '/api/two-factor/get-authenticator', { json: { masterPasswordHash: mph } });
    const key = c.twofa.secret ?? gen.key;
    await api.req('PUT', '/api/two-factor/authenticator', { json: { key, token: await totp(key), masterPasswordHash: mph } });
    if (!c.twofa.secret) {
      c.twofa.secret = key;
      fs.writeFileSync(CREDS, JSON.stringify({ note: 'Throwaway e2e accounts on local test servers only.', ...c }, null, 2));
    }
  } catch (err) {
    // Already protected: login asks for the code, which is what we want.
    if ((err as Error).name !== 'TwoFactorRequired') throw err;
  }
  return c;
}
