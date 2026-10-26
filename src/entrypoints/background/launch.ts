// SPDX-License-Identifier: GPL-3.0-only
// "Open and fill": the user picked a login for a site that isn't open. Open it in a new tab and fill the sign-in
// form once it shows up (many pages draw it well after load). It never presses Sign in. It only fills a page that
// matches the login, so a redirect to some other site gets nothing, and it gives up after WAIT_MS, so a form
// the user gets to later isn't touched.
import { totp } from '../../core';
import { launchUrl } from '../../core/uri';
import { getSettings } from '../../shared/store';
import { copySecret } from './clipboard';
import { fill } from './fill';
import { fullItem } from './session';

const WAIT_MS = 30_000;
const EVERY_MS = 700;
/** A page still "loading" after this long (ads, trackers) gets tried anyway: its form is usually there. */
const LOADING_GRACE_MS = 6_000;
/** After a fill, how long a form drawn again (empty) gets filled again, and how many fills in all. */
const SETTLE_MS = 3_000;
const MAX_FILLS = 3;

/** Opens the tab right after `from` (the tab the popup was opened on) and returns at once; the fill follows. */
export async function launch(id: string, from?: number): Promise<{ host: string }> {
  const item = await fullItem(id);
  const url = item.login && launchUrl(item.login.uris);
  if (!url) throw new Error('This login has no web address to open.');
  const opener = from != null ? await chrome.tabs.get(from).catch(() => null) : null;
  const tab = await chrome.tabs.create({ url: url.href, ...(opener?.id != null ? { windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id } : {}) });
  if (tab.id != null) void fillWhenReady(tab.id, id);
  return { host: url.hostname };
}

async function fillWhenReady(tabId: number, id: string) {
  const start = Date.now();
  const allowFrame = (await getSettings()).askFrames ? 'matching' : true;
  let fills = 0;
  let filledAt = 0;
  while (Date.now() - start < WAIT_MS) {
    await new Promise((r) => setTimeout(r, EVERY_MS));
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status !== 'complete' && Date.now() - start < LOADING_GRACE_MS) continue;
    // Filled: watch a moment longer, since apps often draw the form again right after the first paint.
    if (fills && (Date.now() - filledAt > SETTLE_MS || fills >= MAX_FILLS)) break;
    if (fills && !(await emptyPassword(tabId))) continue;
    // A throw means the vault locked or the item went away: nothing to fill with.
    const r = await fill(tabId, id, false, allowFrame).catch(() => null);
    if (!r) break;
    if (r.outcome !== 'filled') continue;
    fills++;
    filledAt = Date.now();
  }
  if (fills && (await getSettings()).copyTotpAfterFill) {
    const it = await fullItem(id).catch(() => null);
    if (it?.login?.totp) await copySecret(await totp(it.login.totp)).catch(() => {});
  }
}

/** A password field on the page is showing and empty: the form we filled was drawn again. */
async function emptyPassword(tabId: number): Promise<boolean> {
  const res = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => [...document.querySelectorAll('input[type=password]')].some((i) => (i as HTMLInputElement).getClientRects().length > 0 && !(i as HTMLInputElement).value) })
    .catch(() => []);
  return res.some((r) => r.result === true);
}
