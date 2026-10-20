// SPDX-License-Identifier: GPL-3.0-only
// Clipboard from the service worker, through the offscreen document (the worker has no DOM).
import { getSettings } from '../../shared/store';

async function offscreen(type: 'clear' | 'write', value?: string) {
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!has) {
    await chrome.offscreen.createDocument({ url: '/offscreen.html', reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Copy a 2FA code after a fill, and clear copied secrets after the timeout' });
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type, value }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
}

export const clearClipboard = () => offscreen('clear');

/** Copy a secret and arm the clear-after timer. */
export async function copySecret(value: string) {
  await offscreen('write', value);
  const s = (await getSettings()).clipboardSeconds;
  await chrome.alarms.clear('clipclear');
  if (s > 0) await chrome.alarms.create('clipclear', { when: Date.now() + s * 1000 });
}
