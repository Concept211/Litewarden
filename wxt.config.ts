// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Litewarden',
    description: 'A fast, lightweight password manager for Vaultwarden servers.',
    // Every permission is justified in the Chrome Web Store listing:
    // storage/unlimitedStorage: the encrypted vault copy; alarms: auto-lock and clipboard clearing;
    // scripting: fill a form when you ask; offscreen + clipboardWrite: clear a copied password after 30 s.
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'scripting', 'offscreen', 'clipboardWrite'],
    // Fill on any site you choose, and talk to your own server (whatever its address is).
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Litewarden' },
    commands: {
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' }, description: 'Open Litewarden with search ready' },
      'open-menu': { suggested_key: { default: 'Alt+Shift+L' }, description: 'Open the Litewarden menu in the focused login field' },
    },
    // The in-page menu, save prompt and teach panel are extension pages framed into sites. Only these three pages
    // can be framed, and only through a per-session dynamic id, so a site can't guess the address ahead of time.
    web_accessible_resources: [{ resources: ['menu.html', 'prompt.html', 'teach.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }],
    content_security_policy: {
      // WASM (Argon2id) needs wasm-unsafe-eval; nothing else is relaxed. No remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  }),
});
