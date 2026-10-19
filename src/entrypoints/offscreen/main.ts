// SPDX-License-Identifier: GPL-3.0-only
// Offscreen document (reason CLIPBOARD): the service worker has no DOM, so clearing the clipboard after the
// timeout happens here. It replaces the clipboard with an empty string; it never reads the clipboard.
chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, _s, reply) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'clear') return;
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  reply({ ok });
});
