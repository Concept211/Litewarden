// SPDX-License-Identifier: GPL-3.0-only
// The worker side of everything Litewarden draws on a page: the in-page menu, the save / update prompt and the
// "teach this site" panel. The content script only positions frames and reports what the user submitted; the
// frames themselves are extension pages that ask the worker for data. Every surface has a random token tied to
// the tab and frame that asked for it, so another page can't drive it.
import type { Draft, FullItem } from '../../core';
import { matchesPage, totp } from '../../core';
import type { Captured } from '../../shared/fields';
import type { Api, CsApi, CsHello, MenuData, PromptData, ToCs } from '../../shared/messages';
import type { SiteRule } from '../../shared/rules';
import { getSettings, local, mem, type IndexItem, type PendingSave, type Settings, type Surface, type TeachState } from '../../shared/store';
import { copySecret } from './clipboard';
import { fillFrame } from './fill';
import * as S from './session';

const MAX_AGE = 10 * 60_000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const siteName = (host: string) => host.replace(/^www\./, '');

function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- surfaces ----------

/**
 * Runs read-change-write edits of the surface and prompt records one at a time. Messages arrive concurrently: a
 * menu's "closed" and the next menu's "open" each read the record before the other wrote it, and the later write
 * wiped the new menu's token (it then said it had expired and couldn't be closed).
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function editSurfaces(fn: (all: Record<string, Surface>) => void) {
  await serial(async () => {
    const all = await surfaces();
    fn(all);
    await mem.set({ surfaces: all });
  });
}

async function surfaces() {
  const { surfaces: all } = await mem.get('surfaces');
  const now = Date.now();
  const live: Record<string, Surface> = {};
  for (const [k, v] of Object.entries(all ?? {})) if (now - v.created < MAX_AGE * 6) live[k] = v;
  return live;
}

async function addSurface(s: Surface): Promise<string> {
  const t = token();
  await editSurfaces((all) => {
    // One of each kind per frame: opening a new menu replaces the old one.
    for (const [k, v] of Object.entries(all)) if (v.tabId === s.tabId && v.frameId === s.frameId && v.kind === s.kind) delete all[k];
    all[t] = s;
  });
  return t;
}

/** The surface behind a request from one of our framed pages, checked against the tab it runs in. */
async function surface(t: string, sender: chrome.runtime.MessageSender): Promise<Surface> {
  const s = (await surfaces())[t];
  if (!s || (sender.tab?.id != null && sender.tab.id !== s.tabId)) throw new S.UserError('This Litewarden window has expired. Close it and try again.');
  return s;
}

async function dropSurface(t: string) {
  await editSurfaces((all) => void delete all[t]);
}

export async function toCs(s: { tabId: number; frameId: number }, msg: ToCs) {
  await chrome.tabs.sendMessage(s.tabId, msg, { frameId: s.frameId }).catch(() => {});
}

// ---------- menu ----------

async function menuData(t: string, sender: chrome.runtime.MessageSender): Promise<MenuData> {
  const s = await surface(t, sender);
  const [st, { index }, { recent }, { account }, settings] = await Promise.all([S.state(), mem.get('index'), local.get('recent'), local.get('account'), getSettings()]);
  const base = { site: siteName(hostOf(s.url)), server: account?.server ?? null, theme: settings.theme, totp: {} };
  if (st.status !== 'unlocked' || !index) return { ...base, status: st.status, items: [] };
  const rank = new Map((recent ?? []).map((id, i) => [id, i]));
  const items = index
    .filter((it: IndexItem) => it.type === 1 && it.uris.length && matchesPage(it.uris, s.url))
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name))
    .slice(0, 30);
  const secrets: Record<string, string> = {};
  for (const it of items.filter((i) => i.hasTotp).slice(0, 12)) {
    const full = await S.fullItem(it.id).catch(() => null);
    if (full?.login?.totp) secrets[it.id] = full.login.totp;
  }
  return { ...base, status: 'unlocked', items, totp: secrets };
}

async function menuFill(t: string, id: string, force: boolean, sender: chrome.runtime.MessageSender) {
  const s = await surface(t, sender);
  const r = await fillFrame(s.tabId, s.frameId, s.url, id, force);
  if (r.outcome !== 'filled') return r;
  await toCs(s, { lw: 'close', token: t });
  await dropSurface(t);
  if ((await getSettings()).copyTotpAfterFill) {
    const it = await S.fullItem(id).catch(() => null);
    if (it?.login?.totp) await copySecret(await totp(it.login.totp)).catch(() => {});
  }
  return r;
}

// ---------- save / update prompt ----------

async function pendings() {
  const { pendingSaves } = await mem.get('pendingSaves');
  const now = Date.now();
  const live: Record<string, PendingSave> = {};
  for (const [k, v] of Object.entries(pendingSaves ?? {})) if (now - v.created < MAX_AGE) live[k] = v;
  return live;
}

async function setPending(t: string, p: PendingSave | null) {
  await serial(async () => {
    const all = await pendings();
    if (p) all[t] = p;
    else delete all[t];
    await mem.set({ pendingSaves: all });
  });
}

/** Should this submit get a prompt, and which kind? Null: nothing new to save. */
async function decide(url: string, c: Captured, settings: Settings): Promise<Pick<PendingSave, 'kind' | 'itemId'> | null> {
  const host = hostOf(url);
  if (!settings.savePrompt || settings.neverSaveSites.includes(host)) return null;
  if (!(await mem.get('session')).session) return { kind: 'locked', itemId: null };
  const { index } = await mem.get('index');
  const matches = (index ?? []).filter((it) => it.type === 1 && it.uris.length && matchesPage(it.uris, url));
  // Narrow by username with the index (no decryption), then decrypt only those candidates. No cap: a site can have
  // many saved logins, and checking only the first few by name made an existing login look new.
  const user = c.username.toLowerCase();
  const sameUserIds = user ? matches.filter((it) => (it.username ?? '').toLowerCase() === user).map((it) => it.id) : [];
  const decrypt = async (ids: string[]) => (await Promise.all(ids.map((id) => S.fullItem(id).catch(() => null)))).filter((it): it is FullItem => !!it?.login);
  const sameUser = await decrypt(sameUserIds);
  // Nothing new: this exact login is already saved.
  if (sameUser.some((f) => f.login!.password === c.password)) return null;
  if (sameUser[0]) return { kind: 'update', itemId: sameUser[0].id };
  // No username on the form (password-only page), or a change-password form: compare passwords across the site.
  if (!user || c.current) {
    const all = await decrypt(matches.map((it) => it.id));
    if (!user && all.some((f) => f.login!.password === c.password)) return null;
    const old = c.current ? all.find((f) => f.login!.password === c.current) : undefined;
    if (old) return { kind: 'update', itemId: old.id };
  }
  return { kind: 'save', itemId: null };
}

async function submitted(c: Captured, sender: chrome.runtime.MessageSender): Promise<{ token: string } | null> {
  const tabId = sender.tab!.id!;
  const url = sender.url!;
  const settings = await getSettings();
  if (!c.password) return null;
  if (!c.username) {
    // Two-step login: the username was typed on the page before.
    const { stepUser } = await mem.get('stepUser');
    const prev = stepUser?.[tabId];
    if (prev && prev.host === hostOf(url) && Date.now() - prev.at < MAX_AGE) c = { ...c, username: prev.username };
  }
  // The same submit often arrives twice (click on the button, then the form's submit event).
  const all = await pendings();
  for (const [k, p] of Object.entries(all)) {
    if (p.tabId === tabId && p.username === c.username && p.password === c.password && p.state === 'ask') return answer(k, sender);
  }
  const d = await decide(url, c, settings);
  if (!d) return null;
  const t = token();
  await setPending(t, { tabId, url, username: c.username, password: c.password, current: c.current, kind: d.kind, itemId: d.itemId, created: Date.now(), state: 'ask' });
  // A submit that navigates may already have replaced the page by now: deliver to whatever page the tab shows.
  // (The next page's "load complete" delivers again; showing is idempotent per token.)
  if (sender.frameId === 0) void deliverPrompt(tabId, t);
  return answer(t, sender);
}

/** The prompt shows in the top frame, even when the login form was in a frame. */
async function answer(t: string, sender: chrome.runtime.MessageSender): Promise<{ token: string } | null> {
  if (sender.frameId === 0) return { token: t };
  await toCs({ tabId: sender.tab!.id!, frameId: 0 }, { lw: 'prompt', token: t });
  return null;
}

async function promptData(t: string, error?: string): Promise<PromptData> {
  const p = (await pendings())[t];
  if (!p) throw new S.UserError('This prompt has expired.');
  const [settings, folders, item] = await Promise.all([
    getSettings(),
    p.kind === 'save' && (await mem.get('session')).session ? S.folders().catch(() => []) : Promise.resolve([]),
    p.itemId ? S.fullItem(p.itemId).catch(() => null) : Promise.resolve(null),
  ]);
  return { kind: p.kind, state: p.state, site: siteName(hostOf(p.url)), username: p.username, password: p.password, itemName: item?.name ?? null, folders, theme: settings.theme, ...(error ? { error } : {}) };
}

function draftFrom(it: FullItem): Draft {
  return { type: it.type, name: it.name, notes: it.notes, folderId: it.folderId, login: it.login ? { ...it.login, uris: [...it.login.uris] } : undefined };
}

async function promptAct(a: Api['promptAct'][0], sender: chrome.runtime.MessageSender): Promise<PromptData> {
  const p = (await pendings())[a.token];
  if (!p || (sender.tab?.id != null && sender.tab.id !== p.tabId)) throw new S.UserError('This prompt has expired.');
  const host = hostOf(p.url);
  try {
    if (a.act === 'notnow') {
      await setPending(a.token, null);
      await closePrompt(a.token, p.tabId);
      return { ...(await basicData(p)), state: 'ask' };
    }
    if (a.act === 'unlock') {
      await openPopup();
      return promptData(a.token);
    }
    if (a.act === 'never') {
      await patchSettings({ neverSaveSites: [...(await getSettings()).neverSaveSites.filter((h) => h !== host), host] });
      await setPending(a.token, { ...p, state: 'never' });
      return promptData(a.token);
    }
    if (a.act === 'undo') {
      if (p.state === 'never') await patchSettings({ neverSaveSites: (await getSettings()).neverSaveSites.filter((h) => h !== host) });
      if (p.state === 'saved' && p.undo) {
        if (p.undo.oldPassword == null) await S.trashItem(p.undo.id);
        else {
          const it = await S.fullItem(p.undo.id);
          const d = draftFrom(it);
          d.login!.password = p.undo.oldPassword;
          await S.saveItem(p.undo.id, d);
        }
      }
      await setPending(a.token, { ...p, state: 'ask', undo: null });
      return promptData(a.token);
    }
    // save / update
    const username = (a.username ?? p.username).trim();
    const password = a.password ?? p.password;
    if (!password) return promptData(a.token, 'The password is empty.');
    if (p.kind === 'update' && p.itemId) {
      const it = await S.fullItem(p.itemId);
      const d = draftFrom(it);
      const old = d.login!.password;
      d.login!.password = password;
      await S.saveItem(p.itemId, d);
      await setPending(a.token, { ...p, password, state: 'saved', undo: { id: p.itemId, oldPassword: old ?? '' } });
    } else {
      const origin = new URL(p.url).origin;
      const { id } = await S.saveItem(null, { type: 1, name: siteName(host), notes: null, folderId: a.folderId ?? null, login: { username: username || null, password, totp: null, uris: [{ uri: origin, match: null }] } });
      await setPending(a.token, { ...p, username, password, state: 'saved', undo: { id, oldPassword: null } });
    }
    return promptData(a.token);
  } catch (err) {
    return promptData(a.token, (err as Error).message);
  }
}

async function basicData(p: PendingSave): Promise<PromptData> {
  return { kind: p.kind, state: p.state, site: siteName(hostOf(p.url)), username: p.username, password: p.password, itemName: null, folders: [], theme: (await getSettings()).theme };
}

async function closePrompt(t: string, tabId: number) {
  const all = await surfaces();
  for (const [k, s] of Object.entries(all)) if (s.kind === 'prompt' && s.tabId === tabId && k === t) await toCs(s, { lw: 'close', token: k });
  await toCs({ tabId, frameId: 0 }, { lw: 'close', token: t });
  await dropSurface(t);
}

/** After an unlock, prompts that were waiting ("Unlock to save") get their real answer. */
export async function onUnlocked() {
  const all = await pendings();
  const settings = await getSettings();
  for (const [t, p] of Object.entries(all)) {
    if (p.kind !== 'locked') continue;
    const d = await decide(p.url, { username: p.username, password: p.password, current: p.current, isNew: false }, settings);
    if (!d) {
      await setPending(t, null);
      await closePrompt(t, p.tabId);
      continue;
    }
    await setPending(t, { ...p, ...d });
    await toCs({ tabId: p.tabId, frameId: 0 }, { lw: 'prompt', token: t });
  }
}

// ---------- teach this site ----------

async function teachAct(t: string, act: Api['teachAct'][0]['act'], sender: chrome.runtime.MessageSender) {
  const s = await surface(t, sender);
  await toCs(s, { lw: 'teach-act', token: t, act });
}

export async function startTeach(tabId: number): Promise<{ ok: boolean }> {
  const ok = await chrome.tabs
    .sendMessage(tabId, { lw: 'teach' } satisfies ToCs, { frameId: 0 })
    .then(() => true)
    .catch(() => false);
  if (ok) return { ok };
  // A page opened before Litewarden was installed has no content script yet: add it, then ask again.
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['/content-scripts/lw.js'] });
    await new Promise((r) => setTimeout(r, 150));
    await chrome.tabs.sendMessage(tabId, { lw: 'teach' } satisfies ToCs, { frameId: 0 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------- settings that content scripts follow ----------

async function patchSettings(patch: Partial<Settings>) {
  const { settings } = await local.get('settings');
  await local.set({ settings: { ...settings, ...patch } });
  await refreshAll();
}

/** Tell every tab's content script to re-read its settings (icon on/off, rules). Rare: only on changes. */
export async function refreshAll() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => (t.id != null ? chrome.tabs.sendMessage(t.id, { lw: 'refresh' } satisfies ToCs).catch(() => {}) : null)));
}

export async function openPopup() {
  try {
    // openPopup needs a focused browser window; it can also never settle (headless). Give it a second.
    await Promise.race([chrome.action.openPopup(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 1000))]);
  } catch {
    // Not possible right now (no focused window): a pop-out window does the same job.
    const { popoutBounds } = await local.get('popoutBounds');
    await chrome.windows.create({ url: chrome.runtime.getURL('/popup.html?popout=1'), type: 'popup', focused: true, ...(popoutBounds ?? { width: 400, height: 660 }) });
  }
}

// ---------- message handlers ----------

type ExtHandlers = { [K in 'menuData' | 'menuFill' | 'surfaceAct' | 'promptData' | 'promptAct' | 'teachData' | 'teachAct' | 'startTeach' | 'openPopup' | 'siteRules' | 'removeRule']: (data: Api[K][0], sender: chrome.runtime.MessageSender) => Promise<Api[K][1]> };

export const inpageHandlers: ExtHandlers = {
  menuData: ({ token: t }, sender) => menuData(t, sender),
  menuFill: ({ token: t, id, force }, sender) => menuFill(t, id, !!force, sender),
  surfaceAct: async ({ token: t, act, w, h }, sender) => {
    // A frame whose record is gone (expired, extension updated) can still close: ask every frame of its tab to drop
    // the frame with this token. Only the page's own content script holds that token, so nothing else reacts.
    if (act === 'close' && !(await surfaces())[t] && sender.tab?.id != null) return void (await chrome.tabs.sendMessage(sender.tab.id, { lw: 'close', token: t } satisfies ToCs).catch(() => {}));
    const s = await surface(t, sender);
    if (act === 'size') return toCs(s, { lw: 'size', token: t, h: h ?? 0, ...(w ? { w } : {}) });
    await toCs(s, { lw: 'close', token: t });
    await dropSurface(t);
    if (act === 'teach') await toCs(s, { lw: 'teach' });
    if (act === 'hide') await patchSettings({ iconOffSites: [...(await getSettings()).iconOffSites.filter((x) => x !== hostOf(s.url)), hostOf(s.url)] });
  },
  promptData: async ({ token: t }, sender) => {
    const p = (await pendings())[t];
    if (!p || (sender.tab?.id != null && sender.tab.id !== p.tabId)) throw new S.UserError('This prompt has expired.');
    return promptData(t);
  },
  promptAct: (a, sender) => promptAct(a, sender),
  teachData: async ({ token: t }, sender) => {
    const s = await surface(t, sender);
    return { site: siteName(hostOf(s.url)), state: s.teach ?? { step: 1, username: null, password: null, totp: null } };
  },
  teachAct: ({ token: t, act }, sender) => teachAct(t, act, sender),
  startTeach: ({ tabId }) => startTeach(tabId),
  openPopup: () => openPopup(),
  siteRules: async () => (await local.get('siteRules')).siteRules ?? {},
  removeRule: async ({ host }) => {
    const { siteRules } = await local.get('siteRules');
    if (siteRules?.[host]) {
      delete siteRules[host];
      await local.set({ siteRules });
    }
    await refreshAll();
  },
};

type CsHandlers = { [K in keyof CsApi]: (data: CsApi[K][0], sender: chrome.runtime.MessageSender) => Promise<CsApi[K][1]> };

export const csHandlers: CsHandlers = {
  'cs:hello': async (_d, sender): Promise<CsHello> => {
    const host = hostOf(sender.url!);
    const [settings, { session }, { siteRules }] = await Promise.all([getSettings(), mem.get('session'), local.get('siteRules')]);
    let prompt: string | null = null;
    if (sender.frameId === 0) {
      // A prompt from before the page changed (form submits usually navigate).
      const all = await pendings();
      const mine = Object.entries(all).filter(([, p]) => p.tabId === sender.tab!.id && p.state === 'ask');
      prompt = mine.sort((a, b) => b[1].created - a[1].created)[0]?.[0] ?? null;
    }
    return {
      icon: settings.fieldIcon && !settings.iconOffSites.includes(host),
      menuOnFocus: settings.menuOnFocus,
      locked: !session,
      rule: siteRules?.[host] ?? null,
      prompt,
      theme: settings.theme,
    };
  },
  'cs:open': async ({ kind, token: given }, sender) => {
    const s: Surface = { kind, tabId: sender.tab!.id!, frameId: sender.frameId!, url: sender.url!, created: Date.now() };
    if (kind === 'teach') s.teach = { step: 1, username: null, password: null, totp: null };
    if (kind === 'prompt') {
      const p = given ? (await pendings())[given] : null;
      if (!p || p.tabId !== s.tabId) throw new S.UserError('No prompt waiting.');
      await editSurfaces((all) => void (all[given!] = s));
      return { token: given! };
    }
    return { token: await addSurface(s) };
  },
  'cs:submitted': (c, sender) => submitted(c, sender),
  'cs:userStep': async ({ username }, sender) => {
    const { stepUser } = await mem.get('stepUser');
    await mem.set({ stepUser: { ...(stepUser ?? {}), [sender.tab!.id!]: { host: hostOf(sender.url!), username, at: Date.now() } } });
  },
  'cs:teachState': async ({ token: t, state }, sender) => {
    let mine = false;
    await editSurfaces((all) => {
      const s = all[t];
      if (!s || s.tabId !== sender.tab!.id || s.frameId !== sender.frameId) return;
      all[t] = { ...s, teach: state };
      mine = true;
    });
    if (!mine) return;
    await chrome.runtime.sendMessage({ event: 'teach-state', token: t, state } satisfies { event: string; token: string; state: TeachState }).catch(() => {});
  },
  'cs:saveRule': async ({ rule }, sender) => {
    const host = hostOf(sender.url!);
    const { siteRules } = await local.get('siteRules');
    const clean: SiteRule = { username: rule.username, password: rule.password, totp: rule.totp, url: sender.url!.split(/[?#]/)[0]!, created: Date.now() };
    await local.set({ siteRules: { ...(siteRules ?? {}), [host]: clean } });
  },
  'cs:removeRule': async (_d, sender) => {
    const host = hostOf(sender.url!);
    const { siteRules } = await local.get('siteRules');
    if (siteRules?.[host]) {
      delete siteRules[host];
      await local.set({ siteRules });
    }
  },
  'cs:closed': async ({ token: t }, sender) => {
    const s = (await surfaces())[t];
    if (s && s.tabId === sender.tab!.id) await dropSurface(t);
    const p = (await pendings())[t];
    // A prompt closed by the page going away stays pending (it shows again on the next page); one the user
    // dismissed is answered through promptAct.
    void p;
  },
};

/** A tab closed: forget its surfaces and prompts. */
export async function forgetTab(tabId: number) {
  await editSurfaces((all) => {
    for (const [k, s] of Object.entries(all)) if (s.tabId === tabId) delete all[k];
  });
  await serial(async () => {
    const ps = await pendings();
    for (const [k, p] of Object.entries(ps)) if (p.tabId === tabId) delete ps[k];
    await mem.set({ pendingSaves: ps });
  });
  const { stepUser } = await mem.get('stepUser');
  if (stepUser?.[tabId]) {
    delete stepUser[tabId];
    await mem.set({ stepUser });
  }
}

/** Alt+Shift+L: the frame with the focused login field opens the menu there. */
export async function openMenuCommand() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) await chrome.tabs.sendMessage(tab.id, { lw: 'open-menu' } satisfies ToCs).catch(() => {});
}

/** "Fill with Litewarden" on a field's right-click menu: the menu opens on that field, in its frame. */
export async function openMenuAt(tabId: number, frameId: number) {
  await chrome.tabs.sendMessage(tabId, { lw: 'open-menu', ctx: true } satisfies ToCs, { frameId }).catch(() => {});
}

/** A page finished loading in a tab with an unanswered save prompt (the form submit navigated): show it there. */
export async function pushPrompt(tabId: number) {
  const { pendingSaves } = await mem.get('pendingSaves');
  const mine = Object.entries(pendingSaves ?? {}).filter(([, p]) => p.tabId === tabId && p.state === 'ask' && Date.now() - p.created < MAX_AGE);
  const last = mine.sort((a, b) => b[1].created - a[1].created)[0];
  if (last) await deliverPrompt(tabId, last[0]);
}

/**
 * Keep offering a save prompt to the tab's top frame until the page there has opened it. One message isn't
 * enough: the content script runs at document_idle, which Chrome may schedule after the tab reports "complete",
 * and on a slow machine both the submit-time push and the load-time push can land before the new page is
 * listening (or on the old page while it unloads). Stops once a page has opened the prompt since this delivery
 * started (a surface record older than that belongs to a page that's gone, e.g. before a reload of the same URL),
 * when the prompt is no longer waiting, or after DELIVER_FOR ms.
 */
const DELIVER_FOR = 8000;
/** Running deliveries: token key -> when the latest request for it arrived. */
const delivering = new Map<string, number>();
async function deliverPrompt(tabId: number, t: string) {
  const key = `${tabId}:${t}`;
  // Already running (e.g. the submit's delivery when the next page finishes loading): a newer request moves the
  // loop's "since" forward, so a surface opened by the page that's now gone no longer counts as delivered.
  if (delivering.has(key)) return void delivering.set(key, Date.now());
  delivering.set(key, Date.now());
  try {
    for (;;) {
      const since = delivering.get(key)!;
      if (Date.now() > since + DELIVER_FOR) return;
      const p = (await pendings())[t];
      if (!p || p.state !== 'ask') return;
      if (!(await chrome.tabs.get(tabId).catch(() => null))) return;
      const shown = (await surfaces())[t];
      if (shown && shown.tabId === tabId && shown.created >= since) return;
      await toCs({ tabId, frameId: 0 }, { lw: 'prompt', token: t });
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    delivering.delete(key);
  }
}
