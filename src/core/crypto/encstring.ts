// SPDX-License-Identifier: GPL-3.0-only
// EncString: the Bitwarden wire format for encrypted values, "<type>.<b64>|<b64>|<b64>".
// Written from the public protocol description; no Bitwarden or Vaultwarden code copied.
import { b64decode } from '../bytes';
import { DecryptError, UnsupportedKeyFormat } from '../errors';

export const EncType = {
  AesCbc256_B64: 0,
  AesCbc128_HmacSha256_B64: 1,
  AesCbc256_HmacSha256_B64: 2,
  Rsa2048_OaepSha256_B64: 3,
  Rsa2048_OaepSha1_B64: 4,
  Rsa2048_OaepSha256_HmacSha256_B64: 5,
  Rsa2048_OaepSha1_HmacSha256_B64: 6,
  CoseEncrypt0: 7,
} as const;
export type EncTypeValue = (typeof EncType)[keyof typeof EncType];

export type ParsedEncString =
  | { type: 0; iv: Uint8Array; ct: Uint8Array }
  | { type: 1 | 2; iv: Uint8Array; ct: Uint8Array; mac: Uint8Array }
  | { type: 3 | 4; ct: Uint8Array }
  | { type: 5 | 6; ct: Uint8Array; mac?: Uint8Array };

/** Parse "2.iv|ct|mac", "0.iv|ct", "4.rsa"; legacy strings without a type prefix are 0 or 2 by part count. */
export function parseEncString(s: string): ParsedEncString {
  if (typeof s !== 'string' || !s) throw new DecryptError('Encrypted value is missing or not text.');
  const dot = s.indexOf('.');
  let type: number;
  let rest: string;
  if (dot > 0 && dot <= 2 && /^\d+$/.test(s.slice(0, dot))) {
    type = Number(s.slice(0, dot));
    rest = s.slice(dot + 1);
  } else {
    rest = s;
    type = s.split('|').length === 3 ? 2 : 0;
  }
  const p = rest.split('|');
  const part = (i: number) => {
    const v = p[i];
    if (v === undefined || v === '') throw new DecryptError(`Encrypted value of type ${type} is malformed.`);
    return b64decode(v);
  };
  switch (type) {
    case 0:
      if (p.length !== 2) throw new DecryptError('Encrypted value of type 0 is malformed.');
      return { type: 0, iv: part(0), ct: part(1) };
    case 1:
    case 2:
      if (p.length !== 3) throw new DecryptError(`Encrypted value of type ${type} is malformed.`);
      return { type, iv: part(0), ct: part(1), mac: part(2) };
    case 3:
    case 4:
      return { type, ct: part(0) };
    case 5:
    case 6:
      return p[1] ? { type, ct: part(0), mac: part(1) } : { type, ct: part(0) };
    case 7:
      throw new UnsupportedKeyFormat('COSE encrypted value, type 7');
    default:
      throw new UnsupportedKeyFormat(`encrypted value type ${type}`);
  }
}

/** Cheap check without decoding, used to scan a sync payload for formats we can't read. */
export const encTypeOf = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2})\./.exec(s);
  return m ? Number(m[1]) : s.split('|').length === 3 ? 2 : 0;
};
