// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { ROOT } from '../../scripts/testserver/env';
import { CORPUS_PORT } from './accounts';

export const EXT = path.join(ROOT, '.output', 'chrome-mv3');

interface Fx {
  ctx: BrowserContext;
  extId: string;
  sw: () => Promise<Worker>;
  /** Open the popup as a page aimed at `target` (the popup normally targets the active tab). */
  /** `resume`: open where the last popup left off (see popup/where.ts); by default it opens fresh, on the list. */
  popup: (target?: Page, opts?: { theme?: 'light' | 'dark'; tabId?: number; resume?: boolean }) => Promise<Page>;
  corpus: (file: string) => Promise<Page>;
}

export const test = base.extend<{}, Fx>({
  // One browser per test file: the files are written as a user's session, in order.
  // eslint-disable-next-line no-empty-pattern
  ctx: [async ({}, use) => {
    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: process.env.HEADED ? false : true,
      viewport: { width: 1100, height: 760 },
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        `--host-resolver-rules=MAP *.lw.test 127.0.0.1, MAP *.example-lw.test 127.0.0.1, MAP *.newsite-lw.test 127.0.0.1, MAP *.save-lw.test 127.0.0.1`,
      ],
    });
    // LW_CPU_THROTTLE=4 slows every page down (CDP) to reproduce timing seen on slow CI runners. Off by default.
    const slow = Number(process.env.LW_CPU_THROTTLE ?? '0');
    if (slow > 1) {
      const throttle = async (pg: import('@playwright/test').Page) => {
        const c = await ctx.newCDPSession(pg).catch(() => null);
        await c?.send('Emulation.setCPUThrottlingRate', { rate: slow }).catch(() => {});
      };
      for (const pg of ctx.pages()) await throttle(pg);
      ctx.on('page', (pg) => void throttle(pg));
    }
    await use(ctx);
    await ctx.close();
  }, { scope: 'worker' }],
  sw: [async ({ ctx: context }, use) => {
    await use(async () => context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await context.waitForEvent('serviceworker')));
  }, { scope: 'worker' }],
  extId: [async ({ sw }, use) => {
    await use(new URL((await sw()).url()).host);
  }, { scope: 'worker' }],
  corpus: [async ({ ctx: context }, use) => {
    await use(async (file) => {
      const p = await context.newPage();
      await p.goto(`http://corpus.lw.test:${CORPUS_PORT}/${file}`);
      return p;
    });
  }, { scope: 'worker' }],
  popup: [async ({ ctx: context, extId, sw }, use) => {
    await use(async (target, opts = {}) => {
      let tabId = opts.tabId ? String(opts.tabId) : '';
      if (target && !tabId) {
        const url = target.url();
        tabId = String(await (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).sort((a, b) => b.id! - a.id!)[0]?.id ?? '', url));
      }
      if (!opts.resume) await (await sw()).evaluate(() => chrome.storage.session.remove('popupWhere'));
      const p = await context.newPage();
      await p.setViewportSize({ width: 380, height: 600 });
      if (opts.theme) await p.emulateMedia({ colorScheme: opts.theme });
      await p.goto(`chrome-extension://${extId}/popup.html${tabId ? `?tabId=${tabId}` : ''}`);
      return p;
    });
  }, { scope: 'worker' }],
});

export { expect };
