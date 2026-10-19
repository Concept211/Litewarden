// SPDX-License-Identifier: GPL-3.0-only
// Service worker: message router, auto-lock and clipboard alarms, per-tab login matching, toolbar icon.
import { matchesPage } from '../../core';
import type { Api, Req } from '../../shared/messages';
import { getSettings, local, mem, type IndexItem, type Settings } from '../../shared/store';
import { fill } from './fill';
import * as S from './session';


type Handlers = { [K in keyof Api]: (data: Api[K][0], sender: chrome.runtime.MessageSender) => Promise<Api[K][1]> | Api[K][1] };

const handlers: Handlers = {
  getState: () => S.state(),
  checkServer: ({ url }) => S.checkServer(url),
  login: (p) => S.login(p),
  unlockPassword: ({ password }) => S.unlockPassword(password),
  unlockPin: ({ pin }) => S.unlockPin(pin),
  lock: () => S.lock(),
  logout: () => S.logout(),
  sync: () => S.syncNow(false),
  touch: () => S.touch(),
  getSecret: async ({ id, field }) => {
    const it = await S.fullItem(id);
    const v = field === 'username' ? it.login?.username : field === 'password' ? it.login?.password : it.login?.totp;
    await S.recordUse(id);
    return { value: v ?? null };
  },
  getTotpSecrets: async ({ ids }) => {
    const out: Record<string, string> = {};
    for (const id of ids.slice(0, 40)) {
      const it = await S.fullItem(id).catch(() => null);
      if (it?.login?.totp) out[id] = it.login.totp;
    }
    return out;
  },
  clipboardCopied: async ({ seconds }) => {
    const s = seconds ?? (await getSettings()).clipboardSeconds;
    await chrome.alarms.clear('clipclear');
    if (s > 0) await chrome.alarms.create('clipclear', { when: Date.now() + s * 1000 });
  },
  fill: ({ tabId, id, force, allowFrame }) => fill(tabId, id, force, allowFrame),
  matchTab: ({ tabId, url }) => matchTab(tabId, url),
  setPin: ({ pin }) => S.setPin(pin),
  setSettings: async (patch) => {
    const { settings } = await local.get('settings');
    const next: Settings = { ...(await getSettings()), ...settings, ...patch };
    await local.set({ settings: next });
    if ('lockMinutes' in patch) await S.touch();
    if ('lockOnClose' in patch) {
      const { session } = await mem.get('session');
      await local.set({ persistedSession: next.lockOnClose ? null : (session ?? null) });
    }
    if ('pinSurvivesRestart' in patch) {
      const { pinWrapped } = await mem.get('pinWrapped');
      await local.set({ pinWrapped: next.pinSurvivesRestart ? (pinWrapped ?? null) : null });
    }
    return next;
  },
};

function serializeError(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { name: e.name, message: e.message, data: e.name === 'TwoFactorRequired' ? (e as S.UserError & { providers?: number[] }).providers : (e.cause as unknown) };
}

// ---------- per-tab matching ----------

async function matchTab(tabId: number, url: string): Promise<{ ids: string[]; items: IndexItem[] }> {
  const [{ index, tabMatches }, { recent }] = await Promise.all([mem.get('index', 'tabMatches'), local.get('recent')]);
  if (!index || !/^https?:\/\//i.test(url)) return { ids: [], items: [] };
  const rank = new Map((recent ?? []).map((id, i) => [id, i]));
  const found = index
    .filter((it: IndexItem) => it.uris.length && matchesPage(it.uris, url))
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name));
  const m = { url, ids: found.map((it) => it.id), items: found.slice(0, 20) };
  await mem.set({ tabMatches: { ...(tabMatches ?? {}), [tabId]: m } });
  return m;
}

async function matchActiveTabs() {
  const { session } = await mem.get('session');
  if (!session) return;
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.all(tabs.filter((t) => t.id != null && t.url).map((t) => matchTab(t.id!, t.url!)));
}

// ---------- toolbar icon ----------

async function setIcon(unlocked: boolean) {
  const p = unlocked ? '' : 'locked-';
  await chrome.action.setIcon({
    path: unlocked ? { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' } : { 16: `/icon/${p}16.png`, 32: `/icon/${p}32.png` },
  });
  await chrome.action.setTitle({ title: unlocked ? 'Litewarden' : 'Litewarden (locked)' });
}

async function clearClipboard() {
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!has) {
    await chrome.offscreen.createDocument({ url: '/offscreen.html', reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Clear a copied password after the timeout' });
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear' }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
}

export default defineBackground(() => {
  S.setLockListener((unlocked) => {
    void setIcon(unlocked);
    if (!unlocked) void mem.remove('tabMatches');
  });
  S.setIndexListener(() => void matchActiveTabs());

  chrome.runtime.onMessage.addListener((msg: Req & { target?: string; event?: string }, sender, reply) => {
    if (msg.target || msg.event || !(msg.type in handlers)) return false;
    // Only our own extension pages talk to the worker; content scripts never do.
    if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) return false;
    const h = handlers[msg.type] as (d: unknown, s: chrome.runtime.MessageSender) => unknown;
    Promise.resolve()
      .then(() => h(msg.data, sender))
      .then((data) => reply({ ok: true, data }))
      .catch((err) => reply({ ok: false, error: serializeError(err) }));
    return true;
  });

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'autolock') void S.lock();
    if (a.name === 'clipclear') void clearClipboard();
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs
      .get(tabId)
      .then((t) => (t.url ? matchTab(tabId, t.url) : undefined))
      .catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'complete') if (tab.active && tab.url) void matchTab(tabId, tab.url).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const { tabMatches } = await mem.get('tabMatches');
    if (tabMatches?.[tabId]) {
      delete tabMatches[tabId];
      await mem.set({ tabMatches });
    }
  });

  chrome.runtime.onStartup.addListener(() => void S.restoreOnStartup());
  // On every worker start (install, browser start, wake after being killed) make the icon match the state.
  void S.state().then((s) => setIcon(s.status === 'unlocked')).catch(() => {});
  void S.armAutoLock().catch(() => {});
});
