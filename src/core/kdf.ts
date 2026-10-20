// SPDX-License-Identifier: GPL-3.0-only
// How strong are the account's key-derivation settings? The server tells us at prelogin, so a hostile or
// misconfigured server could pick settings that make the login hash cheap to crack offline. Bitwarden's own
// clients enforce minimums; we follow them.
import type { Kdf } from './crypto/types';

/** PBKDF2: Bitwarden's hard minimum, and the iteration count it recommends (OWASP 2023). */
export const PBKDF2_MIN = 5_000;
export const PBKDF2_RECOMMENDED = 600_000;
/** Argon2id recommended minimums, in Bitwarden's units (memory in MiB). */
export const ARGON2_MIN = { memory: 16, iterations: 2, parallelism: 1 } as const;

export type KdfLevel = 'ok' | 'weak' | 'refuse';
export interface KdfCheck {
  level: KdfLevel;
  /** Short plain-words reasons (for the warning), empty when ok. */
  reasons: string[];
}

export function checkKdf(k: Kdf): KdfCheck {
  const reasons: string[] = [];
  if (k.kdf === 0) {
    if (!Number.isFinite(k.kdfIterations) || k.kdfIterations < PBKDF2_MIN) return { level: 'refuse', reasons: [`PBKDF2 runs only ${k.kdfIterations.toLocaleString('en-US')} rounds`] };
    if (k.kdfIterations < PBKDF2_RECOMMENDED) reasons.push(`PBKDF2 runs ${k.kdfIterations.toLocaleString('en-US')} rounds (600,000 is the minimum Bitwarden recommends)`);
  } else if (k.kdf === 1) {
    const { kdfIterations: it, kdfMemory: mem, kdfParallelism: par } = k;
    if (!(it >= 1) || !mem || mem <= 0 || !par || par <= 0) return { level: 'refuse', reasons: ['Argon2id settings are incomplete'] };
    if (mem < ARGON2_MIN.memory) reasons.push(`Argon2id uses ${mem} MiB of memory (at least ${ARGON2_MIN.memory} MiB is recommended)`);
    if (it < ARGON2_MIN.iterations) reasons.push(`Argon2id runs ${it} ${it === 1 ? 'round' : 'rounds'} (at least ${ARGON2_MIN.iterations} is recommended)`);
    if (par < ARGON2_MIN.parallelism) reasons.push('Argon2id uses no parallelism');
  }
  // Unknown KDF types are reported elsewhere (UnsupportedKeyFormat) when the key is derived.
  return { level: reasons.length ? 'weak' : 'ok', reasons };
}

/** Stable text for "the user dismissed the warning for exactly these settings". */
export const kdfSignature = (k: Kdf) => `${k.kdf}:${k.kdfIterations}:${k.kdfMemory ?? ''}:${k.kdfParallelism ?? ''}`;
