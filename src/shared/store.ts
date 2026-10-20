// SPDX-License-Identifier: GPL-3.0-only
// What Litewarden keeps where. Two rules:
//  - chrome.storage.local (disk) only ever holds encrypted vault data, tokens, settings and the account's
//    public facts. Never a key, a password or a decrypted name. The one exception, the session mirror for
//    "lock when the browser closes: off", is sealed (vaultkey.ts).
//  - chrome.storage.session (memory, cleared when the browser closes) holds the unlocked session: the user key,
//    org keys and the decrypted list index the popup reads directly on open.
import type { Kdf, ServerInfo, SyncResponse, Tokens } from '../core';
import { DEFAULT_GEN, type GenOptions } from '../core/generator';
import type { ListItem } from '../core/vault';
import type { SiteRule } from './rules';
import type { Sealed } from './vaultkey';

export interface Account {
  server: string;
  email: string;
  userId: string;
  name: string | null;
  kdf: Kdf;
  /** Protected user key (EncString, wrapped by the stretched master key). */
  encUserKey: string;
  encPrivateKey: string | null;
  deviceId: string;
  serverInfo: ServerInfo;
}

export interface Settings {
  /** Minutes of no Litewarden use before locking. 0 = only when the browser closes / manually. */
  lockMinutes: number;
  /** Lock when the browser closes. Off keeps the session on disk (less safe, said so in Settings). */
  lockOnClose: boolean;
  /** PIN unlock keeps working after a browser restart (wrapped key on disk). Off = until the browser closes. */
  pinSurvivesRestart: boolean;
  /** After filling a login with a 2FA secret, copy the current code. */
  copyTotpAfterFill: boolean;
  /** Seconds before a copied secret is cleared from the clipboard. 0 = never. */
  clipboardSeconds: number;
  theme: 'system' | 'light' | 'dark';
  /** Ask before filling a login form that comes from another site inside the page (cross-origin frame). */
  askFrames: boolean;
  /** Prefilled into new logins. Empty = the account email. */
  defaultUsername: string;
  /** Generator choices, remembered between uses. */
  gen: GenOptions;
  popupSize: 'standard' | 'wide' | 'compact';
  density: 'roomy' | 'compact';
  /** Keep a live connection to the server's notifications hub so changes arrive within seconds. */
  liveSync: boolean;
  /** Background sync interval in minutes (also the fallback when live updates aren't available). 0 = off. */
  syncMinutes: number;
  /** Show the Litewarden icon inside login fields on web pages. */
  fieldIcon: boolean;
  /** Hostnames where the field icon is turned off. */
  iconOffSites: string[];
  /** Open the in-page menu when a login field gets focus. Off: only the icon or Alt+Shift+L open it. */
  menuOnFocus: boolean;
  /** Offer to save new logins and changed passwords after a form is submitted. */
  savePrompt: boolean;
  /** Hostnames where Litewarden never offers to save. */
  neverSaveSites: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  lockMinutes: 15,
  lockOnClose: true,
  pinSurvivesRestart: false,
  copyTotpAfterFill: true,
  clipboardSeconds: 30,
  theme: 'system',
  askFrames: true,
  defaultUsername: '',
  gen: DEFAULT_GEN,
  popupSize: 'standard',
  density: 'roomy',
  liveSync: true,
  syncMinutes: 30,
  fieldIcon: true,
  iconOffSites: [],
  menuOnFocus: false,
  savePrompt: true,
  neverSaveSites: [],
};

/** Popup sizes in CSS px (Chrome caps popups at 800 x 600). */
export const POPUP_SIZES: Record<Settings['popupSize'], { w: number; h: number; label: string }> = {
  standard: { w: 380, h: 600, label: 'Standard' },
  wide: { w: 480, h: 600, label: 'Wide' },
  compact: { w: 340, h: 520, label: 'Compact' },
};

/** The decrypted list entry the popup shows: list stage plus the favicon domain and display hosts. */
export interface IndexItem extends ListItem {
  /** Hostname to ask the user's server for an icon (/icons/<domain>/icon.png), or null. */
  domain: string | null;
  /** Hostnames of the item's URIs, for display and search. */
  hosts: string[];
}

export interface Session {
  /** base64 raw user key (64 bytes) */
  userKey: string;
  /** org id -> base64 raw org key */
  orgKeys: Record<string, string>;
  unlockedAt: number;
  /** When auto-lock is due (ms since epoch), or null for never. */
  lockAt: number | null;
}

export interface TabMatch {
  url: string;
  /** Item ids that match this tab's URL, best first. */
  ids: string[];
  /** The matching items themselves (first 20), so the popup can paint without reading the whole index. */
  items: IndexItem[];
}

export interface Lockout {
  pwFails: number;
  /** Master password tries are blocked until this time (ms). */
  pwUntil: number;
  pinFails: number;
}

/** chrome.storage.local shape */
export interface LocalStore {
  account?: Account;
  tokens?: Tokens | null;
  vault?: SyncResponse;
  lastSync?: number;
  lastSyncError?: string | null;
  settings?: Partial<Settings>;
  /** Most recently used item ids, newest first. */
  recent?: string[];
  /** This browser's device id for the server. Kept across log out, so "remember this browser" keeps working. */
  deviceId?: string;
  /** Remember-device token for two-step login, per email. */
  twoFactorRemember?: Record<string, string>;
  /** PIN-wrapped user key when pinSurvivesRestart is on. */
  pinWrapped?: string | null;
  /** Unlocked session mirrored to disk only when lockOnClose is off. */
  persistedSession?: Sealed | Session | null;
  /** KDF warning dismissed for exactly these settings (see kdfSignature). A change in settings brings it back. */
  kdfDismissed?: string | null;
  /** Where the pop-out window was last (restored on the next pop-out). */
  popoutBounds?: { left: number; top: number; width: number; height: number } | null;
  /** "Teach this site" rules, by hostname. Stay on this device. */
  siteRules?: Record<string, SiteRule>;
}

/** One Litewarden surface drawn on a page (menu, save prompt, teach panel), known by a random token. */
export interface Surface {
  kind: 'menu' | 'prompt' | 'teach';
  tabId: number;
  /** Frame that holds the field (and our iframe). */
  frameId: number;
  /** URL of that frame. */
  url: string;
  created: number;
  /** Teach panel: the steps so far, as the content script reports them. */
  teach?: TeachState;
}

export interface TeachState {
  step: 1 | 2 | 3 | 4;
  username: string | null;
  password: string | null;
  totp: string | null;
}

/** A submitted login waiting for the user's answer in the save prompt. Memory only. */
export interface PendingSave {
  tabId: number;
  url: string;
  username: string;
  password: string;
  /** Old password from a change-password form. */
  current: string | null;
  kind: 'save' | 'update' | 'locked';
  /** Existing login to update. */
  itemId: string | null;
  created: number;
  /** After Save: what Undo restores. */
  undo?: { id: string; oldPassword: string | null } | null;
  state: 'ask' | 'saved' | 'never';
}

/** State of the live connection to the notifications hub, shown in Settings > Sync. */
export interface LiveState {
  status: 'off' | 'connecting' | 'connected' | 'unavailable' | 'error';
  /** When the last push arrived (ms), if any. */
  lastPush: number | null;
  detail: string | null;
}

/** chrome.storage.session shape */
export interface SessionStore {
  session?: Session | null;
  index?: IndexItem[];
  /** How many items the index holds (the popup paints before it reads the index). */
  indexCount?: number;
  /** The most recently used items (small; read on popup open). */
  recentItems?: IndexItem[];
  /** item id -> decrypted notes, for search. Written after the index, never to disk. */
  notes?: Record<string, string>;
  tabMatches?: Record<string, TabMatch>;
  /** domain -> data: URL, or '' when the server has no icon for it. */
  iconCache?: Record<string, string>;
  /** PIN-wrapped user key (default: lives until the browser closes). */
  pinWrapped?: string | null;
  lockout?: Lockout;
  /** SHA-256 (hex) of the last secret Litewarden put on the clipboard, so the timed clear skips a newer copy. */
  clipHash?: string;
  /** Decrypt failures from the last unlock/sync, shown to the user. */
  failures?: Array<{ id: string; message: string }>;
  live?: LiveState;
  /** Window id of the open pop-out, so a second click focuses it instead of opening another. */
  popoutId?: number | null;
  /** In-page surfaces by token. */
  surfaces?: Record<string, Surface>;
  /** Save prompts waiting for an answer, by token. */
  pendingSaves?: Record<string, PendingSave>;
  /** Two-step logins: the username typed on page 1, by tab, for the password page. */
  stepUser?: Record<string, { host: string; username: string; at: number }>;
}

export const local = {
  get: <K extends keyof LocalStore>(...keys: K[]) => chrome.storage.local.get(keys) as Promise<Pick<LocalStore, K>>,
  set: (v: Partial<LocalStore>) => chrome.storage.local.set(v),
  remove: (...keys: Array<keyof LocalStore>) => chrome.storage.local.remove(keys),
};

export const mem = {
  get: <K extends keyof SessionStore>(...keys: K[]) => chrome.storage.session.get(keys) as Promise<Pick<SessionStore, K>>,
  set: (v: Partial<SessionStore>) => chrome.storage.session.set(v),
  remove: (...keys: Array<keyof SessionStore>) => chrome.storage.session.remove(keys),
};

export const withDefaults = (s?: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...s, gen: { ...DEFAULT_GEN, ...s?.gen } });

export async function getSettings(): Promise<Settings> {
  const { settings } = await local.get('settings');
  return withDefaults(settings);
}

/**
 * Keep content scripts out of our storage. session already defaults to trusted contexts only; local defaults to
 * "everyone", so set it. Runs at the top of every service-worker start (the setting doesn't survive a restart).
 * The code never opens an area back up to content scripts (tests/unit/store-access.test.ts checks).
 */
export async function fenceStorage(): Promise<void> {
  for (const a of [chrome.storage.local, chrome.storage.session, chrome.storage.sync]) {
    await a?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  }
}
