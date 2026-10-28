// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Api, compareVersions, normalizeServerUrl, parsePrelogin, type Cipher, type SyncResponse } from '../../src/core/api';
import { b64encode } from '../../src/core/bytes';
import { webCrypto as C } from '../../src/core/crypto';
import { ServerUnreachable, TwoFactorRequired, UnsupportedKeyFormat, WrongPassword, WrongTwoFactorCode } from '../../src/core/errors';
import { assertSupportedAccount, decryptItem, decryptList, loadKeys, unlockWithPassword } from '../../src/core/vault';

/** A fake fetch that answers from a route table. */
function fakeFetch(routes: Record<string, (body: string | undefined) => [number, unknown]>, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? 'GET'} ${u.pathname}`;
    seen.push(key);
    const h = routes[key];
    const [status, data] = h ? h(init?.body as string | undefined) : [404, null];
    return new Response(data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data), { status });
  }) as typeof fetch;
}

describe('server URL and versions', () => {
  it('normalizes what people paste', () => {
    expect(normalizeServerUrl('vault.home.arpa')).toBe('https://vault.home.arpa');
    expect(normalizeServerUrl(' https://vault.example.com/#/login ')).toBe('https://vault.example.com');
    expect(normalizeServerUrl('http://127.0.0.1:8301/')).toBe('http://127.0.0.1:8301');
    expect(normalizeServerUrl('https://example.com/vw/')).toBe('https://example.com/vw');
  });
  it('compares versions numerically', () => {
    expect(compareVersions('1.37.4', '1.35.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.35', '1.35.0')).toBe(0);
  });
});

describe('prelogin', () => {
  it('reads flat, nested and PascalCase shapes', () => {
    expect(parsePrelogin({ kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null })).toEqual({ kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null });
    expect(parsePrelogin({ kdfSettings: { kdfType: 1, iterations: 3, memory: 64, parallelism: 4 }, salt: null })).toEqual({ kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 });
    expect(parsePrelogin({ Kdf: 0, KdfIterations: 100000 }).kdfIterations).toBe(100000);
  });
  it('falls back through the endpoints in order', async () => {
    const seen: string[] = [];
    const api = new Api('http://test.local', { fetch: fakeFetch({ 'POST /api/accounts/prelogin': () => [200, { kdf: 0, kdfIterations: 600000 }] }, seen) });
    const p = await api.prelogin('a@b.c');
    expect(p.endpoint).toBe('/api/accounts/prelogin');
    expect(seen).toEqual(['POST /identity/accounts/prelogin/password', 'POST /identity/accounts/prelogin', 'POST /api/accounts/prelogin']);
  });
  it('a network failure is ServerUnreachable', async () => {
    const api = new Api('http://test.local', { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(api.prelogin('a@b.c')).rejects.toBeInstanceOf(ServerUnreachable);
  });
});

describe('server info', () => {
  const routes = (version: string) => ({
    'GET /api/config': (): [number, unknown] => [200, { version: '2026.6.0', server: { name: 'Vaultwarden', url: 'x' } }],
    'GET /api/version': (): [number, unknown] => [200, version],
  });
  it('reports Vaultwarden version and flags old servers', async () => {
    const ok = await new Api('http://t.local', { fetch: fakeFetch(routes('1.37.4')) }).serverInfo();
    expect(ok).toMatchObject({ name: 'Vaultwarden', version: '1.37.4', apiVersion: '2026.6.0', isVaultwarden: true, tooOld: false });
    const old = await new Api('http://t.local', { fetch: fakeFetch(routes('1.34.3')) }).serverInfo();
    expect(old.tooOld).toBe(true);
  });
  it('Bitwarden servers are not version-checked', async () => {
    const info = await new Api('http://t.local', { fetch: fakeFetch({ 'GET /api/config': () => [200, { version: '2026.9.0', server: null }] }) }).serverInfo();
    expect(info).toMatchObject({ name: 'Bitwarden', isVaultwarden: false, version: null, tooOld: false });
  });
});

describe('login errors', () => {
  it('maps the 2FA challenge, wrong password and wrong code', async () => {
    const twoFa = new Api('http://t.local', { fetch: fakeFetch({ 'POST /identity/connect/token': () => [400, { error: 'invalid_grant', TwoFactorProviders: ['0'], TwoFactorProviders2: { '0': null } }] }) });
    await expect(twoFa.loginPassword('a@b.c', 'h')).rejects.toMatchObject({ name: 'TwoFactorRequired', providers: [0] });
    await expect(twoFa.loginPassword('a@b.c', 'h')).rejects.toBeInstanceOf(TwoFactorRequired);
    await expect(twoFa.loginPassword('a@b.c', 'h', { provider: 0, token: '000000' })).rejects.toBeInstanceOf(WrongTwoFactorCode);
    const wrong = new Api('http://t.local', { fetch: fakeFetch({ 'POST /identity/connect/token': () => [400, { message: 'Username or password is incorrect. Try again', error: 'invalid_grant', error_description: '' }] }) });
    await expect(wrong.loginPassword('a@b.c', 'h')).rejects.toBeInstanceOf(WrongPassword);
  });
  it('stores tokens and refreshes once on 401', async () => {
    let calls = 0;
    const saved: unknown[] = [];
    const api = new Api('http://t.local', {
      onTokens: (t) => saved.push(t),
      fetch: fakeFetch({
        'POST /identity/connect/token': (body) => (body?.includes('refresh_token') ? [200, { access_token: 'B', refresh_token: 'R2' }] : [200, { access_token: 'A', refresh_token: 'R1', Key: 'k' }]),
        'GET /api/sync': () => (++calls === 1 ? [401, null] : [200, { ciphers: [] }]),
      }),
    });
    await api.loginPassword('a@b.c', 'h');
    await api.sync();
    expect(api.tokens?.access_token).toBe('B');
    expect(saved).toHaveLength(2);
  });
});

/** Build a small encrypted vault the way a server would hold it. */
async function makeVault() {
  const email = 'test@litewarden.local';
  const password = 'pw-for-unit-tests';
  const kdf = { kdf: 0, kdfIterations: 5000 };
  const mk = await C.deriveMasterKey(password, email, kdf);
  const userKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const userKey = C.symKey(userKeyRaw);
  const encUserKey = await C.encryptBytes(userKeyRaw, await C.stretchMasterKey(mk));
  const pair = await C.generateRsaPair();
  const orgKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const orgKey = C.symKey(orgKeyRaw);
  const itemKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const e = (s: string, k = userKey) => C.encryptString(s, k);
  const login = async (id: string, name: string, k = userKey, extra: Partial<Cipher> = {}): Promise<Cipher> => ({
    id, type: 1, organizationId: null, folderId: null, name: await e(name, k), notes: await e('note ' + name, k),
    login: { username: await e('user-' + id, k), password: await e('pw-' + id, k), totp: id === 'a' ? await e('JBSWY3DPEHPK3PXP', k) : null, uris: [{ uri: await e(`https://${id}.example.com`, k), match: null }] },
    ...extra,
  });
  const ciphers: Cipher[] = [
    await login('a', 'Alpha'),
    { ...(await login('b', 'Org item', orgKey)), organizationId: 'org1' },
    { ...(await login('c', 'Item key', C.symKey(itemKeyRaw))), key: await C.encryptBytes(itemKeyRaw, userKey) },
    { ...(await login('d', 'Broken')), name: (await e('Broken')).replace(/.$/, 'A') }, // bad MAC
    { ...(await login('e', 'Deleted')), deletedDate: '2026-01-01T00:00:00Z' },
    { id: 'f', type: 3, organizationId: null, folderId: null, name: await e('Visa'), notes: null, card: { brand: await e('Visa'), number: await e('4111111111111111') } },
  ];
  const sync: SyncResponse = {
    profile: {
      id: 'u', email, key: encUserKey, privateKey: await C.encryptBytes(pair.privateDer, userKey),
      organizations: [{ id: 'org1', name: 'Org', key: await C.rsaEncrypt(orgKeyRaw, pair.publicDer) }, { id: 'org2', name: 'Bad', key: '4.' + b64encode(new Uint8Array(256)) }],
    },
    folders: [], collections: [], ciphers,
  };
  return { email, password, kdf, encUserKey, sync };
}

describe('vault', () => {
  it('unlocks, unwraps org keys, decrypts the list and isolates failures', async () => {
    const v = await makeVault();
    const { userKey } = await unlockWithPassword(C, v.password, v.email, v.kdf, v.encUserKey);
    const keys = await loadKeys(C, v.sync, userKey);
    expect(keys.orgKeys.has('org1')).toBe(true);
    expect(keys.orgKeyErrors.has('org2')).toBe(true);
    const { items, failures } = await decryptList(C, v.sync.ciphers, keys);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(['a', 'b', 'c', 'f']);
    expect(byId.a).toMatchObject({ name: 'Alpha', username: 'user-a', hasTotp: true, uris: [{ uri: 'https://a.example.com', match: null }] });
    expect(byId.b!.orgId).toBe('org1');
    expect(byId.c!.name).toBe('Item key');
    expect(byId.f!.subtitle).toBe('Visa •1111');
    expect(failures.map((f) => f.id)).toEqual(['d']);
    // list stage never holds secrets
    expect(JSON.stringify(items)).not.toMatch(/pw-a|JBSWY3DP|note Alpha/);
    const full = await decryptItem(C, v.sync.ciphers[0]!, keys);
    expect(full.login).toMatchObject({ password: 'pw-a', totp: 'JBSWY3DPEHPK3PXP' });
    expect(full.notes).toBe('note Alpha');
  });
  it('a wrong master password fails the unwrap', async () => {
    const v = await makeVault();
    await expect(unlockWithPassword(C, 'nope', v.email, v.kdf, v.encUserKey)).rejects.toThrow(/Integrity check failed/);
  });
  it('refuses V2 account keys and COSE user keys in plain words', () => {
    expect(() => assertSupportedAccount('2.a|b|c', { signatureKeyPair: { x: 1 } })).toThrow(UnsupportedKeyFormat);
    expect(() => assertSupportedAccount('7.AAAA', null)).toThrow(/newer encryption format/);
    expect(() => assertSupportedAccount('2.a|b|c', { publicKeyEncryptionKeyPair: {}, signatureKeyPair: null, securityState: null })).not.toThrow();
  });
});
