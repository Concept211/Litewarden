// SPDX-License-Identifier: GPL-3.0-only
// Fill orchestration. Only ever runs because the user asked (popup click, Enter, in-page menu, shortcut): the
// fill script is injected on demand, probes the frames, and fills the best one. Never on page load. A
// "teach this site" rule for the frame's host wins over field detection.
import { matchesPage, totp } from '../../core';
import type { FillResult } from '../../shared/messages';
import type { SiteRule } from '../../shared/rules';
import { local } from '../../shared/store';
import { fullItem, recordUse } from './session';

interface Probe {
  /** 2 = has a password field, 1 = username-only (two-step login), 0 = nothing to fill */
  score: number;
  origin: string;
  top: boolean;
}

type Rules = Record<string, SiteRule>;

declare global {
  interface Window {
    __lwProbe?: (rules: Rules | null) => Probe;
    __lwFill?: (username: string | null, password: string | null, rules: Rules | null, code: string | null) => Array<'username' | 'password' | 'totp'>;
  }
}

const FILL_SCRIPT = '/content-scripts/fill.js';

const rules = async (): Promise<Rules> => (await local.get('siteRules')).siteRules ?? {};

async function code(secret: string | null | undefined, rs: Rules, host: string): Promise<string | null> {
  return secret && rs[host]?.totp ? totp(secret).catch(() => null) : null;
}

export async function fill(tabId: number, id: string, force = false, allowFrame = false): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  if (!/^https?:\/\//i.test(url)) return { outcome: 'blocked-page' };
  const item = await fullItem(id);
  if (!item.login) return { outcome: 'no-fields' };
  if (!force && !matchesPage(item.login.uris, url)) return { outcome: 'confirm-site' };

  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: [FILL_SCRIPT] });
  } catch {
    return { outcome: 'blocked-page' };
  }
  const rs = await rules();
  const probes = await chrome.scripting.executeScript({ target, func: (r: Rules) => window.__lwProbe?.(r) ?? null, args: [rs] });
  const pageOrigin = new URL(url).origin;
  const cands = probes
    .map((r) => ({ frameId: r.frameId, p: r.result as Probe | null }))
    .filter((c): c is { frameId: number; p: Probe } => !!c.p && c.p.score > 0)
    // best form first; on a tie the top frame, then same-origin frames, then the rest
    .sort((a, b) => b.p.score - a.p.score || Number(b.p.top) - Number(a.p.top) || Number(b.p.origin === pageOrigin) - Number(a.p.origin === pageOrigin));
  const best = cands[0];
  if (!best) return { outcome: 'no-fields' };
  if (best.p.origin !== pageOrigin && !allowFrame) return { outcome: 'confirm-frame', frameOrigin: best.p.origin };
  return run(tabId, best.frameId, new URL(best.p.origin).hostname, id, item.login, rs);
}

/** Fill into one known frame: the in-page menu's frame, where the user clicked the field icon. */
export async function fillFrame(tabId: number, frameId: number, frameUrl: string, id: string, force = false): Promise<FillResult> {
  const item = await fullItem(id);
  if (!item.login) return { outcome: 'no-fields' };
  if (!force && !matchesPage(item.login.uris, frameUrl)) return { outcome: 'confirm-site' };
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: [FILL_SCRIPT] });
  } catch {
    return { outcome: 'blocked-page' };
  }
  return run(tabId, frameId, new URL(frameUrl).hostname, id, item.login, await rules());
}

async function run(tabId: number, frameId: number, host: string, id: string, login: { username: string | null; password: string | null; totp: string | null }, rs: Rules): Promise<FillResult> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (u: string | null, p: string | null, r: Rules, c: string | null) => window.__lwFill?.(u, p, r, c) ?? [],
    args: [login.username, login.password, rs, await code(login.totp, rs, host)],
  });
  const filled = ((res?.result as Array<'username' | 'password' | 'totp'> | undefined) ?? []).filter((f): f is 'username' | 'password' => f !== 'totp');
  if (filled.length) await recordUse(id);
  return filled.length ? { outcome: 'filled', filled } : { outcome: 'no-fields' };
}
