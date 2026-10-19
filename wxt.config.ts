// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Litewarden',
    description: 'A fast, lightweight password manager for Vaultwarden servers.',
    permissions: ['storage'],
    content_security_policy: {
      // WASM (Argon2id) needs wasm-unsafe-eval; nothing else is relaxed. No remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  }),
});
