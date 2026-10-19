// SPDX-License-Identifier: GPL-3.0-only
// Popup start-up. Reads everything it needs straight from storage (no service-worker round trip) so the
// list is on screen fast; the worker only gets a "touch" afterwards to push the auto-lock deadline.
import { send } from '../../shared/messages';
import { DEFAULT_SETTINGS, local, mem, type Account, type IndexItem, type Lockout, type Settings } from '../../shared/store';

export interface Tab {
  id: number;
  url: string;
}

export interface Boot {
  view: 'firstrun' | 'unlock' | 'main';
  account: Account | null;
  settings: Settings;
  pinEnabled: boolean;
  lockout: Lockout | null;
  /** How many items the vault holds. The full index loads after the first paint. */
  count: number;
  tab: Tab | null;
  /** Items for the current tab, best first; null when the worker hasn't matched this tab yet. */
  siteItems: IndexItem[] | null;
  recentItems: IndexItem[];
  lastSync: number | null;
  lastSyncError: string | null;
  failures: number;
}

/** The page the popup acts on: ?tabId= (tests, pop-out), else the active tab of the window it opened over. */
async function targetTab(): Promise<Tab | null> {
  const q = new URLSearchParams(location.search).get('tabId');
  try {
    const t = q ? await chrome.tabs.get(Number(q)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return t?.id != null ? { id: t.id, url: t.url ?? '' } : null;
  } catch {
    return null;
  }
}

export async function boot(): Promise<Boot> {
  const [l, m, tab] = await Promise.all([
    local.get('account', 'settings', 'lastSync', 'lastSyncError', 'pinWrapped'),
    // Small keys only: the full index (megabytes for a big vault) is read after the first paint.
    mem.get('session', 'indexCount', 'recentItems', 'tabMatches', 'pinWrapped', 'lockout', 'failures'),
    targetTab(),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...l.settings };
  const expired = !!m.session?.lockAt && m.session.lockAt < Date.now();
  if (expired) void send('lock');
  const unlocked = !!m.session && !expired;
  const match = tab && m.tabMatches?.[tab.id];
  return {
    view: !l.account ? 'firstrun' : unlocked ? 'main' : 'unlock',
    account: l.account ?? null,
    settings,
    pinEnabled: !!(m.pinWrapped ?? l.pinWrapped),
    lockout: m.lockout ?? null,
    count: unlocked ? (m.indexCount ?? 0) : 0,
    tab,
    siteItems: match && match.url === tab.url && match.items ? match.items : null,
    recentItems: unlocked ? (m.recentItems ?? []) : [],
    lastSync: l.lastSync ?? null,
    lastSyncError: l.lastSyncError ?? null,
    failures: m.failures?.length ?? 0,
  };
}

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
