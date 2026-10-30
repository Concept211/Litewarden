// SPDX-License-Identifier: GPL-3.0-only
// Fill orchestration. Only ever runs because the user asked (popup click, Enter, in-page menu, shortcut): the
// fill script is injected on demand, probes the frames, and fills the best one. Never on page load. A
// "teach this site" rule for the frame's host wins over field detection.
import { matchesPage, totp } from '../../core';
import type { FillResult } from '../../shared/messages';
import type { CardData, IdentityData } from '../../shared/forms';
import type { SiteRule } from '../../shared/rules';
import { getSettings, local } from '../../shared/store';
import { fullItem, needsReprompt, recordUse } from './session';

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
    __lwProbeForm?: (kind: 'card' | 'identity') => { count: number; number: boolean; origin: string; top: boolean };
    __lwFillCard?: (c: CardData) => string[];
    __lwFillIdentity?: (d: IdentityData) => string[];
  }
}

const FILL_SCRIPT = '/content-scripts/fill.js';

const rules = async (): Promise<Rules> => (await local.get('siteRules')).siteRules ?? {};

async function code(secret: string | null | undefined, rs: Rules, host: string): Promise<string | null> {
  return secret && rs[host]?.totp ? totp(secret).catch(() => null) : null;
}

/** `allowFrame`: fill a login form from another origin inside the page without asking; 'matching' only when that
 * frame belongs to the login's own site. */
export async function fill(tabId: number, id: string, force = false, allowFrame: boolean | 'matching' = false): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  if (!/^https?:\/\//i.test(url)) return { outcome: 'blocked-page' };
  if (await needsReprompt(id)) return { outcome: 'reprompt' };
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
  const frameOk = allowFrame === true || (allowFrame === 'matching' && matchesPage(item.login.uris, best.p.origin));
  if (best.p.origin !== pageOrigin && !frameOk) return { outcome: 'confirm-frame', frameOrigin: best.p.origin };
  return run(tabId, best.frameId, new URL(best.p.origin).hostname, id, item.login, rs);
}

/** Fill into one known frame: the in-page menu's frame, where the user clicked the field icon. */
export async function fillFrame(tabId: number, frameId: number, frameUrl: string, id: string, force = false): Promise<FillResult> {
  if (await needsReprompt(id)) return { outcome: 'reprompt' };
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

/**
 * Fill a whole card or address: every frame of the tab that has a part of the form, since payment companies (Stripe,
 * Braintree, Adyen) put each card box in a frame of their own. Frames from another origin than the shop's page get
 * nothing until the user agreed to those origins for this shop (`allowed`); the answer names them so the menu can
 * ask. `force`: the user just said yes, so the origins found are filled (the caller remembers them).
 */
export async function fillForm(tabId: number, id: string, allowed: string[], force: boolean): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? '';
  if (!/^https?:\/\//i.test(url)) return { outcome: 'blocked-page' };
  if (await needsReprompt(id)) return { outcome: 'reprompt' };
  const item = await fullItem(id);
  const kind = item.type === 3 && item.card ? 'card' : item.type === 4 && item.identity ? 'identity' : null;
  if (!kind) return { outcome: 'no-fields' };
  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: [FILL_SCRIPT] });
  } catch {
    return { outcome: 'blocked-page' };
  }
  const probes = await chrome.scripting.executeScript({ target, func: (k: 'card' | 'identity') => window.__lwProbeForm?.(k) ?? null, args: [kind] });
  const pageOrigin = new URL(url).origin;
  const cands = probes
    .map((r) => ({ frameId: r.frameId, p: r.result as { count: number; number: boolean; origin: string } | null }))
    .filter((c): c is { frameId: number; p: { count: number; number: boolean; origin: string } } => !!c.p && c.p.count > 0);
  // A card goes nowhere without a number box somewhere on the page (an "Expiry" alone is not a card form).
  if (!cands.length || (kind === 'card' && !cands.some((c) => c.p.number))) return { outcome: 'no-fields' };
  const foreign = [...new Set(cands.map((c) => c.p.origin).filter((o) => o !== pageOrigin))];
  const unasked = foreign.filter((o) => !allowed.includes(o));
  if (unasked.length && !force) return { outcome: 'confirm-frame', frameOrigins: foreign };

  const c = item.card ?? {};
  const i = item.identity ?? {};
  const settings = await getSettings();
  const card: CardData = { cardholderName: c.cardholderName ?? null, number: c.number ?? null, expMonth: c.expMonth ?? null, expYear: c.expYear ?? null, code: settings.fillCardCode ? (c.code ?? null) : null, brand: c.brand ?? null };
  const keys = ['title', 'firstName', 'middleName', 'lastName', 'company', 'address1', 'address2', 'address3', 'city', 'state', 'postalCode', 'country', 'email', 'phone'] as const;
  const ident = Object.fromEntries(keys.map((k) => [k, i[k] ?? null])) as unknown as IdentityData;
  const filled: string[] = [];
  for (const cand of cands) {
    const [res] = await chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [cand.frameId] },
        func: (k: 'card' | 'identity', cd: CardData, idd: IdentityData) => (k === 'card' ? window.__lwFillCard?.(cd) : window.__lwFillIdentity?.(idd)) ?? [],
        args: [kind, card, ident],
      })
      .catch(() => [] as chrome.scripting.InjectionResult<unknown>[]);
    filled.push(...((res?.result as string[] | undefined) ?? []));
  }
  if (filled.length) await recordUse(id);
  return filled.length ? { outcome: 'filled', filled, ...(foreign.length ? { frameOrigins: foreign } : {}) } : { outcome: 'no-fields' };
}
