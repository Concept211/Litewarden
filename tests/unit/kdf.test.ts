// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { checkKdf, kdfSignature } from '../../src/core/kdf';

const pbkdf2 = (kdfIterations: number) => ({ kdf: 0, kdfIterations });
const argon = (kdfIterations: number, kdfMemory: number | null, kdfParallelism: number | null) => ({ kdf: 1, kdfIterations, kdfMemory, kdfParallelism });

describe('KDF floor', () => {
  it('PBKDF2 at 600,000 and above is fine', () => {
    expect(checkKdf(pbkdf2(600_000)).level).toBe('ok');
    expect(checkKdf(pbkdf2(1_000_000)).level).toBe('ok');
  });
  it('PBKDF2 between 5,000 and 600,000 warns, and says how many rounds', () => {
    for (const n of [5_000, 100_000, 599_999]) {
      const c = checkKdf(pbkdf2(n));
      expect(c.level).toBe('weak');
      expect(c.reasons[0]).toContain(n.toLocaleString('en-US'));
    }
  });
  it('PBKDF2 under 5,000 (Bitwarden refuses it too) is refused', () => {
    for (const n of [4_999, 1, 0, -5, NaN]) expect(checkKdf(pbkdf2(n)).level, String(n)).toBe('refuse');
  });
  it('Argon2id at the minimums is fine; anything below warns', () => {
    expect(checkKdf(argon(2, 16, 1)).level).toBe('ok');
    expect(checkKdf(argon(3, 64, 4)).level).toBe('ok');
    expect(checkKdf(argon(2, 15, 1)).level).toBe('weak');
    expect(checkKdf(argon(1, 64, 4)).level).toBe('weak');
    const both = checkKdf(argon(1, 8, 1));
    expect(both.level).toBe('weak');
    expect(both.reasons).toHaveLength(2);
  });
  it('Argon2id with missing or zero settings is refused (it cannot even run)', () => {
    expect(checkKdf(argon(3, null, 4)).level).toBe('refuse');
    expect(checkKdf(argon(3, 64, null)).level).toBe('refuse');
    expect(checkKdf(argon(0, 64, 4)).level).toBe('refuse');
    expect(checkKdf(argon(3, 0, 4)).level).toBe('refuse');
  });
  it('reasons use plain words and American spelling, no em dashes', () => {
    const text = [pbkdf2(100_000), argon(1, 8, 1), pbkdf2(10)].flatMap((k) => checkKdf(k).reasons).join(' ');
    expect(text).not.toMatch(/—|–/);
  });
  it('the signature changes when any setting changes', () => {
    expect(kdfSignature(pbkdf2(100_000))).not.toBe(kdfSignature(pbkdf2(100_001)));
    expect(kdfSignature(argon(3, 64, 4))).not.toBe(kdfSignature(argon(3, 64, 2)));
  });
});
