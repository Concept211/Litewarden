// SPDX-License-Identifier: GPL-3.0-only
// Seed the throwaway test servers with a deterministic ~2,000-item vault per account (+ an org with 60 items).
// Usage: npm run testserver:seed [-- --versions 1.37.4,1.35.8] [--count 2000]
// Registration is test-only: Litewarden itself never creates accounts.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Api, type Cipher, type LoginResponse } from '../../src/core/api';
import { b64decode, b64encode, randomBytes } from '../../src/core/bytes';
import { webCrypto as C } from '../../src/core/crypto';
import type { Kdf, SymKey } from '../../src/core/crypto/types';
import { FOLDERS, ORG_COLLECTIONS, genOrgItems, genPersonalItems, type SeedItem } from './content.mjs';
import { liveVersions, loadCreds, serverUrl, type TestAccount } from './env';

/** Register through whichever endpoint the server has (register/finish on current versions, legacy register before). */
export async function register(api: Api, email: string, password: string, kdf: Kdf): Promise<number> {
  const masterKey = await C.deriveMasterKey(password, email, kdf);
  const mph = await C.masterPasswordHash(masterKey, password);
  const userKeyRaw = randomBytes(64);
  const encUserKey = await C.encryptBytes(userKeyRaw, await C.stretchMasterKey(masterKey));
  const rsa = await C.generateRsaPair();
  const keys = { publicKey: b64encode(rsa.publicDer), encryptedPrivateKey: await C.encryptBytes(rsa.privateDer, C.symKey(userKeyRaw)) };
  const flat = { masterPasswordHash: mph, key: encUserKey, kdf: kdf.kdf, kdfIterations: kdf.kdfIterations, kdfMemory: kdf.kdfMemory ?? null, kdfParallelism: kdf.kdfParallelism ?? null };
  const name = email.split('@')[0];
  const tok = await api.raw('POST', '/identity/accounts/register/send-verification-email', { json: { email, name }, auth: false });
  if (tok.status === 200) {
    const r = await api.raw('POST', '/identity/accounts/register/finish', {
      json: { email, name, emailVerificationToken: tok.data, masterPasswordHint: null, keys, ...flat },
      auth: false,
    });
    return r.status;
  }
  const r = await api.raw('POST', '/identity/accounts/register', { json: { email, name, masterPasswordHint: null, keys, ...flat }, auth: false });
  return r.status;
}

export async function loginAccount(server: string, a: TestAccount) {
  const api = new Api(server);
  const kdf = await api.prelogin(a.email);
  const masterKey = await C.deriveMasterKey(a.password, a.email, kdf);
  const tok: LoginResponse = await api.loginPassword(a.email, await C.masterPasswordHash(masterKey, a.password));
  const userKey = C.symKey(await C.decryptBytes(tok.Key!, await C.stretchMasterKey(masterKey)));
  return { api, kdf, tok, userKey };
}

/** `encryptedFor` (the user id) is required on writes since Vaultwarden 1.37.4; older servers ignore it. */
async function buildCipher(it: SeedItem, baseKey: SymKey, opts: { organizationId?: string | null; encryptedFor: string }): Promise<Partial<Cipher>> {
  let key = baseKey;
  let keyField: string | null = null;
  if (it.itemKey) {
    const raw = randomBytes(64);
    keyField = await C.encryptBytes(raw, baseKey);
    key = C.symKey(raw);
  }
  const e = (v: string | null | undefined) => (v == null || v === '' ? Promise.resolve(null) : C.encryptString(v, key));
  const encObj = async (o?: Record<string, string>) => {
    if (!o) return undefined;
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(o)) out[k] = await e(v);
    return out;
  };
  const out: Record<string, unknown> = {
    type: it.type,
    organizationId: opts.organizationId ?? null,
    encryptedFor: opts.encryptedFor,
    folderId: null,
    key: keyField,
    name: await e(it.name),
    notes: await e(it.notes),
    favorite: !!it.favorite,
    reprompt: it.reprompt ?? 0,
    fields: it.fields ? await Promise.all(it.fields.map(async (f) => ({ type: f.type, name: await e(f.name), value: await e(f.value), linkedId: null }))) : null,
  };
  if (it.login) {
    out.login = {
      username: await e(it.login.username),
      password: await e(it.login.password),
      totp: await e(it.login.totp),
      uris: await Promise.all(it.login.uris.map(async (u) => ({ uri: await e(u.uri), match: u.match }))),
    };
  }
  if (it.secureNote) out.secureNote = it.secureNote;
  if (it.card) out.card = await encObj(it.card);
  if (it.identity) out.identity = await encObj(it.identity);
  return out as Partial<Cipher>;
}

export async function seedAccount(server: string, a: TestAccount, count = 2000): Promise<string> {
  const reg = await register(new Api(server), a.email, a.password, a.kdf);
  const { api, tok, userKey } = await loginAccount(server, a);
  const existing = await api.sync();
  if (existing.ciphers.length >= count) return `already seeded (${existing.ciphers.length} items; register HTTP ${reg})`;

  const items = genPersonalItems(1337, count);
  const ciphers = [];
  const folderRelationships: Array<{ key: number; value: number }> = [];
  for (const it of items) {
    ciphers.push(await buildCipher(it, userKey, { encryptedFor: existing.profile.id }));
    if (it.folderIdx != null) folderRelationships.push({ key: ciphers.length - 1, value: it.folderIdx });
  }
  const folders = await Promise.all(FOLDERS.map(async (n) => ({ name: await C.encryptString(n, userKey) })));
  await api.req('POST', '/api/ciphers/import', { json: { ciphers, folders, folderRelationships } });

  // Organization: org key wrapped with the account's RSA public key (OAEP SHA-1), two collections.
  const profile = await api.req<{ publicKey?: string }>('GET', '/api/accounts/profile');
  const pub = tok.AccountKeys?.publicKeyEncryptionKeyPair?.publicKey ?? profile.publicKey;
  if (!pub) throw new Error('no account public key');
  const orgKeyRaw = randomBytes(64);
  const orgKey = C.symKey(orgKeyRaw);
  const orgRsa = await C.generateRsaPair();
  const org = await api.req<{ id?: string; Id?: string }>('POST', '/api/organizations', {
    json: {
      name: 'Litewarden Test Org',
      billingEmail: a.email,
      planType: 0,
      key: await C.rsaEncrypt(orgKeyRaw, b64decode(pub)),
      collectionName: await C.encryptString(ORG_COLLECTIONS[0]!, orgKey),
      keys: { publicKey: b64encode(orgRsa.publicDer), encryptedPrivateKey: await C.encryptBytes(orgRsa.privateDer, orgKey) },
    },
  });
  const orgId = (org.id ?? org.Id)!;
  const sync = await api.sync();
  const cols = [sync.collections.find((c) => c.organizationId === orgId)!.id];
  const c2 = await api.req<{ id?: string; Id?: string }>('POST', `/api/organizations/${orgId}/collections`, {
    json: { name: await C.encryptString(ORG_COLLECTIONS[1]!, orgKey), groups: [], users: [], externalId: null },
  });
  cols.push((c2.id ?? c2.Id)!);
  for (const it of genOrgItems(4242, 60)) {
    const cipher = await buildCipher(it, orgKey, { organizationId: orgId, encryptedFor: existing.profile.id });
    await api.req('POST', '/api/ciphers/create', { json: { cipher, collectionIds: [cols[it.collectionIdx ?? 0]] } });
  }
  const after = await api.sync();
  return `seeded ${after.ciphers.length} items (register HTTP ${reg})`;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const versions = opt('versions')?.split(',') ?? (await liveVersions());
  if (!versions.length) throw new Error('No test servers are running. Start them with: npm run testserver:start');
  const count = Number(opt('count') ?? 2000);
  const creds = loadCreds();
  for (const v of versions) {
    for (const acct of ['pbkdf2', 'argon2'] as const) {
      const t = performance.now();
      try {
        const msg = await seedAccount(serverUrl(v), creds[acct], count);
        console.log(`${v} ${acct}: ${msg} in ${((performance.now() - t) / 1000).toFixed(1)} s`);
      } catch (err) {
        console.log(`${v} ${acct}: FAILED ${(err as Error).message}`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
