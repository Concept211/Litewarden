// SPDX-License-Identifier: GPL-3.0-only
// Service worker: message router, auto-lock and clipboard alarms, per-tab login matching, toolbar icon.
import { matchesPage } from '../../core';
import type { Api, CsApi, Req } from '../../shared/messages';
import { getSettings, local, mem, type IndexItem, type Settings } from '../../shared/store';
import { clearClipboard } from './clipboard';
import { fill } from './fill';
import { csHandlers, forgetTab, inpageHandlers, onUnlocked, openMenuCommand, pushPrompt, refreshAll } from './inpage';
import { armSyncAlarm, startLive, stopLive } from './live';
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
  fill: async ({ tabId, id, force, allowFrame }) => fill(tabId, id, force, allowFrame || !(await getSettings()).askFrames),
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
    if ('liveSync' in patch) await (next.liveSync ? startLive() : stopLive('off'));
    if ('syncMinutes' in patch) await armSyncAlarm();
    // Content scripts follow these (field icons, focus menu, save prompts).
    if (['fieldIcon', 'iconOffSites', 'menuOnFocus', 'savePrompt', 'neverSaveSites', 'theme'].some((k) => k in patch)) await refreshAll();
    return next;
  },
  getItem: ({ id }) => S.itemDetail(id),
  folders: () => S.folders(),
  saveItem: ({ id, draft }) => S.saveItem(id, draft),
  trashItem: ({ id }) => S.trashItem(id),
  liveState: async () => (await mem.get('live')).live ?? { status: 'off', detail: null, lastPush: null },
  popout: () => openPopout(),
  ...inpageHandlers,
};

// ---------- pop-out window ----------

async function openPopout(): Promise<{ windowId: number }> {
  const { popoutId } = await mem.get('popoutId');
  if (popoutId != null) {
    try {
      await chrome.windows.update(popoutId, { focused: true });
      return { windowId: popoutId };
    } catch {
      // closed without us noticing (worker was asleep): open a new one
    }
  }
  const { popoutBounds } = await local.get('popoutBounds');
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('/popup.html?popout=1'),
    type: 'popup',
    focused: true,
    ...(popoutBounds ?? { width: 400, height: 660 }),
  });
  if (w?.id == null) throw new Error("Chrome didn't open the window.");
  await mem.set({ popoutId: w.id });
  return { windowId: w.id };
}

function serializeError(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { name: e.name, message: e.message, data: e.name === 'TwoFactorRequired' ? (e as S.UserError & { providers?: number[] }).providers : (e.cause as unknown) };
}

// ---------- per-tab matching ----------

async function matchTab(tabId: number, url: string): Promise<{ ids: string[]; items: IndexItem[] }> {
  const e = S.epoch();
  const [{ index, tabMatches }, { recent }] = await Promise.all([mem.get('index', 'tabMatches'), local.get('recent')]);
  if (!index || !/^https?:\/\//i.test(url)) return { ids: [], items: [] };
  const rank = new Map((recent ?? []).map((id, i) => [id, i]));
  const found = index
    .filter((it: IndexItem) => it.uris.length && matchesPage(it.uris, url))
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name));
  const m = { url, ids: found.map((it) => it.id), items: found.slice(0, 20) };
  await S.writeIfUnlocked(e, { tabMatches: { ...(tabMatches ?? {}), [tabId]: m } });
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

export default defineBackground(() => {
  S.setLockListener((unlocked) => {
    void setIcon(unlocked);
    if (!unlocked) void mem.remove('tabMatches');
    void refreshAll().catch(() => {});
    if (unlocked) {
      void onUnlocked().catch(() => {});
      void startLive().catch(() => {});
      void armSyncAlarm().catch(() => {});
    } else {
      void stopLive('off');
      void chrome.alarms.clear('sync');
    }
  });
  S.setIndexListener(() => void matchActiveTabs());

  chrome.runtime.onMessage.addListener((msg: Req & { target?: string; event?: string }, sender, reply) => {
    if (!msg || msg.target || msg.event || !(msg.type in handlers)) return false;
    // Only our own extension pages (popup, offscreen, and the menu / prompt / panel frames, which may be served
    // from a per-session dynamic id) use these. Content scripts have their own small channel below.
    if (sender.id !== chrome.runtime.id || !/^chrome-extension:\/\//.test(sender.url ?? '')) return false;
    const h = handlers[msg.type] as (d: unknown, s: chrome.runtime.MessageSender) => unknown;
    Promise.resolve()
      .then(() => h(msg.data, sender))
      .then((data) => reply({ ok: true, data }))
      .catch((err) => reply({ ok: false, error: serializeError(err) }));
    return true;
  });

  // Content scripts: a short, fixed list of requests, always tied to the tab and frame they come from.
  chrome.runtime.onMessage.addListener((msg: { cs?: keyof CsApi; data?: unknown }, sender, reply) => {
    if (!msg || typeof msg.cs !== 'string' || !(msg.cs in csHandlers)) return false;
    if (sender.id !== chrome.runtime.id || sender.tab?.id == null || sender.frameId == null || !/^https?:\/\//i.test(sender.url ?? '')) return false;
    const h = csHandlers[msg.cs] as (d: unknown, s: chrome.runtime.MessageSender) => Promise<unknown>;
    h(msg.data, sender)
      .then((data) => reply({ ok: true, data }))
      .catch((err) => reply({ ok: false, error: serializeError(err) }));
    return true;
  });

  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'open-menu') void openMenuCommand();
  });

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'autolock') void S.lock();
    if (a.name === 'clipclear') void clearClipboard();
    if (a.name === 'sync') {
      void S.syncNow(false).catch(() => {});
      // The live connection may have died with a sleeping worker: bring it back.
      void startLive().catch(() => {});
    }
  });

  chrome.windows.onBoundsChanged?.addListener(async (w) => {
    const { popoutId } = await mem.get('popoutId');
    if (w.id == null || w.id !== popoutId || w.state !== 'normal') return;
    await local.set({ popoutBounds: { left: w.left!, top: w.top!, width: w.width!, height: w.height! } });
  });
  chrome.windows.onRemoved.addListener(async (id) => {
    const { popoutId } = await mem.get('popoutId');
    if (id === popoutId) await mem.set({ popoutId: null });
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs
      .get(tabId)
      .then((t) => (t.url ? matchTab(tabId, t.url) : undefined))
      .catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'complete') if (tab.active && tab.url) void matchTab(tabId, tab.url).catch(() => {});
    if (info.status === 'complete') void pushPrompt(tabId).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId).catch(() => {}));
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const e = S.epoch();
    const { tabMatches } = await mem.get('tabMatches');
    if (tabMatches?.[tabId]) {
      delete tabMatches[tabId];
      await S.writeIfUnlocked(e, { tabMatches });
    }
  });

  chrome.runtime.onStartup.addListener(() => void S.restoreOnStartup());
  // On every worker start (install, browser start, wake after being killed) make the icon match the state.
  void S.state().then((s) => setIcon(s.status === 'unlocked')).catch(() => {});
  void S.armAutoLock().catch(() => {});
  // A woken worker (Chrome stops idle ones) reconnects live updates if the vault is still unlocked.
  void startLive().catch(() => {});
});
