// SPDX-License-Identifier: GPL-3.0-only
// Pasting into a one-line field: drop the line breaks a sloppy selection picks up at either end. Left alone,
// Chrome turns a leading line break into a space, which a password field hides from view.

const ONE_LINE = new Set(['text', 'password', 'email', 'url', 'search', 'tel', 'number']);

/** What a paste into this field should insert; null when the text is fine as it is. */
export function tidyPasted(raw: string, secret: boolean): string | null {
  // A password may really start or end with a space, so only whitespace around a line break or tab goes there.
  const clean = secret ? raw.replace(/^\s*[\r\n\t]\s*/, '').replace(/\s*[\r\n\t]\s*$/, '') : raw.trim();
  return clean === raw ? null : clean;
}

function onPaste(e: ClipboardEvent) {
  const t = e.composedPath()[0];
  if (!(t instanceof HTMLInputElement) || !ONE_LINE.has(t.type)) return;
  const raw = e.clipboardData?.getData('text/plain');
  if (!raw) return;
  // The editor's password field turns into type=text while shown; its autocomplete still says what it is.
  const clean = tidyPasted(raw, t.type === 'password' || /password/i.test(t.autocomplete));
  if (clean == null) return;
  e.preventDefault();
  // Inserted as typing would be: the page's input handlers run and Ctrl+Z still works.
  document.execCommand('insertText', false, clean);
}

export const tidyPaste = () => document.addEventListener('paste', onPaste, true);
