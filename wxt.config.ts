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
    },
    content_security_policy: {
      // WASM (Argon2id) needs wasm-unsafe-eval; nothing else is relaxed. No remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  }),
});
