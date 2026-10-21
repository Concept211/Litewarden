// SPDX-License-Identifier: GPL-3.0-only
// Popup start-up. Reads everything it needs straight from storage (no service-worker round trip) so the
// list is on screen fast; the worker only gets a "touch" afterwards to push the auto-lock deadline.
import { checkKdf, kdfSignature } from '../../core/kdf';
import { send } from '../../shared/messages';
import { POPUP_SIZES, local, mem, withDefaults, type Account, type IndexItem, type Lockout, type Settings } from '../../shared/store';

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
  /** Why the account's key settings are weak (empty when fine). */
  kdfWeak: string[];
  /** The user dismissed the notice on the main screen for these settings. */
  kdfDismissed: boolean;
  /** Opened as the pop-out window: it stays open and follows the active tab of the browser window behind it. */
  popout: boolean;
  /** The list's folder filter (see LocalStore.listFolder). */
  listFolder: string;
}

export const isPopout = () => new URLSearchParams(location.search).has('popout');

/**
 * The page the popup acts on: ?tabId= (tests), the active tab of the last focused browser window (pop-out), else
 * the active tab of the window the popup opened over.
 */
export async function targetTab(): Promise<Tab | null> {
  const q = new URLSearchParams(location.search).get('tabId');
  try {
    let t: chrome.tabs.Tab | undefined;
    if (q) t = await chrome.tabs.get(Number(q));
    else if (isPopout()) {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      t = (await chrome.tabs.query({ active: true, windowId: win.id }))[0];
    } else t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return t?.id != null ? { id: t.id, url: t.url ?? '' } : null;
  } catch {
    return null;
  }
}

export async function boot(): Promise<Boot> {
  const [l, m, tab] = await Promise.all([
    local.get('account', 'settings', 'lastSync', 'lastSyncError', 'pinWrapped', 'kdfDismissed', 'listFolder'),
    // Small keys only: the full index (megabytes for a big vault) is read after the first paint.
    mem.get('session', 'indexCount', 'recentItems', 'tabMatches', 'pinWrapped', 'lockout', 'failures'),
    targetTab(),
  ]);
  const settings = withDefaults(l.settings);
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
    kdfWeak: l.account ? checkKdf(l.account.kdf).reasons : [],
    kdfDismissed: !!l.account && l.kdfDismissed === kdfSignature(l.account.kdf),
    popout: isPopout(),
    listFolder: l.listFolder ?? 'all',
  };
}

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Theme, popup size and density, all live (Settings and every open popup or pop-out follow at once). */
export function applyLook(s: Settings) {
  applyTheme(s.theme);
  const html = document.documentElement;
  const size = POPUP_SIZES[s.popupSize] ?? POPUP_SIZES.standard;
  html.style.setProperty('--pw', `${size.w}px`);
  html.style.setProperty('--ph', `${size.h}px`);
  html.dataset.density = s.density;
  html.classList.toggle('popout', isPopout());
}
