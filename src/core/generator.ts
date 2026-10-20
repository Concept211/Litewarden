// SPDX-License-Identifier: GPL-3.0-only
// Password generator and a plain strength estimate. Uses the platform CSPRNG with rejection sampling, so every
// character is uniformly likely; each enabled character set appears at least once.

export interface GenOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leave out characters that are easy to misread: l 1 I 0 O o */
  avoidAmbiguous: boolean;
}

export const DEFAULT_GEN: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true };
export const GEN_MIN = 8;
export const GEN_MAX = 64;

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_',
};
const AMBIGUOUS = /[l1IO0o]/g;

/** Uniform integer in [0, n) from the CSPRNG, without modulo bias. */
function randBelow(n: number): number {
  const max = Math.floor(0x1_0000_0000 / n) * n;
  const b = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    if (b[0]! < max) return b[0]! % n;
  }
}

export function charsets(o: GenOptions): string[] {
  const out: string[] = [];
  for (const k of ['upper', 'lower', 'digits', 'symbols'] as const) {
    if (!o[k]) continue;
    out.push(o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]);
  }
  return out.length ? out : [SETS.lower];
}

export function generatePassword(opts: Partial<GenOptions> = {}): string {
  const o = { ...DEFAULT_GEN, ...opts };
  const length = Math.min(GEN_MAX, Math.max(GEN_MIN, Math.round(o.length)));
  const sets = charsets(o);
  const all = sets.join('');
  const chars = sets.map((s) => s[randBelow(s.length)]!);
  while (chars.length < length) chars.push(all[randBelow(all.length)]!);
  // Fisher-Yates so the guaranteed characters aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface Strength {
  /** 0 (empty) to 4 (strong) */
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Empty' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  bits: number;
}

/**
 * A rough estimate from length and the kinds of characters used. It doesn't know dictionary words, so it's
 * generous to passphrases a person picked; that's said in the UI as "estimate".
 */
export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: 'Empty', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 33;
  // Repeated characters add little: count distinct characters, capped by length.
  const distinct = new Set(pw).size;
  const bits = Math.round(Math.min(pw.length, distinct * 1.5) * Math.log2(Math.max(pool, 2)));
  const score = bits >= 80 ? 4 : bits >= 60 ? 3 : bits >= 40 ? 2 : 1;
  return { score, label: (['Empty', 'Weak', 'Fair', 'Good', 'Strong'] as const)[score], bits };
}
