// SPDX-License-Identifier: GPL-3.0-only
// The toolbar popup closes whenever it loses focus (copying something from the page, another window). Opening it
// again lands where the user was: an unsaved edit until it's saved, discarded or the vault locks; any other
// screen for a few minutes, after which the popup starts on the site's logins again.
import { mem, type PopupScreen, type PopupWhere } from '../../shared/store';

export const FRESH_MS = 5 * 60_000;

/** The screen to reopen on, if any. */
export function pickScreen(w: PopupWhere | null | undefined, now = Date.now()): PopupScreen | null {
  if (!w) return null;
  const s = w.screen;
  const unsaved = 'item' in s && s.mode === 'edit' && !!s.draft && JSON.stringify(s.draft) !== s.baseline;
  return unsaved || now - w.at < FRESH_MS ? s : null;
}

let current: PopupScreen | null = null;

/** The user is on this screen now (null: the main list, which needs no remembering). */
export function here(screen: PopupScreen | null) {
  current = screen;
  void (screen ? mem.set({ popupWhere: { screen, at: Date.now() } }) : mem.remove('popupWhere')).catch(() => {});
}

// "at" means last seen open, and the popup can't write on its way out, so it keeps the time fresh while it's up.
// A lock removes the record (it can hold an unsaved password); that stops the refresh rather than restoring it.
setInterval(async () => {
  if (!current) return;
  const { popupWhere, session } = await mem.get('popupWhere', 'session');
  if (!popupWhere || !session) return void (current = null);
  await mem.set({ popupWhere: { screen: current, at: Date.now() } });
}, 15_000);
