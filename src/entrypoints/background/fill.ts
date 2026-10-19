// SPDX-License-Identifier: GPL-3.0-only
// Fill orchestration. Only ever runs because the user asked (popup click, Enter, shortcut): the content script
// is injected on demand, probes every frame, and fills the best one. Never on page load.
import { matchesPage } from '../../core';
import type { FillResult } from '../../shared/messages';
import { fullItem, recordUse } from './session';

interface Probe {
  /** 2 = has a password field, 1 = username-only (two-step login), 0 = nothing to fill */
  score: number;
  origin: string;
  top: boolean;
}

declare global {
  interface Window {
    __lwProbe?: () => Probe;
    __lwFill?: (username: string | null, password: string | null) => Array<'username' | 'password'>;
  }
}

const FILL_SCRIPT = '/content-scripts/fill.js';

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
  const probes = await chrome.scripting.executeScript({ target, func: () => window.__lwProbe?.() ?? null });
  const pageOrigin = new URL(url).origin;
  const cands = probes
    .map((r) => ({ frameId: r.frameId, p: r.result as Probe | null }))
    .filter((c): c is { frameId: number; p: Probe } => !!c.p && c.p.score > 0)
    // best form first; on a tie the top frame, then same-origin frames, then the rest
    .sort((a, b) => b.p.score - a.p.score || Number(b.p.top) - Number(a.p.top) || Number(b.p.origin === pageOrigin) - Number(a.p.origin === pageOrigin));
  const best = cands[0];
  if (!best) return { outcome: 'no-fields' };
  if (best.p.origin !== pageOrigin && !allowFrame) return { outcome: 'confirm-frame', frameOrigin: best.p.origin };

  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [best.frameId] },
    func: (u: string | null, p: string | null) => window.__lwFill?.(u, p) ?? [],
    args: [item.login.username, item.login.password],
  });
  const filled = (res?.result as Array<'username' | 'password'> | undefined) ?? [];
  if (filled.length) await recordUse(id);
  return filled.length ? { outcome: 'filled', filled } : { outcome: 'no-fields' };
}
