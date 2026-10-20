// SPDX-License-Identifier: GPL-3.0-only
// Shared by the demo-shot scripts: a Chromium with the built extension, signed in to the demo vault on a throwaway
// test server (port 8301+, never the real vault), with the Northwind sign-in page routed in.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { ROOT, serverUrl } from '../testserver/env.ts';
import { demoCreds } from './seed-demo.mjs';
import { installDemoSite, ORIGIN } from './demo-site.mjs';

export const EXT = path.join(ROOT, '.output', 'chrome-mv3');
export const OUT = path.join(ROOT, '_testserver', 'demo-shots');
fs.mkdirSync(OUT, { recursive: true });
// The test server answers on loopback; the browser reaches it under a believable self-hosted name (no port shown in the UI).
export const SERVER = 'http://vault.example.com';
const TEST_PORT = new URL(serverUrl('1.37.4')).port;
export { ORIGIN };

export async function launch({ scale = 2, width = 1100, height = 700 } = {}) {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width, height },
    deviceScaleFactor: scale,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP vault.example.com 127.0.0.1:${TEST_PORT}`],
  });
  await installDemoSite(ctx);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId };
}

/** The toolbar popup as a page: 380x600 (the real popup size), aimed at `target`'s tab. */
export async function openPopup({ ctx, sw, extId }, target, { theme, size = { width: 380, height: 600 }, query = '' } = {}) {
  let tabId = '';
  if (target) {
    const url = target.url();
    tabId = String(await sw.evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).sort((a, b) => b.id - a.id)[0]?.id ?? '', url));
  }
  const p = await ctx.newPage();
  await p.setViewportSize(size);
  if (theme) await p.emulateMedia({ colorScheme: theme });
  await p.goto(`chrome-extension://${extId}/popup.html${tabId ? `?tabId=${tabId}${query}` : query ? `?${query.slice(1)}` : ''}`);
  return p;
}

export async function signIn(env, site) {
  const c = demoCreds();
  const p = await openPopup(env, site);
  await p.waitForSelector('#url');
  await p.fill('#url', SERVER);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', c.email);
  await p.fill('#pw', c.password);
  await p.keyboard.press('Enter');
  const open = p.locator('#open');
  await open.waitFor({ timeout: 90_000 });
  await p.waitForFunction(() => !document.querySelector('#open')?.disabled, null, { timeout: 90_000 });
  await open.click();
  await p.waitForSelector('#q');
  return p;
}

export const shot = (p, name, opts = {}) => p.screenshot({ path: path.join(OUT, name), ...opts });

/** Field icons of the page (Litewarden draws in a closed shadow root; CDP reaches it). Returns boxes in CSS px. */
export async function fieldIcons(p) {
  const cdp = await p.context().newCDPSession(p);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const found = [];
    const attr = (n, k) => {
      const a = n.attributes ?? [];
      const i = a.indexOf(k);
      return i >= 0 ? a[i + 1] : undefined;
    };
    const walk = (n, inside) => {
      const here = inside || n.localName === 'litewarden-ui';
      if (here && n.localName === 'button' && (attr(n, 'class') ?? '').split(' ').includes('ic')) found.push(n);
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c, here);
    };
    walk(root, false);
    const out = [];
    for (const n of found) {
      if (/display:\s*none/.test(attr(n, 'style') ?? '')) continue;
      try {
        const { model } = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
        const q = model.border;
        out.push({ x: q[0], y: q[1], w: q[2] - q[0], h: q[5] - q[1] });
      } catch {
        /* hidden */
      }
    }
    return out.sort((a, b) => a.y - b.y);
  } finally {
    await cdp.detach();
  }
}

/** One of the extension's framed pages (menu, prompt) once it is loaded and placed. */
export async function surface(p, page, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const f = p.frames().find((x) => /^chrome-extension:/.test(x.url()) && x.url().split(/[?#]/)[0].endsWith(`/${page}.html`));
    if (f) {
      const box = await (await f.frameElement()).boundingBox().catch(() => null);
      if (box && box.x > -100) return { frame: f, box };
    }
    if (Date.now() > end) throw new Error(`${page}.html never appeared`);
    await p.waitForTimeout(100);
  }
}

export async function clickFieldIcon(p, selector) {
  const f = await p.locator(selector).boundingBox();
  const ic = (await fieldIcons(p)).find((b) => b.y >= f.y - 2 && b.y + b.h <= f.y + f.height + 2 && b.x >= f.x && b.x + b.w <= f.x + f.width + 1);
  if (!ic) throw new Error(`no Litewarden icon in ${selector}`);
  await p.mouse.click(ic.x + ic.w / 2, ic.y + ic.h / 2);
  return ic;
}
