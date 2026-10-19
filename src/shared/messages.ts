// SPDX-License-Identifier: GPL-3.0-only
// Typed messages between extension pages (popup, offscreen) and the service worker.
import type { ServerInfo } from '../core';
import type { Settings } from './store';

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
  clipboardCopied: [{ seconds?: number }, void];
  fill: [{ tabId: number; id: string; force?: boolean; allowFrame?: boolean }, FillResult];
  matchTab: [{ tabId: number; url: string }, { ids: string[]; items: import('./store').IndexItem[] }];
  setPin: [{ pin: string | null }, void];
  setSettings: [Partial<Settings>, Settings];
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
