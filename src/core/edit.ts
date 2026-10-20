// SPDX-License-Identifier: GPL-3.0-only
// Turn an edited item back into a server request. Starts from the stored (encrypted) cipher and only replaces what
// the editor changed, so anything Litewarden doesn't edit yet (custom fields, passkeys, card details, password
// history) goes back to the server untouched.
import type { Cipher } from './api';
import { b64encode, buf, utf8 } from './bytes';
import type { Crypto, SymKey } from './crypto/types';
import { CipherType, cipherKey, type Keys, type ListUri } from './vault';

export interface Draft {
  type: number;
  name: string;
  notes: string | null;
  folderId: string | null;
  favorite?: boolean;
  login?: { username: string | null; password: string | null; totp: string | null; uris: ListUri[] };
}

/** Bitwarden clients drop a URI whose checksum doesn't match, so every written URI gets a fresh one. */
async function uriChecksum(c: Crypto, uri: string, key: SymKey): Promise<string> {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf(utf8(uri))));
  return c.encryptString(b64encode(h), key);
}

const blank = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v);

export function validateDraft(d: Draft): string | null {
  if (!d.name.trim()) return 'Give it a name.';
  for (const u of d.login?.uris ?? []) {
    if (u.match === 4) {
      try {
        new RegExp(u.uri);
      } catch {
        return `“${u.uri}” isn't a valid regular expression.`;
      }
    }
  }
  return null;
}

export interface EncryptOptions {
  /** The stored cipher when editing; null for a new item. */
  original: Cipher | null;
  /** The user's id. Required on writes since Vaultwarden 1.37.4. */
  encryptedFor: string;
  now?: Date;
}

export async function encryptDraft(c: Crypto, d: Draft, keys: Keys, o: EncryptOptions): Promise<Record<string, unknown>> {
  const orig = o.original;
  const key = orig ? await cipherKey(c, orig, keys) : keys.userKey;
  const e = (v: string | null | undefined) => (blank(v) == null ? Promise.resolve(null) : c.encryptString(v as string, key));
  const now = (o.now ?? new Date()).toISOString();

  const body: Record<string, unknown> = {
    // Pass-through first: fields, passwordHistory, card, identity, secureNote, sshKey, reprompt, key...
    ...(orig ?? {}),
    type: d.type,
    organizationId: orig?.organizationId ?? null,
    folderId: d.folderId,
    favorite: d.favorite ?? orig?.favorite ?? false,
    reprompt: orig?.reprompt ?? 0,
    key: orig?.key ?? null,
    name: await c.encryptString(d.name.trim(), key),
    notes: await e(d.notes),
    encryptedFor: o.encryptedFor,
    lastKnownRevisionDate: orig?.revisionDate ?? null,
  };
  // Read-only server fields never go back.
  for (const k of ['id', 'object', 'revisionDate', 'creationDate', 'deletedDate', 'edit', 'viewPassword', 'manage', 'permissions', 'attachments', 'collectionIds', 'organizationUseTotp', 'data']) delete body[k];

  if (d.type === CipherType.Login) {
    const l = d.login ?? { username: null, password: null, totp: null, uris: [] };
    const prev = (orig?.login ?? {}) as Record<string, unknown>;
    const uris = l.uris.filter((u) => u.uri.trim());
    const login: Record<string, unknown> = {
      ...prev,
      username: await e(l.username),
      password: await e(l.password),
      totp: await e(l.totp?.replace(/\s+/g, '') ?? null),
      uris: await Promise.all(uris.map(async (u) => ({ uri: await c.encryptString(u.uri.trim(), key), match: u.match ?? null, uriChecksum: await uriChecksum(c, u.uri.trim(), key) }))),
    };
    login.uri = (login.uris as Array<{ uri: string }>)[0]?.uri ?? null;
    // Keep the old password in the history when it changes (newest first, five kept), like Bitwarden does.
    const oldEnc = typeof prev.password === 'string' ? prev.password : null;
    const oldPw = oldEnc ? await c.decryptString(oldEnc, key).catch(() => null) : null;
    if (oldPw && oldPw !== (blank(l.password) ?? null)) {
      const hist = Array.isArray(body.passwordHistory) ? (body.passwordHistory as unknown[]) : [];
      body.passwordHistory = [{ password: oldEnc, lastUsedDate: now }, ...hist].slice(0, 5);
      login.passwordRevisionDate = now;
    }
    body.login = login;
  } else if (d.type === CipherType.SecureNote) {
    body.secureNote = (orig?.secureNote as unknown) ?? { type: 0 };
  }
  return body;
}
