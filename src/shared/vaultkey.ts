// SPDX-License-Identifier: GPL-3.0-only
// Seals the session that "Lock when the browser closes: off" keeps on disk. chrome.storage.local can be read from
// the content-script world (and the worker also fences it off with setAccessLevel), so what we put there is
// AES-GCM encrypted under a non-extractable WebCrypto key kept in IndexedDB. IndexedDB belongs to the extension's
// own origin, which page scripts and content scripts can't open. Reading storage.local alone gets ciphertext.
// This is not protection from malware that can read the whole browser profile; the key lives in the same profile.
import { b64decode, b64encode } from '../core/bytes';
import type { Session } from './store';

export interface Sealed {
  v: 1;
  iv: string;
  ct: string;
}

/** Where the wrapping key lives. IndexedDB in the extension; an in-memory fake in unit tests. */
export interface KeyStore {
  get(): Promise<CryptoKey | undefined>;
  put(key: CryptoKey): Promise<void>;
  del(): Promise<void>;
}

const DB = 'litewarden-keys';
const STORE = 'keys';
const ID = 'session-wrap';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => res(r.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  } finally {
    db.close();
  }
}

export const idbKeyStore: KeyStore = {
  get: () => tx('readonly', (s) => s.get(ID) as IDBRequest<CryptoKey | undefined>),
  put: async (k) => void (await tx('readwrite', (s) => s.put(k, ID))),
  del: async () => {
    if (typeof indexedDB === 'undefined') return;
    await tx('readwrite', (s) => s.delete(ID));
  },
};

let current: KeyStore = idbKeyStore;
/** Tests swap in a fake; the extension always uses IndexedDB. */
export const setKeyStore = (ks: KeyStore) => void (current = ks);

const aad = new TextEncoder().encode('litewarden/session/v1');

async function key(ks: KeyStore, create: boolean): Promise<CryptoKey | null> {
  const have = await ks.get();
  if (have || !create) return have ?? null;
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await ks.put(k);
  return k;
}

export async function seal(s: Session, ks: KeyStore = current): Promise<Sealed> {
  const k = (await key(ks, true))!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, new TextEncoder().encode(JSON.stringify(s))));
  return { v: 1, iv: b64encode(iv), ct: b64encode(ct) };
}

/** The session, or null when the key is gone or the data was changed. */
export async function unseal(x: Sealed | null | undefined, ks: KeyStore = current): Promise<Session | null> {
  if (!x || x.v !== 1) return null;
  try {
    const k = await key(ks, false);
    if (!k) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(x.iv) as BufferSource, additionalData: aad }, k, b64decode(x.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(pt)) as Session;
  } catch {
    return null;
  }
}

/** Forget the key: whatever was sealed with it can't be opened again. Called on every lock and log out. */
export async function dropKey(ks: KeyStore = current): Promise<void> {
  await ks.del().catch(() => {});
}
