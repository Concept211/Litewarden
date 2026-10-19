// SPDX-License-Identifier: GPL-3.0-only
// RFC 6238 TOTP on WebCrypto. Accepts a bare base32 secret, an otpauth:// URI or a steam:// secret.
import { buf } from './bytes';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

export interface TotpParams {
  secret: string;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  steam: boolean;
}

export function base32decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`The 2FA secret has an invalid character (“${ch}”).`);
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >>> bits) & 0xff);
      val &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

export function parseTotp(input: string): TotpParams {
  const o: TotpParams = { secret: '', digits: 6, period: 30, algorithm: 'SHA-1', steam: false };
  const s = input.trim();
  if (/^steam:\/\//i.test(s)) return { ...o, secret: s.slice(8), digits: 5, steam: true };
  if (/^otpauth:\/\//i.test(s)) {
    const u = new URL(s);
    const p = u.searchParams;
    o.secret = p.get('secret') ?? '';
    const digits = Number(p.get('digits'));
    const period = Number(p.get('period'));
    if (digits >= 4 && digits <= 10) o.digits = digits;
    if (period > 0) o.period = period;
    const alg = (p.get('algorithm') ?? 'SHA1').toUpperCase().replace(/^SHA-?/, 'SHA-');
    if (alg === 'SHA-256' || alg === 'SHA-512') o.algorithm = alg;
    if (/steam/i.test(decodeURIComponent(u.pathname)) || /steam/i.test(p.get('issuer') ?? '')) {
      o.steam = true;
      o.digits = 5;
    }
    return o;
  }
  return { ...o, secret: s };
}

/** The current code for a secret. */
export async function totp(input: string | TotpParams, nowMs = Date.now()): Promise<string> {
  const o = typeof input === 'string' ? parseTotp(input) : input;
  const key = base32decode(o.secret);
  const counter = Math.floor(nowMs / 1000 / o.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const k = await globalThis.crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: o.algorithm }, false, ['sign']);
  const h = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, msg));
  const off = h[h.length - 1]! & 0xf;
  let n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  if (o.steam) {
    let c = '';
    for (let i = 0; i < 5; i++) {
      c += STEAM_CHARS[n % STEAM_CHARS.length];
      n = Math.floor(n / STEAM_CHARS.length);
    }
    return c;
  }
  return String(n % 10 ** o.digits).padStart(o.digits, '0');
}

export const secondsRemaining = (period = 30, nowMs = Date.now()): number => period - (Math.floor(nowMs / 1000) % period);
