// SPDX-License-Identifier: GPL-3.0-only
// The crypto surface the rest of Litewarden uses. The WebCrypto implementation lives in webcrypto.ts;
// keeping this interface small means a different backend (e.g. Bitwarden's SDK) could be swapped in later.

export interface Kdf {
  /** 0 = PBKDF2-SHA256, 1 = Argon2id */
  kdf: number;
  kdfIterations: number;
  /** Argon2id memory in MiB */
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
}

/** A 64-byte (AES-256 + HMAC-SHA256) or 32-byte (AES only) symmetric key with cached CryptoKeys. */
export interface SymKey {
  readonly raw: Uint8Array;
  readonly encKey: Promise<CryptoKey>;
  readonly macKey: Promise<CryptoKey>;
}

export type PrivateKeys = Record<'SHA-1' | 'SHA-256', CryptoKey>;

export interface Crypto {
  symKey(raw: Uint8Array): SymKey;
  deriveMasterKey(password: string, email: string, kdf: Kdf): Promise<Uint8Array>;
  /** Server auth hash: PBKDF2-SHA256(masterKey, salt = password, 1 iteration), base64. */
  masterPasswordHash(masterKey: Uint8Array, password: string): Promise<string>;
  /** HKDF-Expand the 32-byte master key into a 64-byte enc+mac key. */
  stretchMasterKey(masterKey: Uint8Array): Promise<SymKey>;
  decryptBytes(encStr: string, key: SymKey): Promise<Uint8Array>;
  decryptString(encStr: string | null | undefined, key: SymKey): Promise<string | null>;
  encryptBytes(bytes: Uint8Array, key: SymKey): Promise<string>;
  encryptString(s: string, key: SymKey): Promise<string>;
  loadPrivateKeys(encPrivateKey: string, userKey: SymKey): Promise<PrivateKeys>;
  rsaDecrypt(encStr: string, keys: PrivateKeys): Promise<Uint8Array>;
  /** RSA-OAEP SHA-1 encrypt to a type 4 EncString (seeding and org setup in tests). */
  rsaEncrypt(bytes: Uint8Array, spkiDer: Uint8Array): Promise<string>;
  generateRsaPair(): Promise<{ publicDer: Uint8Array; privateDer: Uint8Array }>;
}
