// SPDX-License-Identifier: GPL-3.0-only
// Service worker. M2b adds the session (login, unlock, lock, sync). For now it only proves the bundle loads.
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('Litewarden installed');
  });
});
