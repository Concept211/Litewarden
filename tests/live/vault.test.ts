// SPDX-License-Identifier: GPL-3.0-only
// Live protocol suite: log in, sync and decrypt the seeded vault on every running test server.
// Start and seed first:  npm run testserver:start && npm run testserver:seed
// Only loopback ports 8301+ (scripts/testserver/versions.json). Never the real vault.
import { afterAll, describe, expect, it } from 'vitest';
import { Api, compareVersions } from '../../src/core/api';
import { webCrypto as C } from '../../src/core/crypto';
import { TwoFactorRequired, WrongPassword, WrongTwoFactorCode } from '../../src/core/errors';
import { totp } from '../../src/core/totp';
import { decryptItem, decryptList, loadKeys, unlockWithPassword } from '../../src/core/vault';
import { genOrgItems, genPersonalItems, type SeedItem } from '../../scripts/testserver/content.mjs';
import { liveVersions, loadCreds, serverUrl } from '../../scripts/testserver/env';
import { register } from '../../scripts/testserver/seed';

const versions = await liveVersions();
const creds = loadCreds();
const expected: SeedItem[] = [...genPersonalItems(1337, 2000), ...genOrgItems(4242, 60)];
const byName = new Map<string, SeedItem[]>();
for (const it of expected) byName.set(it.name, [...(byName.get(it.name) ?? []), it]);
const summary: Array<Record<string, string | number>> = [];
const ms = (t: number) => Math.round(performance.now() - t);

describe.skipIf(!versions.length)('live test servers', () => {
  it('found running servers', () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  describe.each(versions)('Vaultwarden %s', (version) => {
    const server = serverUrl(version);

    it('reports its version and passes the minimum', async () => {
      const info = await new Api(server).serverInfo();
      expect(info).toMatchObject({ name: 'Vaultwarden', version, isVaultwarden: true, tooOld: false });
      expect(info.apiVersion).toMatch(/^\d{4}\.\d+\.\d+$/);
    });

    it('prelogin feature detection picks the right endpoint; an unknown email gets defaults, not an error', async () => {
      const api = new Api(server);
      const p = await api.prelogin(creds.pbkdf2.email);
      // /prelogin/password arrived in 1.36.0; 1.35.x answers on /identity/accounts/prelogin.
      expect(p.endpoint).toBe(compareVersions(version, '1.36.0') >= 0 ? '/identity/accounts/prelogin/password' : '/identity/accounts/prelogin');
      expect(p).toMatchObject({ kdf: 0, kdfIterations: 600000 });
      const unknown = await api.prelogin('nobody-' + Date.now() + '@litewarden.local');
      expect(unknown.kdfIterations).toBeGreaterThan(0);
    });

    it('wrong master password is WrongPassword', async () => {
      const api = new Api(server);
      const mk = await C.deriveMasterKey('not-the-password', creds.pbkdf2.email, creds.pbkdf2.kdf);
      await expect(api.loginPassword(creds.pbkdf2.email, await C.masterPasswordHash(mk, 'not-the-password'))).rejects.toBeInstanceOf(WrongPassword);
    });

    for (const acct of ['pbkdf2', 'argon2'] as const) {
      it(`${acct}: login, sync, decrypt all 2,060 items and match the seed exactly`, async () => {
        const a = creds[acct];
        const api = new Api(server);
        let t = performance.now();
        const kdf = await api.prelogin(a.email);
        expect(kdf.kdf).toBe(a.kdf.kdf);
        const mk = await C.deriveMasterKey(a.password, a.email, kdf);
        const kdfMs = ms(t);
        const tok = await api.loginPassword(a.email, await C.masterPasswordHash(mk, a.password));
        t = performance.now();
        const sync = await api.sync();
        const syncMs = ms(t);
        t = performance.now();
        const { userKey } = await unlockWithPassword(C, a.password, a.email, kdf, tok.Key ?? sync.profile.key);
        const keys = await loadKeys(C, sync, userKey, tok.PrivateKey);
        const { items, failures } = await decryptList(C, sync.ciphers, keys);
        const listMs = ms(t);
        expect(failures).toEqual([]);
        expect(items).toHaveLength(2060);
        expect(items.map((i) => i.name).sort()).toEqual(expected.map((i) => i.name).sort());

        // Full decrypt of every item, checked field by field against the generator.
        t = performance.now();
        const byId = new Map(sync.ciphers.map((c) => [c.id, c]));
        let checked = 0;
        for (const li of items) {
          const full = await decryptItem(C, byId.get(li.id)!, keys);
          const candidates = byName.get(full.name) ?? [];
          const match = candidates.find(
            (e) =>
              (e.notes ?? null) === full.notes &&
              (e.login?.password ?? null) === (full.login?.password ?? null) &&
              (e.login?.username ?? null) === (full.login?.username ?? null) &&
              (e.login?.totp ?? null) === (full.login?.totp ?? null),
          );
          expect(match, `item "${full.name.slice(0, 40)}" matches the seed`).toBeTruthy();
          if (full.login?.totp) expect(await totp(full.login.totp)).toMatch(/^([0-9]{6,8}|[23456789BCDFGHJKMNPQRTVWXY]{5})$/);
          checked++;
        }
        const fullMs = ms(t);
        expect(checked).toBe(2060);
        expect(items.filter((i) => i.orgId)).toHaveLength(60);

        // Token refresh, and an automatic retry after a 401.
        await api.refresh();
        api.tokens!.access_token = 'expired';
        expect((await api.sync()).ciphers).toHaveLength(2060);

        summary.push({ version, account: acct, prelogin: kdf.endpoint, kdfMs, syncMs, listDecryptMs: listMs, fullDecryptMs: fullMs });
      });
    }

    it('authenticator two-step login: challenge, success, wrong code', async () => {
      const email = `2fa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@litewarden.local`;
      const password = 'throwaway-2fa-' + crypto.randomUUID();
      const kdf = { kdf: 0, kdfIterations: 600000 };
      expect(await register(new Api(server), email, password, kdf)).toBe(200);
      const api = new Api(server);
      const mk = await C.deriveMasterKey(password, email, await api.prelogin(email));
      const mph = await C.masterPasswordHash(mk, password);
      await api.loginPassword(email, mph);
      const gen = await api.req<{ key: string }>('POST', '/api/two-factor/get-authenticator', { json: { masterPasswordHash: mph } });
      await api.req('PUT', '/api/two-factor/authenticator', { json: { key: gen.key, token: await totp(gen.key), masterPasswordHash: mph } });

      const api2 = new Api(server);
      const challenge = await api2.loginPassword(email, mph).catch((e: unknown) => e);
      expect(challenge).toBeInstanceOf(TwoFactorRequired);
      expect((challenge as TwoFactorRequired).providers).toContain(0);
      await expect(api2.loginPassword(email, mph, { provider: 0, token: '000000' })).rejects.toBeInstanceOf(WrongTwoFactorCode);
      // The setup code's 30 s step is burned (replay protection); the next step is accepted (±1 step window).
      const ok = await api2.loginPassword(email, mph, { provider: 0, token: await totp(gen.key, Date.now() + 30_000) });
      expect(ok.access_token).toBeTruthy();
    });
  });
});

afterAll(() => {
  if (summary.length) console.table(summary);
  if (!versions.length) console.warn('No test servers running. Start them: npm run testserver:start && npm run testserver:seed');
});
