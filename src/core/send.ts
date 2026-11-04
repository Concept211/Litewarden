// SPDX-License-Identifier: GPL-3.0-only
// Share by secure link, on Bitwarden's Send protocol: the wire format, the link, and what a share contains.
//
// A link's secret is 16 random bytes. They reach the recipient only in the part of the link after the "#", which
// browsers don't send to servers; the server keeps them wrapped under the user key, so the sender can copy the link
// again later. Everything the recipient reads is encrypted under a key derived from those bytes.
import type { ServerUrls } from './api';
import { showExpiry } from './cards';
import { b64encode, b64url, buf, concat, randomBytes, utf8 } from './bytes';
import type { Crypto, SymKey } from './crypto/types';
import type { FullItem } from './vault';

const subtle = globalThis.crypto.subtle;

export const SendType = { Text: 0, File: 1 } as const;

/** Bitwarden's policy types that touch sharing. */
export const PolicyType = { DisableSend: 6, SendOptions: 7 } as const;

/** Files are read whole into memory to encrypt them. */
export const MAX_SHARE_BYTES = 100 * 1024 * 1024;

export const SHARE_LASTS = {
  '1h': { label: '1 hour', ms: 3_600_000 },
  '1d': { label: '1 day', ms: 86_400_000 },
  '7d': { label: '7 days', ms: 7 * 86_400_000 },
  '30d': { label: '30 days', ms: 30 * 86_400_000 },
} as const;
export type ShareLasts = keyof typeof SHARE_LASTS;

// ---------- server payload shapes ----------

export interface SendRecord {
  id: string;
  accessId: string;
  type: number;
  name: string;
  notes?: string | null;
  key: string;
  text?: { text: string | null; hidden?: boolean } | null;
  file?: { id: string | null; fileName: string | null; size?: string | number | null; sizeName?: string | null } | null;
  maxAccessCount?: number | null;
  accessCount?: number;
  /** Set when a password protects the link. */
  password?: string | null;
  disabled?: boolean;
  hideEmail?: boolean;
  revisionDate?: string;
  expirationDate?: string | null;
  deletionDate: string;
}

export interface Policy {
  type: number;
  enabled: boolean;
  organizationId?: string | null;
  data?: Record<string, unknown> | null;
}

/** POST /api/sends/file/v2. fileUploadType 0: this server takes the file; 1: Azure, used by Bitwarden's cloud. */
export interface FileUploadSlot {
  url: string;
  fileUploadType?: number;
  sendResponse: SendRecord;
}

// ---------- keys ----------

export const newSendMaterial = (): Uint8Array => randomBytes(16);

/** The key that encrypts a share's contents: HKDF-SHA256 of its 16 random bytes. */
export async function sendContentKey(c: Crypto, material: Uint8Array): Promise<SymKey> {
  const ikm = await subtle.importKey('raw', buf(material), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(utf8('bitwarden-send')), info: buf(utf8('send')) }, ikm, 512);
  return c.symKey(new Uint8Array(bits));
}

/** What the server stores for a password-protected link. The password itself never leaves this device. */
export async function sendPasswordHash(password: string, material: Uint8Array): Promise<string> {
  const k = await subtle.importKey('raw', buf(utf8(password)), 'PBKDF2', false, ['deriveBits']);
  return b64encode(new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(material), iterations: 100_000 }, k, 256)));
}

/** The link to give someone. Bitwarden's US cloud has its own address for these; every other server uses its web vault. */
export function sendLink(urls: ServerUrls, accessId: string, material: Uint8Array): string {
  const start = urls.cloud === 'US' ? 'https://send.bitwarden.com/#' : `${urls.webVault}/#/send/`;
  return `${start}${accessId}/${b64url(material)}`;
}

// ---------- building ----------

export interface ShareOptions {
  title: string;
  lasts: ShareLasts;
  oneView: boolean;
  password: string | null;
  hideEmail: boolean;
}

/** The fields every kind of share has. The link ends and the server removes the contents at the same moment. */
async function commonBody(c: Crypto, o: ShareOptions, material: Uint8Array, key: SymKey, userKey: SymKey, now: number) {
  const end = new Date(now + SHARE_LASTS[o.lasts].ms).toISOString();
  return {
    name: await c.encryptString(o.title, key),
    notes: null,
    key: await c.encryptBytes(material, userKey),
    deletionDate: end,
    expirationDate: end,
    maxAccessCount: o.oneView ? 1 : null,
    disabled: false,
    hideEmail: o.hideEmail,
    password: o.password ? await sendPasswordHash(o.password, material) : null,
  };
}

export async function buildTextSend(c: Crypto, o: ShareOptions, text: string, userKey: SymKey, now = Date.now()) {
  const material = newSendMaterial();
  const key = await sendContentKey(c, material);
  const body = {
    type: SendType.Text,
    ...(await commonBody(c, o, material, key, userKey, now)),
    text: { text: await c.encryptString(text, key), hidden: false },
    file: null,
  };
  return { body, material };
}

/** Bytes of a file once encrypted: type byte, IV, MAC and the AES-CBC text with its padding. */
export const encryptedFileLength = (plain: number): number => 1 + 16 + 32 + (Math.floor(plain / 16) + 1) * 16;

export async function buildFileSend(c: Crypto, o: ShareOptions, fileName: string, plainLength: number, userKey: SymKey, now = Date.now()) {
  const material = newSendMaterial();
  const key = await sendContentKey(c, material);
  const encName = await c.encryptString(fileName, key);
  const body = {
    type: SendType.File,
    fileLength: encryptedFileLength(plainLength),
    ...(await commonBody(c, o, material, key, userKey, now)),
    text: null,
    file: { fileName: encName },
  };
  return { body, material, encName };
}

/** Encrypt a whole file into the format the recipient's page reads: 0x02, IV, MAC, then the AES-CBC text. */
export async function encryptSendFile(bytes: Uint8Array, key: SymKey): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: buf(iv) }, await key.encKey, buf(bytes)));
  const mac = new Uint8Array(await subtle.sign('HMAC', await key.macKey, buf(concat(iv, ct))));
  return concat(Uint8Array.of(2), iv, mac, ct);
}

// ---------- reading ----------

export interface ShareRow {
  id: string;
  kind: 'text' | 'file';
  title: string;
  fileName: string | null;
  views: number;
  maxViews: number | null;
  hasPassword: boolean;
  hideEmail: boolean;
  /** When the link stops working (ms). */
  endsAt: number;
  /** The link no longer opens: expired, out of views or turned off. */
  closed: boolean;
}

export function shareClosed(s: SendRecord, now = Date.now()): boolean {
  const end = Date.parse(s.expirationDate ?? s.deletionDate);
  return !!s.disabled || end <= now || Date.parse(s.deletionDate) <= now || (s.maxAccessCount != null && (s.accessCount ?? 0) >= s.maxAccessCount);
}

export async function readShare(c: Crypto, s: SendRecord, userKey: SymKey, now = Date.now()): Promise<ShareRow> {
  const key = await sendContentKey(c, await c.decryptBytes(s.key, userKey));
  return {
    id: s.id,
    kind: s.type === SendType.File ? 'file' : 'text',
    title: (await c.decryptString(s.name, key)) ?? '',
    fileName: s.file?.fileName ? await c.decryptString(s.file.fileName, key) : null,
    views: s.accessCount ?? 0,
    maxViews: s.maxAccessCount ?? null,
    hasPassword: !!s.password,
    hideEmail: !!s.hideEmail,
    endsAt: Date.parse(s.expirationDate ?? s.deletionDate),
    closed: shareClosed(s, now),
  };
}

/** The links that still open first, soonest to end on top; then the ones that don't. */
export function sortShares(rows: ShareRow[]): ShareRow[] {
  return [...rows].sort((a, b) => Number(a.closed) - Number(b.closed) || a.endsAt - b.endsAt || a.title.localeCompare(b.title));
}

// ---------- policies ----------

export interface SharePolicy {
  /** An organization's policy forbids making links. */
  disabled: boolean;
  /** An organization's policy forbids hiding the sender's email. */
  noHideEmail: boolean;
}

/** The policies that bind this account. Owners and admins (types 0 and 1) are exempt, as the server treats them. */
export function sharePolicy(policies: Policy[] | null | undefined, orgs: ReadonlyArray<{ id: string; type?: number }> = []): SharePolicy {
  const role = new Map(orgs.map((o) => [o.id, o.type]));
  const binding = (policies ?? []).filter((p) => {
    if (!p.enabled) return false;
    const t = p.organizationId ? role.get(p.organizationId) : undefined;
    return t === undefined || t > 1;
  });
  return {
    disabled: binding.some((p) => p.type === PolicyType.DisableSend),
    noHideEmail: binding.some((p) => p.type === PolicyType.SendOptions && (p.data?.disableHideEmail ?? p.data?.DisableHideEmail) === true),
  };
}

// ---------- what goes into a shared item ----------

/** The saved fields a share can pick from. `on`: included until the user taps it off. */
export interface ShareField {
  key: string;
  label: string;
  /** The text this field adds to the message. */
  text: string;
  on: boolean;
}

const line = (label: string, v: string | null | undefined): string | null => (v?.trim() ? `${label}: ${v.trim()}` : null);
const lines = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join('\n');

/** The fields an item can share. Whatever gives lasting access beyond the password starts off. */
export function shareFields(it: Pick<FullItem, 'notes' | 'login' | 'card' | 'identity' | 'fields'>): ShareField[] {
  const out: ShareField[] = [];
  const add = (key: string, label: string, text: string | null | undefined, on = true) => {
    if (text) out.push({ key, label, text, on });
  };
  if (it.login) {
    add('username', 'Username', line('Username', it.login.username));
    add('password', 'Password', line('Password', it.login.password));
    const uris = it.login.uris.map((u) => u.uri).filter(Boolean);
    add('website', uris.length > 1 ? 'Websites' : 'Website', uris.length > 1 ? lines(...uris.map((u, i) => line(`Website ${i + 1}`, u))) : line('Website', uris[0]));
    add('totp', '2FA secret', line('2FA secret', it.login.totp), false);
  }
  if (it.card) {
    add('name', 'Name on card', line('Name on card', it.card.cardholderName));
    add('number', 'Number', line('Number', it.card.number));
    add('expiry', 'Expires', line('Expires', showExpiry(it.card.expMonth, it.card.expYear)));
    add('code', 'Security code', line('Security code', it.card.code), false);
  }
  if (it.identity) {
    const d = it.identity;
    const person = [d.title, d.firstName, d.middleName, d.lastName].filter((x) => x?.trim()).join(' ');
    add('name', 'Name', line('Name', person));
    add('email', 'Email', line('Email', d.email));
    add('phone', 'Phone', line('Phone', d.phone));
    add('company', 'Company', line('Company', d.company));
    const place = [[d.city, d.state].filter((x) => x?.trim()).join(', '), d.postalCode].filter((x) => x?.trim()).join(' ');
    add('address', 'Address', line('Address', [d.address1, d.address2, d.address3, place, d.country].filter((x) => x?.trim()).join(', ')));
    add('ssn', 'SSN', line('SSN', d.ssn), false);
    add('passport', 'Passport', line('Passport', d.passportNumber), false);
    add('license', 'License', line('License', d.licenseNumber), false);
  }
  // A note's text is the note; on anything else it's an extra. Linked fields (type 3) hold no value of their own.
  if (it.notes?.trim()) add('notes', it.login || it.card || it.identity ? 'Notes' : 'Note', it.login || it.card || it.identity ? line('Notes', it.notes) : it.notes.trim(), !(it.login || it.card || it.identity));
  const custom = (it.fields ?? []).filter((f) => f.type !== 3 && f.name && f.value);
  add('fields', 'Other fields', lines(...custom.map((f) => line(f.name!, f.value))), false);
  return out;
}

/** The message for the fields that are on, in the order they're listed. */
export const composeShare = (fields: readonly ShareField[], on: ReadonlySet<string>): string => lines(...fields.filter((f) => on.has(f.key)).map((f) => f.text));

const SECRETISH = /pass(word|code|phrase)?|pwd|secret|token|key|\bpin\b|otp|ssn/i;

/**
 * A title from the message's first line, or null when it would give something away: the title also shows in the list
 * of links, and a first line is often the secret itself. Anything but plain words counts as a possible secret.
 */
export function titleFromMessage(text: string): string | null {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first || first.length > 60 || SECRETISH.test(first) || /[:=@#$%^&*!]/.test(first)) return null;
  // A long unbroken run, or letters mixed with digits inside one word, reads like a generated value.
  if (first.split(/\s+/).some((w) => w.length > 20 || (/\d/.test(w) && /[a-z]/i.test(w) && w.length > 5))) return null;
  return first;
}
