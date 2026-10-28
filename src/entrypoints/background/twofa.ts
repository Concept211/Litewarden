// SPDX-License-Identifier: GPL-3.0-only
// 2FA setup pages. The content script reports that its page looks like one (the words, plus an otpauth:// link, a
// typed key or a square image). Here the worker settles what the key is: a link wins, then a QR code read from a
// screenshot of the visible tab (taken only for such a page, read here, never stored or sent), then the typed key.
// Then the card on the page, or the popup, offers to add it to the site's login and types the current code into
// the page's code field, so the setup finishes right there.
import jsQR from 'jsqr';
import { matchesPage, totp } from '../../core';
import type { Api, CsApi, TotpData } from '../../shared/messages';
import { findCode, pixels, read } from '../../shared/qr';
import { getSettings, local, mem, type PendingTotp, type Surface } from '../../shared/store';
import { keyOf, otpLabel } from '../../shared/twofa';
import { draftFrom, editSurfaces, hostOf, openPopup, patchSettings, serial, siteName, toCs, token, dropSurface } from './inpage';
import * as S from './session';

const MAX_AGE = 10 * 60_000;

async function pendings() {
  const { pendingTotps } = await mem.get('pendingTotps');
  const now = Date.now();
  const live: Record<string, PendingTotp> = {};
  for (const [k, v] of Object.entries(pendingTotps ?? {})) if (now - v.created < MAX_AGE) live[k] = v;
  return live;
}

async function setPending(t: string, p: PendingTotp | null) {
  await serial(async () => {
    const all = await pendings();
    if (p) all[t] = p;
    else delete all[t];
    await mem.set({ pendingTotps: all });
  });
}

/** The site's logins: those saved for this exact host first (a domain's other sites match too), then the most
 * recently used. */
async function siteLogins(url: string) {
  const [{ index }, { recent }] = await Promise.all([mem.get('index'), local.get('recent')]);
  const rank = new Map((recent ?? []).map((id, i) => [id, i]));
  const host = hostOf(url);
  const exact = (it: { hosts: string[] }) => (it.hosts.includes(host) ? 0 : 1);
  return (index ?? [])
    .filter((it) => it.type === 1 && it.uris.length && matchesPage(it.uris, url))
    .sort((a, b) => exact(a) - exact(b) || (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name))
    .slice(0, 20);
}

/** What to offer for this key on this page. Null: nothing (it's already saved on one of the site's logins). */
async function decide(url: string, secret: string): Promise<Pick<PendingTotp, 'kind' | 'itemId'> | null> {
  if (!(await mem.get('session')).session) return { kind: 'locked', itemId: null };
  const logins = await siteLogins(url);
  if (!logins.length) return { kind: 'new', itemId: null };
  const key = keyOf(secret);
  for (const it of logins.filter((i) => i.hasTotp)) {
    const full = await S.fullItem(it.id).catch(() => null);
    if (full?.login?.totp && keyOf(full.login.totp) === key) return null;
  }
  // A login without 2FA yet is the one being set up (this host's first); if all have one, the best match
  // (replacing, after asking).
  const host = hostOf(url);
  const best = logins.find((i) => !i.hasTotp && i.hosts.includes(host)) ?? logins.find((i) => !i.hasTotp) ?? logins[0]!;
  return { kind: 'add', itemId: best.id };
}

// ---------- reading the QR code ----------

/** Screenshots per tab: the browser allows two a second, and one per page change is plenty. */
const shots = new Map<number, { url: string; at: number; n: number }>();

async function readQr(tabId: number, url: string, seen: CsApi['cs:twofa'][0]): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active || tab.url !== url) return null;
  const last = shots.get(tabId);
  if (last && last.url === url && (Date.now() - last.at < 1500 || last.n >= 8)) return null;
  shots.set(tabId, { url, at: Date.now(), n: last?.url === url ? last.n + 1 : 1 });
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    return null;
  }
  const px = await pixels(shot);
  const k = seen.vw ? px.width / seen.vw : 1;
  const boxes = seen.boxes.slice(0, 24).map((b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }));
  const r = read(findCode(jsQR, px, boxes, k));
  return r.ok ? r.uri : null;
}

// ---------- the page reports a setup ----------

async function detected(seen: CsApi['cs:twofa'][0], sender: chrome.runtime.MessageSender): Promise<{ token: string } | null> {
  if (sender.frameId !== 0) return null;
  const tabId = sender.tab!.id!;
  const url = sender.url!;
  const host = hostOf(url);
  const settings = await getSettings();
  if (!settings.totpPrompt || settings.neverTotpSites.includes(host)) return null;
  const linked = seen.uri && read(seen.uri).ok ? seen.uri : null;
  const all = await pendings();
  const mine = Object.entries(all).filter(([, p]) => p.tabId === tabId);
  // Already offered for this key: show the same card again (a page change), or nothing once answered.
  const known = (key: string) => mine.find(([, p]) => keyOf(p.secret) === key);
  const quick = linked ?? seen.key;
  if (quick && known(keyOf(quick))) {
    const [t, p] = known(keyOf(quick))!;
    return p.state === 'ask' ? { token: t } : null;
  }
  const secret = linked ?? (seen.boxes.length ? await readQr(tabId, url, seen) : null) ?? seen.key;
  if (!secret) return null;
  const key = keyOf(secret);
  if (key.length < 16) return null;
  const again = known(key);
  if (again) return again[1].state === 'ask' ? { token: again[0] } : null;
  const d = await decide(url, secret);
  if (!d) return null;
  // A new key on the tab (the site made another one): the old offer goes.
  for (const [k] of mine) await setPending(k, null);
  const t = token();
  await setPending(t, { tabId, url, secret, ...d, created: Date.now(), state: 'ask' });
  return { token: t };
}

/** The content script opens the card for a token it was given. */
export async function openTotpSurface(given: string | undefined, s: Surface): Promise<{ token: string }> {
  const p = given ? (await pendings())[given] : null;
  if (!p || p.tabId !== s.tabId) throw new S.UserError('No 2FA key waiting.');
  await editSurfaces((all) => void (all[given!] = s));
  return { token: given! };
}

// ---------- the card and the popup ----------

async function data(p: PendingTotp, error?: string): Promise<TotpData> {
  const [settings, { account }] = await Promise.all([getSettings(), local.get('account')]);
  const locked = !(await mem.get('session')).session;
  const targets = locked ? [] : (await siteLogins(p.url)).map((it) => ({ id: it.id, name: it.name, username: it.username, hasTotp: it.hasTotp }));
  const { issuer, account: who } = otpLabel(p.secret);
  const code = p.state === 'added' && !p.filled ? await totp(p.secret).catch(() => null) : null;
  return { kind: p.kind, state: p.state, site: siteName(hostOf(p.url)), targets, itemId: p.itemId, issuer, account: who, code, filled: !!p.filled, theme: settings.theme, server: account?.server ?? null, ...(error ? { error } : {}) };
}

/** The card's own tab, or the popup (which has no tab, or its own pop-out window). */
function allowed(p: PendingTotp, sender: chrome.runtime.MessageSender) {
  const fromPopup = /\/popup\.html/.test(sender.url ?? '');
  return fromPopup || sender.tab?.id == null || sender.tab.id === p.tabId;
}

async function closeCard(t: string, tabId: number) {
  await toCs({ tabId, frameId: 0 }, { lw: 'close', token: t });
  await dropSurface(t);
}

/** Type the current code into the page's code field. */
async function typeCode(tabId: number, secret: string): Promise<boolean> {
  const code = await totp(secret).catch(() => null);
  if (!code) return false;
  const r = (await chrome.tabs.sendMessage(tabId, { lw: 'otp-code', code }, { frameId: 0 }).catch(() => null)) as { filled?: boolean } | null;
  return !!r?.filled;
}

async function act(a: Api['totpAct'][0], sender: chrome.runtime.MessageSender): Promise<TotpData> {
  const p = (await pendings())[a.token];
  if (!p || !allowed(p, sender)) throw new S.UserError('This 2FA offer has expired. Reload the page to see it again.');
  const host = hostOf(p.url);
  try {
    if (a.act === 'notnow') {
      // After Add or Never the card just goes; before, the popup can still offer the key while the page is open.
      const q = p.state === 'ask' ? { ...p, state: 'dismissed' as const } : p;
      await setPending(a.token, q);
      await closeCard(a.token, p.tabId);
      return data(q);
    }
    if (a.act === 'unlock') {
      await openPopup();
      return data(p);
    }
    if (a.act === 'never') {
      await patchSettings({ neverTotpSites: [...(await getSettings()).neverTotpSites.filter((h) => h !== host), host] });
      const q = { ...p, state: 'never' as const };
      await setPending(a.token, q);
      return data(q);
    }
    if (a.act === 'undo') {
      if (p.state === 'never') await patchSettings({ neverTotpSites: (await getSettings()).neverTotpSites.filter((h) => h !== host) });
      if (p.state === 'added' && p.undo) {
        if (p.undo.created) await S.trashItem(p.undo.id);
        else {
          const d = draftFrom(await S.fullItem(p.undo.id));
          d.login!.totp = p.undo.old;
          if (p.undo.notes !== undefined) d.notes = p.undo.notes;
          await S.saveItem(p.undo.id, d);
        }
      }
      const q = { ...p, state: 'ask' as const, undo: null, filled: false };
      await setPending(a.token, q);
      return data(q);
    }
    // add
    if (p.state === 'added') return data(p);
    if (!(await mem.get('session')).session) return data(p, 'Litewarden is locked. Unlock it first.');
    const targetId = a.itemId !== undefined ? a.itemId : p.itemId;
    let undo: PendingTotp['undo'];
    if (targetId) {
      const it = await S.fullItem(targetId);
      if (!it.login) throw new S.UserError('That item is not a login.');
      const d = draftFrom(it);
      const old = d.login!.totp ?? null;
      const notes = d.notes;
      d.login!.totp = p.secret;
      // A replaced key is kept in the notes: if the page wasn't the site's real setup (or the setup is abandoned), the
      // old key is the one that still works, and losing it could lock the user out.
      if (old && keyOf(old) !== keyOf(p.secret)) d.notes = `${notes ? `${notes}

` : ''}Previous 2FA key, replaced ${new Date().toISOString().slice(0, 10)} on ${host}: ${old}`;
      await S.saveItem(targetId, d);
      undo = { id: targetId, old, notes, created: false };
    } else {
      const { issuer, account } = otpLabel(p.secret);
      const username = (a.username ?? account ?? '').trim() || null;
      const name = siteName(host);
      const { id } = await S.saveItem(null, { type: 1, name, notes: issuer && !name.toLowerCase().includes(issuer.toLowerCase()) ? `2FA for ${issuer}` : null, folderId: null, login: { username, password: null, totp: p.secret, uris: [{ uri: new URL(p.url).origin, match: null }] } });
      undo = { id, old: null, created: true };
    }
    const filled = await typeCode(p.tabId, p.secret);
    const q: PendingTotp = { ...p, itemId: undo.id, state: 'added', filled, undo };
    await setPending(a.token, q);
    return data(q);
  } catch (err) {
    return data(p, (err as Error).message);
  }
}

/** After an unlock, cards that said "Unlock" get their real offer. */
export async function onUnlockedTotp() {
  for (const [t, p] of Object.entries(await pendings())) {
    if (p.kind !== 'locked') continue;
    const d = await decide(p.url, p.secret);
    if (!d) {
      await setPending(t, null);
      await closeCard(t, p.tabId);
      continue;
    }
    await setPending(t, { ...p, ...d });
  }
}

/** A tab closed or went to another site: its offers go. */
export async function forgetTotpTab(tabId: number, url?: string) {
  shots.delete(tabId);
  await serial(async () => {
    const all = await pendings();
    for (const [k, p] of Object.entries(all)) if (p.tabId === tabId && (!url || hostOf(p.url) !== hostOf(url))) delete all[k];
    await mem.set({ pendingTotps: all });
  });
}

export const totpHandlers = {
  totpData: async ({ token: t }: Api['totpData'][0], sender: chrome.runtime.MessageSender): Promise<TotpData> => {
    const p = (await pendings())[t];
    if (!p || !allowed(p, sender)) throw new S.UserError('This 2FA offer has expired. Reload the page to see it again.');
    return data(p);
  },
  totpAct: (a: Api['totpAct'][0], sender: chrome.runtime.MessageSender) => act(a, sender),
  totpForTab: async ({ tabId }: Api['totpForTab'][0]): Promise<Api['totpForTab'][1]> => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const mine = Object.entries(await pendings())
      .filter(([, p]) => p.tabId === tabId && (p.state === 'ask' || p.state === 'dismissed') && (!tab?.url || hostOf(tab.url) === hostOf(p.url)))
      .sort((a, b) => b[1].created - a[1].created)[0];
    if (!mine) return null;
    const [t, p] = mine;
    // The vault may have changed since (added another way, synced).
    if (p.kind !== 'locked' || (await mem.get('session')).session) {
      const d = await decide(p.url, p.secret);
      if (!d) {
        await setPending(t, null);
        return null;
      }
      if (d.kind !== p.kind || (p.kind === 'locked' && d.itemId !== p.itemId)) await setPending(t, { ...p, ...d });
      return { token: t, ...(await data({ ...p, ...d })) };
    }
    return { token: t, ...(await data(p)) };
  },
};

export const twofaCs = (seen: CsApi['cs:twofa'][0], sender: chrome.runtime.MessageSender) => detected(seen, sender);
