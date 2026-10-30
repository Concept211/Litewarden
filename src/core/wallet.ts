// SPDX-License-Identifier: GPL-3.0-only
// Crypto wallets. Bitwarden servers only know five item types, so a wallet is a secure note with named custom
// fields ("Network", "Public address", "Private key", "Seed phrase"). Litewarden spots one by those names, so a
// wallet made by hand in the web vault or the official apps shows up as a wallet too, and nothing is locked in.
// Pure string work only: the key and word-list checks live in shared/walletcheck.ts, loaded by the form alone.

export type WalletPart = 'network' | 'address' | 'privateKey' | 'seed';

/** The names and field types a new wallet is saved with. */
export const WALLET_FIELDS: Record<WalletPart, { name: string; type: 0 | 1 }> = {
  network: { name: 'Network', type: 0 },
  address: { name: 'Public address', type: 0 },
  privateKey: { name: 'Private key', type: 1 },
  seed: { name: 'Seed phrase', type: 1 },
};
export const WALLET_PARTS: WalletPart[] = ['network', 'address', 'privateKey', 'seed'];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES: Record<string, WalletPart> = {
  network: 'network', chain: 'network', blockchain: 'network',
  'public address': 'address', 'wallet address': 'address', 'receive address': 'address', 'deposit address': 'address', address: 'address',
  'private key': 'privateKey', 'secret key': 'privateKey',
  'seed phrase': 'seed', seed: 'seed', 'seed words': 'seed', 'recovery phrase': 'seed', 'secret recovery phrase': 'seed',
  'secret phrase': 'seed', 'backup phrase': 'seed', mnemonic: 'seed', 'mnemonic phrase': 'seed',
};

/** Which wallet part a custom field holds, from its name. Checkbox and linked fields never count. */
export function walletPart(name: string | null | undefined, type = 0): WalletPart | null {
  if (!name || type === 2 || type === 3) return null;
  return ALIASES[key(name)] ?? null;
}

type Field = { name: string | null; value: string | null; type: number };
export interface Wallet {
  network: string | null;
  address: string | null;
  privateKey: string | null;
  seed: string | null;
  /** Index of each part's field in the item's fields. */
  at: Partial<Record<WalletPart, number>>;
}

/**
 * The wallet in a note's custom fields, or null when it isn't one. A private key or seed phrase field makes it a
 * wallet. So does an address field, but a field named just "Address" only counts when its value looks like a crypto
 * address, so a note holding a street address stays a note.
 */
export function walletOf(fields: readonly Field[] | null | undefined): Wallet | null {
  if (!fields?.length) return null;
  const w: Wallet = { network: null, address: null, privateKey: null, seed: null, at: {} };
  let real = false;
  fields.forEach((f, i) => {
    const part = walletPart(f.name, f.type);
    if (!part || w.at[part] !== undefined) return;
    const value = f.value?.trim() || null;
    if (part === 'address' && key(f.name ?? '') === 'address' && !(value && networkOfAddress(value))) return;
    w.at[part] = i;
    w[part] = value;
    if (part !== 'network') real = true;
  });
  return real ? w : null;
}

export interface Network {
  id: string;
  name: string;
  /** Uses Ethereum-style 0x addresses, so one key gives the same address on all of them. */
  evm?: boolean;
  /** The address card's gradient. */
  colors: [string, string];
}

export const NETWORKS: Network[] = [
  { id: 'ethereum', name: 'Ethereum', evm: true, colors: ['#6f84ee', '#30397a'] },
  { id: 'hyperliquid', name: 'Hyperliquid', evm: true, colors: ['#2c9c8f', '#14514b'] },
  { id: 'base', name: 'Base', evm: true, colors: ['#2f6bff', '#0b2fa8'] },
  { id: 'arbitrum', name: 'Arbitrum', evm: true, colors: ['#2d6fb5', '#1b2f4a'] },
  { id: 'bnb', name: 'BNB Chain', evm: true, colors: ['#d9a40b', '#6e4f00'] },
  { id: 'polygon', name: 'Polygon', evm: true, colors: ['#8f5bf0', '#4a1f9e'] },
  { id: 'optimism', name: 'Optimism', evm: true, colors: ['#ff3346', '#99001a'] },
  { id: 'avalanche', name: 'Avalanche', evm: true, colors: ['#e84142', '#7d1516'] },
  { id: 'bitcoin', name: 'Bitcoin', colors: ['#e08a1e', '#7a440c'] },
  { id: 'solana', name: 'Solana', colors: ['#8a46f0', '#13a07a'] },
  { id: 'tron', name: 'Tron', colors: ['#e0353a', '#7c1013'] },
  { id: 'xrp', name: 'XRP', colors: ['#3a3f48', '#111418'] },
  { id: 'litecoin', name: 'Litecoin', colors: ['#4a6fb5', '#203a6e'] },
  { id: 'cardano', name: 'Cardano', colors: ['#2a5bd7', '#0d2a6e'] },
  { id: 'ton', name: 'TON', colors: ['#1f9be6', '#0b4f80'] },
  { id: 'sui', name: 'Sui', colors: ['#5aa7f5', '#1f5aa0'] },
];
export const OTHER_COLORS: [string, string] = ['#6b7486', '#353b48'];

/** A saved network name ("Hyperliquid", "hyperliquid", "BSC") to one of ours, or null for a name we don't know. */
export function networkById(name: string | null | undefined): Network | null {
  if (!name) return null;
  const k = key(name);
  const hit = NETWORKS.find((n) => n.id === k || key(n.name) === k);
  if (hit) return hit;
  const h = HINTS.find(([re]) => re.test(k));
  return h ? byId(h[1]) : null;
}
const byId = (id: string) => NETWORKS.find((n) => n.id === id) ?? null;

const B58 = '[1-9A-HJ-NP-Za-km-z]';
/** The network family an address's format points to. 0x addresses say "ethereum", the default for EVM. */
export function networkOfAddress(a: string): string | null {
  const s = a.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return 'ethereum';
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return 'sui';
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{11,87}$/i.test(s)) return 'bitcoin';
  if (/^ltc1[02-9ac-hj-np-z]{11,87}$/i.test(s)) return 'litecoin';
  if (/^addr1[0-9a-z]{50,}$/.test(s)) return 'cardano';
  if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(s)) return 'ton';
  if (new RegExp(`^T${B58}{33}$`).test(s)) return 'tron';
  if (new RegExp(`^[LM]${B58}{26,33}$`).test(s)) return 'litecoin';
  if (new RegExp(`^r${B58}{24,34}$`).test(s)) return 'xrp';
  if (new RegExp(`^[13]${B58}{25,34}$`).test(s)) return 'bitcoin';
  if (new RegExp(`^${B58}{40,44}$`).test(s)) return 'solana';
  return null;
}

// Words in a wallet's name or site that point to a network. Checked in order.
const HINTS: Array<[RegExp, string]> = [
  [/\b(hyperliquid|hyperevm|hype)\b/, 'hyperliquid'],
  [/\b(arbitrum|arb)\b/, 'arbitrum'],
  [/\b(bnb|binance|bsc)\b/, 'bnb'],
  [/\b(polygon|matic)\b/, 'polygon'],
  [/\b(optimism|op mainnet)\b/, 'optimism'],
  [/\b(avalanche|avax)\b/, 'avalanche'],
  [/\b(base)\b/, 'base'],
  [/\b(bitcoin|btc)\b/, 'bitcoin'],
  [/\b(solana|sol)\b/, 'solana'],
  [/\b(tron|trx)\b/, 'tron'],
  [/\b(xrp|ripple)\b/, 'xrp'],
  [/\b(litecoin|ltc)\b/, 'litecoin'],
  [/\b(cardano)\b/, 'cardano'],
  [/\b(ton|tonkeeper)\b/, 'ton'],
  [/\b(sui)\b/, 'sui'],
  [/\b(ethereum|eth|ether)\b/, 'ethereum'],
];

export interface Guess {
  id: string;
  /** Why: shown under the network box. */
  from: 'address' | 'name' | 'site';
}

/**
 * The network to preselect. A hint in the name or site wins when it fits the address (a 0x address can be
 * Hyperliquid, Base and the rest), otherwise the address format decides.
 */
export function guessNetwork(o: { address?: string | null; name?: string | null; urls?: readonly string[] }): Guess | null {
  const fam = o.address ? networkOfAddress(o.address) : null;
  const fits = (id: string) => !fam || id === fam || (byId(fam)?.evm && byId(id)?.evm);
  const hint = (text: string) => HINTS.find(([re]) => re.test(key(text)))?.[1];
  const fromName = o.name ? hint(o.name) : undefined;
  if (fromName && fits(fromName)) return { id: fromName, from: 'name' };
  for (const u of o.urls ?? []) {
    const h = hint((u.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '').replace(/\./g, ' '));
    if (h && fits(h)) return { id: h, from: 'site' };
  }
  return fam ? { id: fam, from: 'address' } : null;
}

/** "0x2c75…5c23", "bc1qar…5mdq". Short addresses stay whole. */
export function shortAddress(a: string | null | undefined): string {
  const s = (a ?? '').trim();
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** A warning about the address's shape for the chosen network, or null. Never blocks saving. */
export function addressProblem(address: string, network: Network | null): string | null {
  const s = address.trim();
  if (!s) return null;
  if (/\s/.test(s)) return 'An address has no spaces. Check what was pasted.';
  if (network?.evm || (!network && /^0x/i.test(s))) {
    if (!/^0x/i.test(s)) return `${network?.name ?? 'These'} addresses start with 0x.`;
    const hex = s.slice(2);
    if (!/^[0-9a-fA-F]*$/.test(hex)) return 'A 0x address only has the digits 0-9 and the letters a-f.';
    if (hex.length < 40) return `This 0x address is ${40 - hex.length} character${40 - hex.length === 1 ? '' : 's'} short.`;
    if (hex.length > 40) return `This 0x address is ${hex.length - 40} character${hex.length - 40 === 1 ? '' : 's'} too long.`;
    return null;
  }
  if (!network) return null;
  const fam = networkOfAddress(s);
  if (fam === network.id) return null;
  return `This doesn't look like a ${network.name} address.`;
}

/** A seed phrase as words, from however it was pasted: spaces, new lines, commas, "1. word 2. word". */
export function seedWords(seed: string | null | undefined): string[] {
  return (seed ?? '')
    .split(/[\s,]+/)
    .map((w) => w.replace(/^\d+[.):-]/, '').trim())
    .filter((w) => w && !/^\d+[.):-]?$/.test(w))
    .map((w) => w.toLowerCase());
}

/** The phrase as stored: words in order, one space apart. */
export function normalizeSeed(seed: string | null | undefined): string {
  return seedWords(seed).join(' ');
}

/** The list's type filter and the "+" menu use this for wallets, next to the real cipher types (1 to 4). */
export const WALLET_KIND = 102;
