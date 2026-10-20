// SPDX-License-Identifier: GPL-3.0-only
// Offscreen document (reason CLIPBOARD): the service worker has no DOM. It clears the clipboard after the timeout
// (replaces it with an empty string) and, after a fill from the in-page menu, copies the 2FA code. It never reads
// the clipboard.
chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string; value?: string }, _s, reply) => {
  if (msg?.target !== 'offscreen' || (msg.type !== 'clear' && msg.type !== 'write')) return;
  const value = msg.type === 'write' ? String(msg.value ?? '') : '';
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', value);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  reply({ ok });
});
