// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { serverUrls } from '../../src/core/api';
import { b64decode, b64encode, b64url, buf, concat } from '../../src/core/bytes';
import { webCrypto as C } from '../../src/core/crypto';
import {
  buildFileSend,
  buildTextSend,
  composeShare,
  encryptSendFile,
  encryptedFileLength,
  readShare,
  sendContentKey,
  sendLink,
  sendPasswordHash,
  shareClosed,
  shareFields,
  sharePolicy,
  sortShares,
  titleFromMessage,
  type SendRecord,
  type ShareOptions,
  type ShareRow,
} from '../../src/core/send';

const userKey = C.symKey(new Uint8Array(64).fill(9));
const opts = (o: Partial<ShareOptions> = {}): ShareOptions => ({ title: 'Staging DB', lasts: '7d', oneView: false, password: null, hideEmail: false, ...o });
const NOW = Date.parse('2026-11-04T12:00:00Z');

/** What a server echoes back. */
const record = (body: Record<string, unknown>, extra: Partial<SendRecord> = {}): SendRecord => ({ ...(body as unknown as SendRecord), id: 'id-1', accessId: 'acc-1', ...extra });

describe('keys', () => {
  it('derives the same content key the recipient page derives (HKDF-SHA256, salt "bitwarden-send", info "send")', async () => {
    const material = Uint8Array.from({ length: 16 }, (_, i) => i);
    const ikm = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
    const want = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('bitwarden-send'), info: new TextEncoder().encode('send') }, ikm, 512);
    const key = await sendContentKey(C, material);
    expect(key.raw.length).toBe(64);
    expect(b64encode(key.raw)).toBe(b64encode(new Uint8Array(want)));
  });

  it('hashes a link password with the material as salt, 100,000 rounds', async () => {
    const material = new Uint8Array(16).fill(1);
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('open-sesame'), 'PBKDF2', false, ['deriveBits']);
    const want = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: material, iterations: 100000 }, k, 256);
    expect(await sendPasswordHash('open-sesame', material)).toBe(b64encode(new Uint8Array(want)));
  });
});

describe('the link', () => {
  const material = new Uint8Array(16).fill(250);
  it('keeps the key after the #, in URL-safe base64, on a self-hosted server', () => {
    const link = sendLink(serverUrls('https://vault.example.com'), 'abc', material);
    expect(link).toBe(`https://vault.example.com/#/send/abc/${b64url(material)}`);
    expect(new URL(link).pathname).toBe('/');
    expect(link).not.toMatch(/[+=]/);
  });
  it('keeps a server path', () => {
    expect(sendLink(serverUrls('https://example.com/vw'), 'abc', material)).toMatch(/^https:\/\/example\.com\/vw\/#\/send\/abc\//);
  });
  it("uses Bitwarden's address on the clouds", () => {
    expect(sendLink(serverUrls('https://vault.bitwarden.com'), 'abc', material)).toMatch(/^https:\/\/send\.bitwarden\.com\/#abc\//);
    expect(sendLink(serverUrls('https://vault.bitwarden.eu'), 'abc', material)).toMatch(/^https:\/\/vault\.bitwarden\.eu\/#\/send\/abc\//);
  });
});

describe('building and reading', () => {
  it('encrypts everything the server stores, and reads it back', async () => {
    const secret = 'user: deploy\npassword: hunter2-value';
    const { body, material } = await buildTextSend(C, opts({ oneView: true, password: 'open-sesame', hideEmail: true }), secret, userKey, NOW);
    const raw = JSON.stringify(body);
    for (const plain of ['deploy', 'hunter2', 'Staging', 'open-sesame']) expect(raw).not.toContain(plain);
    expect(body.maxAccessCount).toBe(1);
    expect(body.hideEmail).toBe(true);
    expect(body.expirationDate).toBe(new Date(NOW + 7 * 864e5).toISOString());
    // The contents leave the server when the link ends.
    expect(body.deletionDate).toBe(body.expirationDate);
    expect(await C.decryptBytes(body.key, userKey)).toEqual(material);
    const key = await sendContentKey(C, material);
    expect(await C.decryptString(body.text.text, key)).toBe(secret);

    const row = await readShare(C, record(body, { accessCount: 0 }), userKey, NOW);
    expect(row).toMatchObject({ kind: 'text', title: 'Staging DB', views: 0, maxViews: 1, hasPassword: true, hideEmail: true, closed: false });
  });

  it('leaves the password off when none is set', async () => {
    expect((await buildTextSend(C, opts(), 'x', userKey)).body.password).toBeNull();
  });

  it.each([0, 1, 15, 16, 17, 1000])('predicts the encrypted length of a %i byte file', async (n) => {
    const { material } = await buildTextSend(C, opts(), 'x', userKey);
    const sealed = await encryptSendFile(new Uint8Array(n), await sendContentKey(C, material));
    expect(sealed.length).toBe(encryptedFileLength(n));
  });

  it('seals a file in the format the page reads: 0x02, IV, MAC, text, and the bytes decrypt', async () => {
    const plain = new TextEncoder().encode('spike-file-contents\n');
    const { body, material, encName } = await buildFileSend(C, opts(), 'notes.txt', plain.length, userKey, NOW);
    expect(JSON.stringify(body)).not.toContain('notes.txt');
    expect(body.file.fileName).toBe(encName);
    expect(body.fileLength).toBe(encryptedFileLength(plain.length));
    const key = await sendContentKey(C, material);
    const sealed = await encryptSendFile(plain, key);
    expect(sealed[0]).toBe(2);
    const iv = sealed.subarray(1, 17);
    const mac = sealed.subarray(17, 49);
    const ct = sealed.subarray(49);
    expect(await crypto.subtle.verify('HMAC', await key.macKey, buf(mac), buf(concat(iv, ct)))).toBe(true);
    const enc = `2.${b64encode(iv)}|${b64encode(ct)}|${b64encode(mac)}`;
    expect(await C.decryptBytes(enc, key)).toEqual(plain);
    expect(b64decode(b64encode(plain))).toEqual(plain);
  });

  it('knows when a link is closed', () => {
    const base = { id: 'a', accessId: 'a', type: 0, name: '', key: '', deletionDate: new Date(NOW + 1000).toISOString(), expirationDate: new Date(NOW + 1000).toISOString() } as SendRecord;
    expect(shareClosed(base, NOW)).toBe(false);
    expect(shareClosed({ ...base, expirationDate: new Date(NOW - 1).toISOString() }, NOW)).toBe(true);
    expect(shareClosed({ ...base, expirationDate: null, deletionDate: new Date(NOW - 1).toISOString() }, NOW)).toBe(true);
    expect(shareClosed({ ...base, maxAccessCount: 1, accessCount: 1 }, NOW)).toBe(true);
    expect(shareClosed({ ...base, maxAccessCount: 2, accessCount: 1 }, NOW)).toBe(false);
    expect(shareClosed({ ...base, disabled: true }, NOW)).toBe(true);
  });

  it('lists open links first, soonest to end on top', () => {
    const r = (title: string, endsAt: number, closed = false) => ({ title, endsAt, closed }) as ShareRow;
    expect(sortShares([r('done', 1, true), r('later', 300), r('soon', 200)]).map((x) => x.title)).toEqual(['soon', 'later', 'done']);
  });
});

describe('policies', () => {
  const orgs = [{ id: 'mine', type: 0 }, { id: 'admin', type: 1 }, { id: 'member', type: 2 }];
  it('binds members but not owners and admins, as the server does', () => {
    const p = (organizationId: string, type = 6, data?: Record<string, unknown>) => ({ type, enabled: true, organizationId, data });
    expect(sharePolicy([p('mine'), p('admin')], orgs).disabled).toBe(false);
    expect(sharePolicy([p('member')], orgs).disabled).toBe(true);
    expect(sharePolicy([p('unknown')], orgs).disabled).toBe(true);
    expect(sharePolicy([{ ...p('member'), enabled: false }], orgs).disabled).toBe(false);
    expect(sharePolicy([p('member', 7, { disableHideEmail: true })], orgs)).toEqual({ disabled: false, noHideEmail: true });
    expect(sharePolicy([p('member', 7, { disableHideEmail: false })], orgs).noHideEmail).toBe(false);
    expect(sharePolicy(null).disabled).toBe(false);
  });
});

describe('what a shared item holds', () => {
  const login = {
    notes: 'Rotate monthly',
    login: { username: 'deploy', password: 'k7#Qm2', totp: 'JBSWY3DP', uris: [{ uri: 'https://staging.acme.dev', match: null }] },
    fields: [{ name: 'Region', value: 'us-east', type: 0 }, { name: 'Linked', value: null, type: 3 }],
  };
  it('offers a login with the password on and the 2FA secret, notes and other fields off', () => {
    const f = shareFields(login);
    expect(f.map((x) => [x.label, x.on])).toEqual([['Username', true], ['Password', true], ['Website', true], ['2FA secret', false], ['Notes', false], ['Other fields', false]]);
    const on = new Set(f.filter((x) => x.on).map((x) => x.key));
    expect(composeShare(f, on)).toBe('Username: deploy\nPassword: k7#Qm2\nWebsite: https://staging.acme.dev');
    expect(composeShare(f, new Set(['password']))).toBe('Password: k7#Qm2');
    expect(composeShare(f, new Set(['totp', 'fields']))).toBe('2FA secret: JBSWY3DP\nRegion: us-east');
  });
  it('leaves out empty fields', () => {
    expect(shareFields({ notes: null, login: { username: null, password: 'x', totp: null, uris: [] } }).map((x) => x.key)).toEqual(['password']);
  });
  it('keeps a card\'s security code off', () => {
    const f = shareFields({ notes: null, card: { cardholderName: 'Alex', number: '4242', expMonth: '8', expYear: '2028', code: '123' } });
    expect(f.map((x) => [x.key, x.on])).toEqual([['name', true], ['number', true], ['expiry', true], ['code', false]]);
    expect(f.find((x) => x.key === 'expiry')!.text).toBe('Expires: 08/28');
  });
  it("keeps an identity's government numbers off", () => {
    const f = shareFields({ notes: null, identity: { firstName: 'Alex', lastName: 'Rivera', email: 'a@b.c', address1: '1 Main', city: 'Miami', state: 'FL', postalCode: '33101', ssn: '000', passportNumber: 'P1', licenseNumber: 'L1' } });
    expect(f.filter((x) => !x.on).map((x) => x.key)).toEqual(['ssn', 'passport', 'license']);
    expect(f.find((x) => x.key === 'address')!.text).toBe('Address: 1 Main, Miami, FL 33101');
  });
  it("uses a note's text as the message, without a label", () => {
    const f = shareFields({ notes: 'the door code is 1234' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ label: 'Note', on: true, text: 'the door code is 1234' });
  });
});

describe('a title from the message', () => {
  it.each([
    ['Staging DB\nuser: deploy', 'Staging DB'],
    ['  \n Wi-Fi for the visitor ', 'Wi-Fi for the visitor'],
    ['Q3 numbers', 'Q3 numbers'],
  ])('uses a plain first line: %j', (text, want) => expect(titleFromMessage(text)).toBe(want));
  it.each([
    ['k7#Qm2!vXp9sLt'],
    ['password: hunter2'],
    ['my passcode is here'],
    ['aws key AKIAIOSFODNN7EXAMPLE'],
    ['x8Rt2vKj4N1pS6mZ'],
    ['correcthorsebatterystaplecorrecthorse'],
    ['deploy@staging.acme.dev'],
    ['a'.repeat(61)],
    ['   '],
  ])('never uses what could be the secret: %j', (text) => expect(titleFromMessage(text)).toBeNull());
});
