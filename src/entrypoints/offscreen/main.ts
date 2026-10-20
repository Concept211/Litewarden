// SPDX-License-Identifier: GPL-3.0-only
// Offscreen document (reason CLIPBOARD): the service worker has no DOM.
//  - write: copies a value (the 2FA code after a fill from the in-page menu).
//  - clear: replaces the clipboard with an empty string, but only if it still holds what Litewarden copied. The
//    worker sends the SHA-256 of that value; we read the clipboard, hash it and compare. A newer copy of yours
//    is left alone. The text read is held in a local variable and a textarea for the length of the check, then
//    dropped.
// Reading: navigator.clipboard.readText() needs a focused document and an offscreen document can't be focused,
// so we paste into the textarea with document.execCommand('paste'), which the clipboardRead permission allows.
// If that read fails for any reason we clear anyway: a secret left on the clipboard is worse than a lost copy.
import { clipHash } from '../../shared/cliphash';

type Msg = { target?: string; type?: string; value?: string; hash?: string };
type Reply = { ok: boolean; skipped?: boolean; read?: boolean };

function write(value: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', value);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  return ok;
}

/** What is on the clipboard now, or null if it can't be read here. */
function read(): string | null {
  const t = document.getElementById('t') as HTMLTextAreaElement | null;
  if (!t) return null;
  t.value = '';
  t.focus();
  let got: string | null = null;
  const onPaste = (e: ClipboardEvent) => {
    got = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
  };
  document.addEventListener('paste', onPaste, { once: true });
  const ok = document.execCommand('paste');
  document.removeEventListener('paste', onPaste);
  t.value = '';
  return ok ? got : null;
}

async function clear(hash?: string): Promise<Reply> {
  if (hash) {
    const now = read();
    if (now !== null) {
      if (now === '' || (await clipHash(now)) !== hash) return { ok: true, skipped: true, read: true };
      return { ok: write(''), read: true };
    }
  }
  return { ok: write(''), read: false };
}

chrome.runtime.onMessage.addListener((msg: Msg, _s, reply) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'write') {
    reply({ ok: write(String(msg.value ?? '')) } satisfies Reply);
  } else if (msg.type === 'clear') {
    void clear(msg.hash).then(reply);
    return true;
  }
});
