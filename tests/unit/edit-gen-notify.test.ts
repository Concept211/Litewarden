// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Api, cloudRegion, hubUrl, resolveUrl, serverUrls, type Cipher } from '../../src/core/api';
import { b64encode, buf, randomBytes, utf8 } from '../../src/core/bytes';
import { webCrypto as C } from '../../src/core/crypto';
import { encryptDraft, validateDraft, type Draft } from '../../src/core/edit';
import { DEFAULT_GEN, charsets, generatePassword, strength } from '../../src/core/generator';
import { PING, PushType, handshakeReply, parsePushes, splitFrames, unpack } from '../../src/core/notify';
import { decryptItem, type Keys } from '../../src/core/vault';

describe('server URLs', () => {
  it('self-hosted: one base, services under it', () => {
    const u = serverUrls('vault.home.arpa/');
    expect(u).toMatchObject({ base: 'https://vault.home.arpa', api: 'https://vault.home.arpa/api', identity: 'https://vault.home.arpa/identity', icons: 'https://vault.home.arpa/icons', cloud: null });
    expect(resolveUrl(u, '/api/sync?excludeDomains=true')).toBe('https://vault.home.arpa/api/sync?excludeDomains=true');
    expect(resolveUrl(u, '/identity/connect/token')).toBe('https://vault.home.arpa/identity/connect/token');
    expect(resolveUrl(u, '/alive')).toBe('https://vault.home.arpa/alive');
  });
  it('self-hosted under a path keeps the path', () => {
    const u = serverUrls('https://example.com/vw');
    expect(resolveUrl(u, '/api/config')).toBe('https://example.com/vw/api/config');
    expect(hubUrl(u, 'a b')).toBe('wss://example.com/vw/notifications/hub?access_token=a%20b');
  });
  it('plain http servers get ws://', () => {
    expect(hubUrl(serverUrls('http://127.0.0.1:8301'), 't')).toBe('ws://127.0.0.1:8301/notifications/hub?access_token=t');
  });
  it('Bitwarden cloud US and EU split api, identity, icons and notifications hosts', () => {
    expect(cloudRegion('https://vault.bitwarden.com')).toBe('US');
    expect(cloudRegion('https://bitwarden.eu')).toBe('EU');
    expect(cloudRegion('https://bitwarden.example.com')).toBeNull();
    const us = serverUrls('https://vault.bitwarden.com');
    expect(resolveUrl(us, '/api/sync')).toBe('https://api.bitwarden.com/sync');
    expect(resolveUrl(us, '/api/config')).toBe('https://api.bitwarden.com/config');
    expect(resolveUrl(us, '/identity/connect/token')).toBe('https://identity.bitwarden.com/connect/token');
    expect(resolveUrl(us, '/identity/accounts/prelogin/password')).toBe('https://identity.bitwarden.com/accounts/prelogin/password');
    expect(resolveUrl(us, '/icons/github.com/icon.png')).toBe('https://icons.bitwarden.net/github.com/icon.png');
    expect(hubUrl(us, 't')).toBe('wss://notifications.bitwarden.com/hub?access_token=t');
    const eu = serverUrls('vault.bitwarden.eu');
    expect(resolveUrl(eu, '/api/sync')).toBe('https://api.bitwarden.eu/sync');
    expect(resolveUrl(eu, '/identity/connect/token')).toBe('https://identity.bitwarden.eu/connect/token');
    expect(eu.webVault).toBe('https://vault.bitwarden.eu');
  });
  it('the Api client sends requests to the split hosts', async () => {
    const seen: string[] = [];
    const fake = (async (u: string) => (seen.push(String(u)), new Response('{"version":"2026.9.0","server":null}', { status: 200 }))) as unknown as typeof fetch;
    const a = new Api('https://vault.bitwarden.eu', { fetch: fake });
    const info = await a.serverInfo();
    expect(seen).toEqual(['https://api.bitwarden.eu/config']);
    expect(info).toMatchObject({ name: 'Bitwarden', isVaultwarden: false, version: null });
  });
  it('reads the token expiry', () => {
    const jwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.y`;
    const a = new Api('https://x.test', { tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + 600) } });
    expect(a.tokenSecondsLeft()).toBeGreaterThan(590);
    a.tokens = { access_token: jwt(1) };
    expect(a.tokenSecondsLeft()).toBe(0);
  });
});

describe('password generator', () => {
  it('honours length and sets, and every enabled set appears', () => {
    for (let n = 0; n < 200; n++) {
      const p = generatePassword({ length: 12 });
      expect(p).toHaveLength(12);
      for (const set of charsets(DEFAULT_GEN)) expect([...p].some((ch) => set.includes(ch))).toBe(true);
      expect(p).not.toMatch(/[l1IO0o]/);
    }
  });
  it('clamps length to 8..64 and can include look-alikes when asked', () => {
    expect(generatePassword({ length: 3 })).toHaveLength(8);
    expect(generatePassword({ length: 500 })).toHaveLength(64);
    const many = Array.from({ length: 300 }, () => generatePassword({ length: 64, avoidAmbiguous: false, symbols: false })).join('');
    expect(many).toMatch(/[l1IO0o]/);
    expect(many).not.toMatch(/[!#$%&*+\-=?@^_]/);
  });
  it('is not obviously biased', () => {
    const counts = new Map<string, number>();
    const s = Array.from({ length: 2000 }, () => generatePassword({ length: 32, symbols: false, digits: false, upper: false })).join('');
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const vals = [...counts.values()];
    expect(Math.max(...vals) / Math.min(...vals)).toBeLessThan(1.25);
  });
  it('estimates strength', () => {
    expect(strength('').label).toBe('Empty');
    expect(strength('password').score).toBeLessThanOrEqual(2);
    expect(strength('aaaaaaaaaaaaaaaaaaaaaa').score).toBeLessThanOrEqual(2);
    expect(strength(generatePassword()).label).toBe('Strong');
  });
});

describe('editing items', () => {
  const keys = (): Keys => ({ userKey: C.symKey(randomBytes(64)), privateKeys: null, orgKeys: new Map(), orgKeyErrors: new Map() });
  const draft: Draft = {
    type: 1,
    name: 'GitHub',
    notes: 'old notes',
    folderId: null,
    login: { username: 'me@pablo.dev', password: 'old-pass', totp: 'JBSW Y3DP EHPK 3PXP', uris: [{ uri: 'https://github.com', match: null }] },
  };

  it('validates', () => {
    expect(validateDraft({ ...draft, name: '  ' })).toBe('Give it a name.');
    expect(validateDraft({ ...draft, login: { ...draft.login!, uris: [{ uri: '(', match: 4 }] } })).toMatch(/regular expression/);
    expect(validateDraft(draft)).toBeNull();
  });

  it('a new login encrypts every field, sends encryptedFor and URI checksums', async () => {
    const k = keys();
    const body = await encryptDraft(C, draft, k, { original: null, encryptedFor: 'user-1' });
    expect(body.encryptedFor).toBe('user-1');
    expect(body.organizationId).toBeNull();
    expect(String(body.name)).toMatch(/^2\./);
    const back = await decryptItem(C, { ...(body as unknown as Cipher), id: 'x' }, k);
    expect(back).toMatchObject({ name: 'GitHub', notes: 'old notes', login: { username: 'me@pablo.dev', password: 'old-pass', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://github.com', match: null }] } });
    const login = body.login as { uris: Array<{ uriChecksum: string }> };
    const sum = await C.decryptString(login.uris[0]!.uriChecksum, k.userKey);
    const want = b64encode(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(utf8('https://github.com')))));
    expect(sum).toBe(want);
  });

  it('an edit keeps what it does not touch, records the old password, and empty fields become null', async () => {
    const k = keys();
    const first = await encryptDraft(C, draft, k, { original: null, encryptedFor: 'user-1' });
    const fieldEnc = await C.encryptString('custom', k.userKey);
    const stored = {
      ...first,
      id: 'c1',
      revisionDate: '2026-10-01T00:00:00Z',
      creationDate: '2026-01-01T00:00:00Z',
      fields: [{ type: 0, name: fieldEnc, value: fieldEnc, linkedId: null }],
      login: { ...(first.login as object), fido2Credentials: [{ credentialId: 'keep-me' }] },
      attachments: [{ id: 'a' }],
    } as unknown as Cipher;
    const next: Draft = { ...draft, notes: '', login: { ...draft.login!, password: 'new-pass', totp: '', uris: [...draft.login!.uris, { uri: 'https://gist.github.com', match: 1 }] } };
    const body = await encryptDraft(C, next, k, { original: stored, encryptedFor: 'user-1', now: new Date('2026-10-19T12:00:00Z') });
    expect(body.lastKnownRevisionDate).toBe('2026-10-01T00:00:00Z');
    expect(body.fields).toEqual(stored.fields);
    expect((body.login as Record<string, unknown>).fido2Credentials).toEqual([{ credentialId: 'keep-me' }]);
    for (const k2 of ['id', 'revisionDate', 'creationDate', 'attachments']) expect(body).not.toHaveProperty(k2);
    expect(body.notes).toBeNull();
    const hist = body.passwordHistory as Array<{ password: string; lastUsedDate: string }>;
    expect(hist).toHaveLength(1);
    expect(await C.decryptString(hist[0]!.password, k.userKey)).toBe('old-pass');
    expect((body.login as Record<string, unknown>).passwordRevisionDate).toBe('2026-10-19T12:00:00.000Z');
    const back = await decryptItem(C, { ...(body as unknown as Cipher), id: 'c1' }, k);
    expect(back.login).toMatchObject({ password: 'new-pass', totp: null, uris: [{ uri: 'https://github.com', match: null }, { uri: 'https://gist.github.com', match: 1 }] });
  });

  it('an item with its own key stays encrypted with that key', async () => {
    const k = keys();
    const itemRaw = randomBytes(64);
    const itemKey = C.symKey(itemRaw);
    const stored = { id: 'c2', type: 2, organizationId: null, folderId: null, key: await C.encryptBytes(itemRaw, k.userKey), name: await C.encryptString('Note', itemKey), notes: await C.encryptString('n', itemKey), secureNote: { type: 0 } } as unknown as Cipher;
    const body = await encryptDraft(C, { type: 2, name: 'Note 2', notes: 'n2', folderId: 'f1' }, k, { original: stored, encryptedFor: 'u' });
    expect(body.key).toBe(stored.key);
    expect(body.secureNote).toEqual({ type: 0 });
    expect(await C.decryptString(body.name as string, itemKey)).toBe('Note 2');
    await expect(C.decryptString(body.name as string, k.userKey)).rejects.toThrow();
  });
});

// A tiny MessagePack writer for building test frames.
function pack(v: unknown): number[] {
  if (v === null) return [0xc0];
  if (typeof v === 'boolean') return [v ? 0xc3 : 0xc2];
  if (typeof v === 'number') return v >= 0 && v < 128 ? [v] : [0xd2, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  if (typeof v === 'string') {
    const b = [...utf8(v)];
    return b.length < 32 ? [0xa0 | b.length, ...b] : [0xd9, b.length, ...b];
  }
  if (Array.isArray(v)) return [0x90 | v.length, ...v.flatMap(pack)];
  if (v && typeof v === 'object' && 'ext' in v) {
    const e = v as { ext: number; data: number[] };
    return [0xc7, e.data.length, e.ext & 255, ...e.data];
  }
  const ent = Object.entries(v as object);
  return [0x80 | ent.length, ...ent.flatMap(([k, x]) => [...pack(k), ...pack(x)])];
}
const frame = (body: number[]) => [body.length, ...body];

describe('notifications hub (SignalR + MessagePack)', () => {
  it('unpacks the types Vaultwarden sends, timestamps as ext -1', () => {
    expect(unpack(Uint8Array.from(pack({ a: [1, 'x', null, true], b: -5 })))).toEqual({ a: [1, 'x', null, true], b: -5 });
    expect(unpack(Uint8Array.from(pack({ ext: -1, data: [0, 0, 0, 1] })))).toEqual({ ext: -1, data: Uint8Array.of(0, 0, 0, 1) });
  });
  it('splits frames and reads cipher pushes; ignores pings and other targets', () => {
    const push = frame(pack([1, {}, null, 'ReceiveMessage', [{ ContextId: 'dev-2', Type: PushType.SyncCipherUpdate, Payload: { Id: 'c1', RevisionDate: { ext: -1, data: [0, 0, 0, 1] } } }]]));
    const other = frame(pack([1, {}, null, 'Heartbeat', []]));
    const ping = [...PING];
    const all = Uint8Array.from([...ping, ...push, ...other]);
    expect(splitFrames(all)).toHaveLength(3);
    const got = parsePushes(all);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 0, contextId: 'dev-2' });
  });
  it('recognises the handshake answer as binary (Vaultwarden) or text, including errors', () => {
    expect(handshakeReply(Uint8Array.of(0x7b, 0x7d, 0x1e))).toEqual({ ok: true, error: null });
    expect(handshakeReply('{"error":"nope"}')).toEqual({ ok: false, error: 'nope' });
    expect(handshakeReply(Uint8Array.from(PING))).toBeNull();
    expect(parsePushes(Uint8Array.of(0x7b, 0x7d, 0x1e))).toEqual([]);
  });
  it('rejects truncated data instead of misreading it', () => {
    expect(() => splitFrames(Uint8Array.of(5, 1, 2))).toThrow(/truncated/);
    expect(() => unpack(Uint8Array.of(0xd9, 10, 65))).toThrow(/truncated/);
  });
});
