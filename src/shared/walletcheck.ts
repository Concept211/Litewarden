// SPDX-License-Identifier: GPL-3.0-only
// Checks for the wallet form: the BIP39 word list and checksum, and a 0x private key's address. Everything runs on
// this computer; nothing is looked up online. Loaded with import() by the form only, so the popup's list stays light.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { seedWords } from '../core/wallet';

const WORDS = new Set(wordlist);
const COUNTS = [12, 15, 18, 21, 24];

export type Check = { ok: string } | { bad: string } | null;

/** The seed phrase against the standard English list. Phrases in other languages or scripts are left alone. */
export function checkSeed(seed: string): Check {
  const words = seedWords(seed);
  if (!words.length) return null;
  if (words.some((w) => /[^a-z]/.test(w))) return null;
  const i = words.findIndex((w) => !WORDS.has(w));
  if (i >= 0) return { bad: `Word ${i + 1}, "${words[i]}", isn't on the standard list.` };
  if (!COUNTS.includes(words.length)) return { bad: `Seed phrases have 12, 15, 18, 21 or 24 words. This one has ${words.length}.` };
  if (!validateMnemonic(words.join(' '), wordlist)) return { bad: "Every word is on the list, but the phrase doesn't check out. Check the order." };
  return { ok: `${words.length} words, all on the standard list` };
}

/** EIP-55: the mixed-case form of a 0x address. */
export function checksumAddress(address: string): string {
  const hex = address.replace(/^0x/i, '').toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash.charAt(i), 16) >= 8 ? hex.charAt(i).toUpperCase() : hex.charAt(i);
  return out;
}

/** The 0x address a private key controls, or null when it isn't a valid key. */
export function evmAddressOf(privateKey: string): string | null {
  const hex = privateKey.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    const pub = secp256k1.getPublicKey(hexToBytes(hex.toLowerCase()), false).slice(1);
    return checksumAddress(bytesToHex(keccak_256(pub).slice(-20)));
  } catch {
    return null;
  }
}

/** A typo check for mixed-case 0x addresses, the way wallets do it. All-lowercase or all-uppercase has no checksum. */
export function checkEvmAddress(address: string): Check {
  const s = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  const hex = s.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return null;
  return checksumAddress(s) === s ? null : { bad: "The capital letters don't match this address's checksum. Check for a typo." };
}

/** For 0x wallets: does the private key belong to the address? */
export function checkKey(privateKey: string, address: string, evm: boolean): Check {
  const k = privateKey.trim();
  if (!k || !evm) return null;
  const mine = evmAddressOf(k);
  if (!mine) return { bad: 'A 0x private key is 64 characters of 0-9 and a-f.' };
  const a = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return mine.toLowerCase() === a.toLowerCase() ? { ok: 'Matches the address' } : { bad: `This key belongs to ${mine.slice(0, 6)}…${mine.slice(-4)}, not this address.` };
}
