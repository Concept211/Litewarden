// SPDX-License-Identifier: GPL-3.0-only
// Account keys and vault decryption. Two stages: a light list item (what the popup and search need)
// decrypted for every cipher at unlock/sync, and the full item decrypted only when it's opened or filled.
import type { AccountKeys, Cipher, CipherUri, SyncResponse } from './api';
import { encTypeOf } from './crypto/encstring';
import type { Crypto, Kdf, PrivateKeys, SymKey } from './crypto/types';
import { UnsupportedKeyFormat } from './errors';
import { cardLabel, showExpiry } from './cards';
import { networkById, shortAddress, walletOf, walletPart } from './wallet';

export const CipherType = { Login: 1, SecureNote: 2, Card: 3, Identity: 4, SshKey: 5 } as const;

/** Refuse accounts that use formats we can't read (V2 keys, COSE), with a plain message instead of garbage. */
export function assertSupportedAccount(encUserKey: string | null | undefined, accountKeys?: AccountKeys | null): void {
  if (accountKeys?.signatureKeyPair || accountKeys?.securityState) throw new UnsupportedKeyFormat('V2 account keys');
  const t = encTypeOf(encUserKey);
  if (t === 7) throw new UnsupportedKeyFormat('COSE user key, type 7');
}

export interface UnlockResult {
  masterKey: Uint8Array;
  masterPasswordHash: string;
  userKey: SymKey;
}

/** Master password -> master key -> stretched key -> unwrap the user key. Throws DecryptError on a wrong password. */
export async function unlockWithPassword(c: Crypto, password: string, email: string, kdf: Kdf, encUserKey: string): Promise<UnlockResult> {
  const masterKey = await c.deriveMasterKey(password, email, kdf);
  const stretched = await c.stretchMasterKey(masterKey);
  const userKey = c.symKey(await c.decryptBytes(encUserKey, stretched));
  return { masterKey, masterPasswordHash: await c.masterPasswordHash(masterKey, password), userKey };
}

export interface Keys {
  userKey: SymKey;
  privateKeys: PrivateKeys | null;
  orgKeys: Map<string, SymKey>;
  /** Organizations whose key could not be unwrapped; their items are reported, not silently dropped. */
  orgKeyErrors: Map<string, Error>;
}

export async function loadKeys(c: Crypto, sync: SyncResponse, userKey: SymKey, encPrivateKey?: string | null): Promise<Keys> {
  assertSupportedAccount(sync.profile.key, sync.profile.accountKeys);
  const pk = sync.profile.privateKey ?? encPrivateKey ?? null;
  const privateKeys = pk ? await c.loadPrivateKeys(pk, userKey) : null;
  const orgKeys = new Map<string, SymKey>();
  const orgKeyErrors = new Map<string, Error>();
  for (const o of sync.profile.organizations ?? []) {
    if (!o.key) continue;
    try {
      if (!privateKeys) throw new Error('No account private key to unwrap organization keys.');
      orgKeys.set(o.id, c.symKey(await c.rsaDecrypt(o.key, privateKeys)));
    } catch (err) {
      orgKeyErrors.set(o.id, err as Error);
    }
  }
  return { userKey, privateKeys, orgKeys, orgKeyErrors };
}

/** Resolve a cipher's key: org key or user key, then the optional per-item key. */
export async function cipherKey(c: Crypto, cipher: Cipher, keys: Keys): Promise<SymKey> {
  const base = cipher.organizationId ? keys.orgKeys.get(cipher.organizationId) : keys.userKey;
  if (!base) {
    const why = cipher.organizationId ? keys.orgKeyErrors.get(cipher.organizationId) : undefined;
    throw why ?? new Error('No key for this item.');
  }
  return cipher.key ? c.symKey(await c.decryptBytes(cipher.key, base)) : base;
}

export interface ListUri {
  uri: string;
  /** Bitwarden UriMatchType: 0 base domain, 1 host, 2 starts with, 3 exact, 4 regex, 5 never; null = account default */
  match: number | null;
}

/** What the popup list and search index hold. No password, no TOTP secret, no notes. */
export interface ListItem {
  id: string;
  type: number;
  orgId: string | null;
  folderId: string | null;
  name: string;
  username: string | null;
  uris: ListUri[];
  hasTotp: boolean;
  favorite: boolean;
  reprompt: number;
  revisionDate: string | null;
  /** The list's second line for cards ("Visa •4242 · 08/28") and identities ("Alex Rivera · Miami, FL"). */
  subtitle?: string | null;
  /** Cards: the stored brand, for the brand mark. */
  brand?: string | null;
  /** Cards: the expiry as MM/YY, for "expired" in the list. */
  exp?: string | null;
  /** Secure notes that hold a crypto wallet: the network and the public address. Never the key or phrase. */
  wallet?: { network: string | null; address: string | null };
}

export async function decryptListItem(c: Crypto, cipher: Cipher, keys: Keys): Promise<ListItem> {
  const k = await cipherKey(c, cipher, keys);
  const d = (v: string | null | undefined) => (v == null ? Promise.resolve(null) : c.decryptString(v, k));
  const item: ListItem = {
    id: cipher.id,
    type: cipher.type,
    orgId: cipher.organizationId ?? null,
    folderId: cipher.folderId ?? null,
    name: (await d(cipher.name)) ?? '',
    username: null,
    uris: [],
    hasTotp: false,
    favorite: !!cipher.favorite,
    reprompt: cipher.reprompt ?? 0,
    revisionDate: cipher.revisionDate ?? null,
  };
  if (cipher.type === CipherType.Login && cipher.login) {
    item.username = await d(cipher.login.username);
    item.hasTotp = !!cipher.login.totp;
    item.uris = (
      await Promise.all((cipher.login.uris ?? []).map(async (u: CipherUri) => ({ uri: (await d(u.uri)) ?? '', match: u.match ?? null })))
    ).filter((u) => u.uri);
  } else if (cipher.type === CipherType.Card && cipher.card) {
    const [brand, num, month, year] = await Promise.all([d(cipher.card.brand), d(cipher.card.number), d(cipher.card.expMonth), d(cipher.card.expYear)]);
    item.brand = brand;
    item.exp = showExpiry(month, year) || null;
    item.subtitle = cardLabel(brand, num) || null;
  } else if (cipher.type === CipherType.Identity && cipher.identity) {
    const i = cipher.identity;
    const [first, last, city, state, email] = await Promise.all([d(i.firstName), d(i.lastName), d(i.city), d(i.state), d(i.email)]);
    const who = [first, last].filter(Boolean).join(' ');
    const where = [city, state].filter(Boolean).join(', ');
    item.subtitle = [who || email, where].filter(Boolean).join(' · ') || null;
  } else if (cipher.type === CipherType.SecureNote && cipher.fields?.length) {
    // Field names, plus the plain-text network and address. Hidden values stay encrypted until the item is opened.
    const fields = await Promise.all(
      cipher.fields.map(async (f) => {
        const name = await d(f.name).catch(() => null);
        const part = walletPart(name, f.type);
        const open = f.type === 0 && (part === 'network' || part === 'address');
        return { name, type: f.type, value: open ? await d(f.value).catch(() => null) : null };
      }),
    );
    const w = walletOf(fields);
    if (w) {
      item.wallet = { network: w.network, address: w.address };
      item.subtitle = [networkById(w.network)?.name ?? w.network, shortAddress(w.address)].filter(Boolean).join(' · ') || 'Wallet';
    }
  }
  return item;
}

export interface ListResult {
  items: ListItem[];
  /** Items that failed to decrypt, with the reason. Shown to the user, never hidden. */
  failures: Array<{ id: string; error: Error }>;
}

/** Decrypt the list stage for every live cipher. One bad item never blanks the vault. */
export async function decryptList(c: Crypto, ciphers: Cipher[], keys: Keys): Promise<ListResult> {
  const items: ListItem[] = [];
  const failures: ListResult['failures'] = [];
  await Promise.all(
    ciphers
      .filter((x) => !x.deletedDate)
      .map(async (x) => {
        try {
          items.push(await decryptListItem(c, x, keys));
        } catch (error) {
          failures.push({ id: x.id, error: error as Error });
        }
      }),
  );
  return { items, failures };
}

export interface FullItem {
  id: string;
  type: number;
  orgId: string | null;
  folderId: string | null;
  name: string;
  notes: string | null;
  login?: { username: string | null; password: string | null; totp: string | null; uris: ListUri[] };
  card?: Record<string, string | null>;
  identity?: Record<string, string | null>;
  fields?: Array<{ name: string | null; value: string | null; type: number; linkedId?: number | null }>;
}

export async function decryptItem(c: Crypto, cipher: Cipher, keys: Keys): Promise<FullItem> {
  const k = await cipherKey(c, cipher, keys);
  const d = (v: string | null | undefined) => (v == null ? Promise.resolve(null) : c.decryptString(v, k));
  const decObj = async (o: Record<string, string | null> | null | undefined) => {
    if (!o) return undefined;
    const out: Record<string, string | null> = {};
    for (const [key, v] of Object.entries(o)) out[key] = typeof v === 'string' ? await d(v) : v;
    return out;
  };
  const out: FullItem = {
    id: cipher.id,
    type: cipher.type,
    orgId: cipher.organizationId ?? null,
    folderId: cipher.folderId ?? null,
    name: (await d(cipher.name)) ?? '',
    notes: await d(cipher.notes),
  };
  if (cipher.login) {
    out.login = {
      username: await d(cipher.login.username),
      password: await d(cipher.login.password),
      totp: await d(cipher.login.totp),
      uris: (await Promise.all((cipher.login.uris ?? []).map(async (u) => ({ uri: (await d(u.uri)) ?? '', match: u.match ?? null })))).filter((u) => u.uri),
    };
  }
  const card = await decObj(cipher.card);
  if (card) out.card = card;
  const identity = await decObj(cipher.identity);
  if (identity) out.identity = identity;
  if (cipher.fields) out.fields = await Promise.all(cipher.fields.map(async (f) => ({ name: await d(f.name), value: await d(f.value), type: f.type, linkedId: f.linkedId ?? null })));
  return out;
}
