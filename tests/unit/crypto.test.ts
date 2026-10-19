// SPDX-License-Identifier: GPL-3.0-only
// Crypto against reference vectors computed independently (Python hashlib, argon2-cffi, cryptography).
import { describe, expect, it } from 'vitest';
import { b64decode, b64encode, buf, utf8 } from '../../src/core/bytes';
import { EncType, encTypeOf, parseEncString, webCrypto as C } from '../../src/core/crypto';
import { DecryptError, UnsupportedKeyFormat } from '../../src/core/errors';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

const V = {
  email: 'User@Example.com ',
  password: 'correct horse battery staple',
  pbkdf2MasterKey: '55dc4a94e4881ffd792d6cb4173d7145756cd95ddc9b2310bb0fc931123c8248',
  masterPasswordHash: 'nfEypS52oCiXbQyehOT45BcIhAJYN/5ltdzSYVXHaWg=',
  stretchedEnc: '93ded3e35b9346cf64c4bdead65723856c45867ef3c3fb28696269fc2444394b',
  stretchedMac: '29eaff41674c0bbb38f09f8fde3c77000e040ecc0e109479039c69b65acba1b7',
  argon2MasterKey: '26034d0eaf9c2631caec3e6cc7f47603bee30bf3d86f8d79968d05fa3245f702',
  encString: '2.AAECAwQFBgcICQoLDA0ODw==|77AIoehrHH0EDVM6FADc7OrvM1dsKGNWvxmjjHmNRoc=|oA1sofC75HUyiHwKgKRwEW/DxLAb962A3Cn2xRMJWoc=',
  plain: 'héllo, Litewarden ✓',
};

describe('KDF', () => {
  it('PBKDF2-SHA256 600k matches the reference (email trimmed and lowercased)', async () => {
    const mk = await C.deriveMasterKey(V.password, V.email, { kdf: 0, kdfIterations: 600_000 });
    expect(hex(mk)).toBe(V.pbkdf2MasterKey);
  });
  it('Argon2id (salt = SHA-256 of email, memory in MiB) matches the reference', async () => {
    const mk = await C.deriveMasterKey(V.password, V.email, { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 });
    expect(hex(mk)).toBe(V.argon2MasterKey);
  });
  it('rejects unknown KDF types in plain words', async () => {
    await expect(C.deriveMasterKey('x', 'a@b.c', { kdf: 9, kdfIterations: 1 })).rejects.toBeInstanceOf(UnsupportedKeyFormat);
  });
  it('master password hash and stretched key match the reference', async () => {
    const mk = fromHex(V.pbkdf2MasterKey);
    expect(await C.masterPasswordHash(mk, V.password)).toBe(V.masterPasswordHash);
    const st = await C.stretchMasterKey(mk);
    expect(hex(st.raw.slice(0, 32))).toBe(V.stretchedEnc);
    expect(hex(st.raw.slice(32))).toBe(V.stretchedMac);
  });
});

describe('EncString', () => {
  it('parses types 0, 2, 4 and legacy strings', () => {
    const b = b64encode(Uint8Array.of(1, 2, 3));
    expect(parseEncString(`0.${b}|${b}`).type).toBe(0);
    expect(parseEncString(`2.${b}|${b}|${b}`).type).toBe(2);
    expect(parseEncString(`4.${b}`).type).toBe(4);
    expect(parseEncString(`${b}|${b}|${b}`).type).toBe(2);
    expect(parseEncString(`${b}|${b}`).type).toBe(0);
    expect(encTypeOf(`7.${b}`)).toBe(7);
    expect(encTypeOf(null)).toBeNull();
  });
  it('type 7 (COSE) throws UnsupportedKeyFormat with a plain message', () => {
    expect(() => parseEncString('7.AAAA')).toThrow(UnsupportedKeyFormat);
    expect(() => parseEncString('7.AAAA')).toThrow(/newer encryption format/);
  });
  it('malformed values throw DecryptError', () => {
    expect(() => parseEncString('2.AAAA|BBBB')).toThrow(DecryptError);
    expect(() => parseEncString('')).toThrow(DecryptError);
  });
});

describe('AES-256-CBC + HMAC-SHA256', () => {
  const key = C.symKey(Uint8Array.from([...fromHex(V.stretchedEnc), ...fromHex(V.stretchedMac)]));
  it('decrypts a value made by an independent implementation', async () => {
    expect(await C.decryptString(V.encString, key)).toBe(V.plain);
  });
  it('round-trips', async () => {
    const e = await C.encryptString('secret ✓', key);
    expect(parseEncString(e).type).toBe(EncType.AesCbc256_HmacSha256_B64);
    expect(await C.decryptString(e, key)).toBe('secret ✓');
  });
  it('refuses a changed MAC or ciphertext', async () => {
    const [head, ct, mac] = V.encString.split('|') as [string, string, string];
    const badMac = b64decode(mac);
    badMac[0] = badMac[0]! ^ 1;
    await expect(C.decryptString(`${head}|${ct}|${b64encode(badMac)}`, key)).rejects.toBeInstanceOf(DecryptError);
    const badCt = b64decode(ct);
    badCt[3] = badCt[3]! ^ 1;
    await expect(C.decryptString(`${head}|${b64encode(badCt)}|${mac}`, key)).rejects.toBeInstanceOf(DecryptError);
  });
  it('refuses the wrong key', async () => {
    await expect(C.decryptString(V.encString, C.symKey(new Uint8Array(64)))).rejects.toBeInstanceOf(DecryptError);
  });
  it('decrypts type 0 (AES only)', async () => {
    const raw = fromHex(V.stretchedEnc);
    const iv = new Uint8Array(16);
    const ak = await crypto.subtle.importKey('raw', buf(raw), 'AES-CBC', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ak, buf(utf8('legacy'))));
    expect(await C.decryptString(`0.${b64encode(iv)}|${b64encode(ct)}`, C.symKey(raw))).toBe('legacy');
  });
  it('null passes through', async () => {
    expect(await C.decryptString(null, key)).toBeNull();
  });
});

describe('RSA-OAEP org keys', () => {
  it('unwraps SHA-1 (type 4) and SHA-256 (type 3) values with the account private key', async () => {
    const userKey = C.symKey(crypto.getRandomValues(new Uint8Array(64)));
    const pair = await C.generateRsaPair();
    const encPriv = await C.encryptBytes(pair.privateDer, userKey);
    const keys = await C.loadPrivateKeys(encPriv, userKey);
    const orgKey = crypto.getRandomValues(new Uint8Array(64));
    expect(hex(await C.rsaDecrypt(await C.rsaEncrypt(orgKey, pair.publicDer), keys))).toBe(hex(orgKey));
    const pub256 = await crypto.subtle.importKey('spki', buf(pair.publicDer), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub256, buf(orgKey)));
    expect(hex(await C.rsaDecrypt(`3.${b64encode(ct)}`, keys))).toBe(hex(orgKey));
  });
  it('a symmetric EncString is not accepted as RSA', async () => {
    const pair = await C.generateRsaPair();
    const userKey = C.symKey(crypto.getRandomValues(new Uint8Array(64)));
    const keys = await C.loadPrivateKeys(await C.encryptBytes(pair.privateDer, userKey), userKey);
    await expect(C.rsaDecrypt(V.encString, keys)).rejects.toBeInstanceOf(UnsupportedKeyFormat);
  });
});
