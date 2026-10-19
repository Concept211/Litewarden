// SPDX-License-Identifier: GPL-3.0-only
// The Bitwarden protocol crypto on WebCrypto, plus hash-wasm for Argon2id.
// Ported from the M1 spike (own implementation). No Bitwarden or Vaultwarden code copied.
import { argon2id } from 'hash-wasm';
import { b64encode, buf, concat, fromUtf8, randomBytes, utf8 } from '../bytes';
import { DecryptError, UnsupportedKeyFormat } from '../errors';
import { EncType, parseEncString } from './encstring';
import type { Crypto, Kdf, PrivateKeys, SymKey } from './types';

const subtle = globalThis.crypto.subtle;

export const KdfType = { PBKDF2: 0, Argon2id: 1 } as const;

class WebSymKey implements SymKey {
  #enc?: Promise<CryptoKey>;
  #mac?: Promise<CryptoKey>;
  constructor(readonly raw: Uint8Array) {
    if (raw.length !== 64 && raw.length !== 32) throw new DecryptError(`Key has ${raw.length} bytes; expected 32 or 64.`);
  }
  get encKey(): Promise<CryptoKey> {
    return (this.#enc ??= subtle.importKey('raw', buf(this.raw.slice(0, 32)), 'AES-CBC', false, ['encrypt', 'decrypt']));
  }
  get macKey(): Promise<CryptoKey> {
    if (this.raw.length < 64) throw new DecryptError('This key has no MAC half.');
    return (this.#mac ??= subtle.importKey('raw', buf(this.raw.slice(32, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, buf(data)));
}

/** HKDF-Expand only (no extract), SHA-256, one 32-byte block. WebCrypto's HKDF always extracts first, so do it by hand. */
const hkdfExpand32 = (prk: Uint8Array, info: string) => hmac(prk, concat(utf8(info), Uint8Array.of(1)));

const RSA_HASH: Record<number, 'SHA-1' | 'SHA-256'> = { 3: 'SHA-256', 4: 'SHA-1', 5: 'SHA-256', 6: 'SHA-1' };

export const webCrypto: Crypto = {
  symKey: (raw) => new WebSymKey(raw),

  async deriveMasterKey(password, email, kdf: Kdf) {
    const pw = utf8(password);
    const salt = utf8(email.trim().toLowerCase());
    if (kdf.kdf === KdfType.Argon2id) {
      if (!kdf.kdfMemory || !kdf.kdfParallelism) throw new DecryptError('Argon2id settings are incomplete.');
      // Salt is SHA-256(email); memory is given in MiB; 32-byte output.
      const saltHash = new Uint8Array(await subtle.digest('SHA-256', buf(salt)));
      return argon2id({
        password: pw,
        salt: saltHash,
        parallelism: kdf.kdfParallelism,
        iterations: kdf.kdfIterations,
        memorySize: kdf.kdfMemory * 1024,
        hashLength: 32,
        outputType: 'binary',
      });
    }
    if (kdf.kdf !== KdfType.PBKDF2) throw new UnsupportedKeyFormat(`key derivation type ${kdf.kdf}`);
    const base = await subtle.importKey('raw', buf(pw), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: kdf.kdfIterations }, base, 256));
  },

  async masterPasswordHash(masterKey, password) {
    const base = await subtle.importKey('raw', buf(masterKey), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(utf8(password)), iterations: 1 }, base, 256);
    return b64encode(new Uint8Array(bits));
  },

  async stretchMasterKey(masterKey) {
    return new WebSymKey(concat(await hkdfExpand32(masterKey, 'enc'), await hkdfExpand32(masterKey, 'mac')));
  },

  async decryptBytes(encStr, key) {
    const e = parseEncString(encStr);
    if (e.type === EncType.AesCbc256_HmacSha256_B64) {
      const ok = await subtle.verify('HMAC', await key.macKey, buf(e.mac), buf(concat(e.iv, e.ct))); // constant time
      if (!ok) throw new DecryptError('Integrity check failed (wrong key or changed data).');
    } else if (e.type !== EncType.AesCbc256_B64) {
      throw new UnsupportedKeyFormat(`symmetric value type ${e.type}`);
    }
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: buf(e.iv) }, await key.encKey, buf(e.ct)));
    } catch (err) {
      throw new DecryptError('Decryption failed (wrong key or changed data).', { cause: err });
    }
  },

  async decryptString(encStr, key) {
    if (encStr == null) return null;
    return fromUtf8(await webCrypto.decryptBytes(encStr, key));
  },

  async encryptBytes(bytes, key) {
    const iv = randomBytes(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: buf(iv) }, await key.encKey, buf(bytes)));
    const mac = new Uint8Array(await subtle.sign('HMAC', await key.macKey, buf(concat(iv, ct))));
    return `2.${b64encode(iv)}|${b64encode(ct)}|${b64encode(mac)}`;
  },

  encryptString(s, key) {
    return webCrypto.encryptBytes(utf8(s), key);
  },

  async loadPrivateKeys(encPrivateKey, userKey) {
    const der = await webCrypto.decryptBytes(encPrivateKey, userKey);
    const imp = (hash: 'SHA-1' | 'SHA-256') => subtle.importKey('pkcs8', buf(der), { name: 'RSA-OAEP', hash }, false, ['decrypt']);
    return { 'SHA-1': await imp('SHA-1'), 'SHA-256': await imp('SHA-256') };
  },

  async rsaDecrypt(encStr, keys: PrivateKeys) {
    const e = parseEncString(encStr);
    const hash = RSA_HASH[e.type];
    if (!hash) throw new UnsupportedKeyFormat(`asymmetric value type ${e.type}`);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, keys[hash], buf(e.ct)));
    } catch (err) {
      throw new DecryptError('Could not unwrap an organization key.', { cause: err });
    }
  },

  async rsaEncrypt(bytes, spkiDer) {
    const pub = await subtle.importKey('spki', buf(spkiDer), { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
    return `4.${b64encode(new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pub, buf(bytes))))}`;
  },

  async generateRsaPair() {
    const kp = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-1' },
      true,
      ['encrypt', 'decrypt'],
    );
    return {
      publicDer: new Uint8Array(await subtle.exportKey('spki', kp.publicKey)),
      privateDer: new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)),
    };
  },
};
