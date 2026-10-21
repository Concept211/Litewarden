// SPDX-License-Identifier: GPL-3.0-only
// Typed messages between extension pages (popup, offscreen) and the service worker.
import type { Draft, FullItem, ServerInfo } from '../core';
import type { Captured } from './fields';
import type { SiteRule } from './rules';
import type { IndexItem, PendingSave, Settings, TeachState } from './store';

export type Status = 'new' | 'locked' | 'unlocked';

export interface StateInfo {
  status: Status;
  email: string | null;
  server: string | null;
  serverName: string | null;
  serverVersion: string | null;
  pinEnabled: boolean;
  /** Master password blocked until (ms), or 0. */
  pwUntil: number;
  pwFails: number;
  settings: Settings;
}

export interface FillResult {
  /** 'filled' | needs a decision from the user | nothing to fill */
  outcome: 'filled' | 'confirm-site' | 'confirm-frame' | 'no-fields' | 'blocked-page';
  filled?: Array<'username' | 'password'>;
  /** Origin of the frame that holds the form, when it isn't the page's own origin. */
  frameOrigin?: string;
}

/** Request type -> [payload, response] */
export interface Api {
  getState: [void, StateInfo];
  checkServer: [{ url: string }, ServerInfo & { url: string }];
  login: [
    { server: string; email: string; password: string; twoFactor?: { provider: number; token: string; remember: boolean } },
    { status: 'ok' } | { status: 'twofactor'; providers: number[] },
  ];
  unlockPassword: [{ password: string }, { status: 'ok' }];
  unlockPin: [{ pin: string }, { status: 'ok' }];
  lock: [void, void];
  logout: [void, void];
  sync: [void, { count: number; changed: number }];
  /** Re-arm the auto-lock timer (popup open, any action). */
  touch: [void, void];
  getSecret: [{ id: string; field: 'username' | 'password' | 'totp' }, { value: string | null }];
  getTotpSecrets: [{ ids: string[] }, Record<string, string>];
  clipboardCopied: [{ seconds?: number; hash?: string }, void];
  fill: [{ tabId: number; id: string; force?: boolean; allowFrame?: boolean }, FillResult];
  matchTab: [{ tabId: number; url: string }, { ids: string[]; items: import('./store').IndexItem[] }];
  setPin: [{ pin: string | null }, void];
  setSettings: [Partial<Settings>, Settings];
  getItem: [{ id: string }, ItemDetail];
  folders: [void, Folder[]];
  saveItem: [{ id: string | null; draft: Draft }, { id: string }];
  trashItem: [{ id: string }, void];
  popout: [{ tabId?: number }, { windowId: number }];
  liveState: [void, import('./store').LiveState];
  // ----- in-page surfaces (menu, save prompt, teach panel): extension pages framed into a site -----
  menuData: [{ token: string }, MenuData];
  menuFill: [{ token: string; id: string; force?: boolean }, FillResult];
  /** Menu / prompt / panel tells its content script something (natural size, close, start teaching, hide here). */
  surfaceAct: [{ token: string; act: 'size' | 'close' | 'teach' | 'hide'; w?: number; h?: number }, void];
  promptData: [{ token: string }, PromptData];
  promptAct: [{ token: string; act: 'save' | 'notnow' | 'never' | 'undo' | 'unlock'; username?: string; password?: string; folderId?: string | null }, PromptData];
  teachData: [{ token: string }, { site: string; state: TeachState }];
  teachAct: [{ token: string; act: 'back' | 'save' | 'cancel' | 'undo' | 'done' }, void];
  /** From the popup: start "teach this site" on the page. */
  startTeach: [{ tabId: number }, { ok: boolean }];
  openPopup: [void, void];
  siteRules: [void, Record<string, SiteRule>];
  removeRule: [{ host: string }, void];
}

export interface MenuData {
  status: Status;
  site: string;
  items: IndexItem[];
  /** id -> TOTP secret, for the live codes. */
  totp: Record<string, string>;
  server: string | null;
  theme: Settings['theme'];
}

export interface PromptData {
  kind: PendingSave['kind'];
  state: PendingSave['state'];
  site: string;
  username: string;
  password: string;
  /** Update: the login being changed. */
  itemName: string | null;
  folders: Folder[];
  theme: Settings['theme'];
  /** Set when the last action failed. */
  error?: string;
}

/** Content script -> worker. Kept tiny: the page only ever learns what it shows. */
export interface CsApi {
  'cs:hello': [{ top: boolean }, CsHello];
  /** A new surface. Prompts pass the pending-save token they were given, so the prompt frame finds its data. */
  'cs:open': [{ kind: 'menu' | 'prompt' | 'teach'; token?: string }, { token: string }];
  'cs:submitted': [Captured, { token: string } | null];
  'cs:userStep': [{ username: string }, void];
  'cs:teachState': [{ token: string; state: TeachState }, void];
  'cs:saveRule': [{ rule: SiteRule }, void];
  'cs:removeRule': [void, void];
  'cs:closed': [{ token: string }, void];
}

export interface CsHello {
  icon: boolean;
  menuOnFocus: boolean;
  locked: boolean;
  rule: SiteRule | null;
  /** A save prompt waiting for this tab (after the page changed). */
  prompt: string | null;
  theme: Settings['theme'];
}

/** Worker -> content script (chrome.tabs.sendMessage). */
export type ToCs =
  | { lw: 'size'; token: string; w?: number; h: number }
  | { lw: 'close'; token: string }
  /** Alt+Shift+L opens on the focused field; `ctx` (the right-click item) on the field that was right-clicked. */
  | { lw: 'open-menu'; ctx?: boolean }
  | { lw: 'teach' }
  | { lw: 'teach-act'; token: string; act: 'back' | 'save' | 'cancel' | 'undo' | 'done' }
  | { lw: 'refresh' }
  | { lw: 'prompt'; token: string };

export interface Folder {
  id: string;
  name: string;
}

/** The full item plus what the item view shows around it. */
export interface ItemDetail {
  item: FullItem;
  folderName: string | null;
  revisionDate: string | null;
  creationDate: string | null;
  /** False for organization items the user can only view. */
  canEdit: boolean;
  /** Item is in an organization (shown as a note in the editor). */
  orgName: string | null;
  passwordHistoryCount: number;
}

export type Req = { [K in keyof Api]: { type: K; data: Api[K][0] } }[keyof Api];
export type Res<K extends keyof Api> = { ok: true; data: Api[K][1] } | { ok: false; error: { name: string; message: string; data?: unknown } };

/** Error re-thrown in the caller with the worker's error name, so the UI can branch on it. */
export class RemoteError extends Error {
  constructor(
    override name: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export async function send<K extends keyof Api>(type: K, ...[data]: Api[K][0] extends void ? [] : [Api[K][0]]): Promise<Api[K][1]> {
  const res = (await chrome.runtime.sendMessage({ type, data })) as Res<K> | undefined;
  if (!res) throw new RemoteError('NoResponse', 'Litewarden did not answer. Close and reopen the popup.');
  if (!res.ok) throw new RemoteError(res.error.name, res.error.message, res.error.data);
  return res.data;
}

/** Progress events on the 'progress' port during sign-in and sync. */
export interface Progress {
  phase: 'sync' | 'decrypt' | 'done';
  done: number;
  total: number;
}
