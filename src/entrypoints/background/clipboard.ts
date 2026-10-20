// SPDX-License-Identifier: GPL-3.0-only
// Clipboard from the service worker, through the offscreen document (the worker has no DOM).
import { clipHash } from '../../shared/cliphash';
import { getSettings, mem } from '../../shared/store';

/**
 * Write or clear the clipboard through the offscreen document. The document's message listener can be a moment
 * behind createDocument() on a slow machine, and a message sent before it listens is lost ("Receiving end does
 * not exist"), so keep asking until the document confirms the write. A clear that silently didn't happen would
 * leave a secret on the clipboard. Returns false if it never confirmed.
 */
async function offscreen(type: 'clear' | 'write', value?: string, hash?: string): Promise<boolean> {
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!has) {
    await chrome.offscreen
      .createDocument({ url: '/offscreen.html', reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Copy a 2FA code after a fill, and clear copied secrets after the timeout' })
      .catch(() => {}); // already open (two calls at once)
  }
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    const r = (await chrome.runtime.sendMessage({ target: 'offscreen', type, value, hash }).catch(() => null)) as { ok?: boolean } | null;
    ok = r?.ok === true;
    if (!ok) await new Promise((res) => setTimeout(res, 100));
  }
  await chrome.offscreen.closeDocument().catch(() => {});
  return ok;
}

/**
 * Clear the clipboard if it still holds what Litewarden last copied (compared by SHA-256). Without a remembered
 * hash it clears unconditionally.
 */
export async function clearClipboard(): Promise<boolean> {
  const { clipHash: hash } = await mem.get('clipHash');
  const ok = await offscreen('clear', undefined, hash);
  if (ok) await mem.remove('clipHash');
  return ok;
}

/** Remember the hash of a value placed on the clipboard (the popup copies by itself and reports the hash). */
export const rememberCopy = (hash: string) => mem.set({ clipHash: hash });

/** Copy a secret and arm the clear-after timer. */
export async function copySecret(value: string) {
  await offscreen('write', value);
  await rememberCopy(await clipHash(value));
  const s = (await getSettings()).clipboardSeconds;
  await chrome.alarms.clear('clipclear');
  if (s > 0) await chrome.alarms.create('clipclear', { when: Date.now() + s * 1000 });
}
