// SPDX-License-Identifier: GPL-3.0-only
// Memory soak: one browser with the built extension, used in a loop for hours, against a throwaway test server.
// Run through tests/soak/run.mjs (npm run soak -- --minutes 30). Never the real vault.
//
// Each cycle: fill from the popup, copy from the popup, search in a long-lived pop-out style popup, open and
// close the in-page menu in a tab that stays open the whole run, and every few cycles sync and lock/unlock.
// Every SOAK_EVERY minutes: forced-GC heap of the service worker, the long-lived popup and the long-lived tab,
// plus total browser memory, into _testserver/soak/<run>/samples.csv. Pass rule in memory.ts (judge).
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ROOT } from '../../scripts/testserver/env';
import { CORPUS_PORT, e2eCreds, ensureAccounts } from '../e2e/accounts';
import { finishFirstRun, signIn } from '../e2e/helpers';
import { clickIcon, gone, surface } from '../e2e/inpage-helpers';
import { judge, pageHeap, processMemoryMB, workerHeap } from './memory';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 720);
const EVERY = Number(process.env.SOAK_EVERY ?? (MINUTES >= 120 ? 10 : 2));
const VERSION = (process.env.E2E_VERSIONS ?? '1.37.4').split(',')[0]!;
const DEBUG_PORT = Number(process.env.SOAK_DEBUG_PORT ?? 9339);
const EXT = path.join(ROOT, '.output', 'chrome-mv3');
const RUN = path.join(ROOT, '_testserver', 'soak', new Date().toISOString().replace(/[:.]/g, '-'));
const PROFILE = path.join(RUN, 'profile');
const PIN = '246810';
const TERMS = ['cloud', 'acme', 'bank', 'mail', 'corpus', 'zz-nothing', 'git', 'alpha', 'shop', 'pc-'];

test.setTimeout((MINUTES + 15) * 60_000);

test(`soak ${MINUTES} min on Vaultwarden ${VERSION}`, async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const creds = e2eCreds();
  await ensureAccounts(VERSION);
  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DEBUG_PORT}`, '--host-resolver-rules=MAP *.lw.test 127.0.0.1'],
  });
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url().slice(0, 50)}: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${p.url().slice(0, 50)}: ${String(e)}`));
  };
  const sw = async () => ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL((await sw()).url()).host;
  const tabIdOf = async (pg: Page) => {
    const url = pg.url();
    return (await (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).sort((a, b) => b.id! - a.id!)[0]?.id ?? 0, url)) as number;
  };
  const openPopup = async (target: Page) => {
    const tabId = await tabIdOf(target);
    const p = await ctx.newPage();
    watch(p);
    await p.setViewportSize({ width: 380, height: 600 });
    await p.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
    return p;
  };
  const corpus = async (file: string) => {
    const p = await ctx.newPage();
    watch(p);
    await p.goto(`http://corpus.lw.test:${CORPUS_PORT}/${file}`);
    await p.waitForLoadState('load');
    return p;
  };

  // ----- setup: sign in on the seeded 2,000+ item vault, turn on PIN -----
  const tabA = await corpus('stacked.html'); // long-lived: content script + in-page menu all run long
  const tabB = await corpus('stacked.html'); // reloaded every cycle for fills
  let p = await openPopup(tabA);
  await signIn(p, creds.main.email, creds.main.password, VERSION);
  await finishFirstRun(p);
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=security]');
  await p.locator('.set', { hasText: 'Unlock with a PIN' }).locator('.sw').click();
  await expect(p.locator('input[aria-label="New PIN digit 1"]')).toBeFocused();
  await p.keyboard.type(PIN);
  await expect(p.locator('input[aria-label="Repeat PIN digit 1"]')).toBeFocused();
  await p.keyboard.type(PIN);
  await p.click('button:has-text("Turn on PIN")');
  await expect(p.locator('#toast')).toContainText('PIN unlock is on');
  await p.close();
  await tabA.reload();
  await tabA.waitForLoadState('load');
  const lp = await openPopup(tabA); // long-lived popup, like a pop-out window left open
  await lp.waitForSelector('#q');

  // ----- sampling -----
  const t0 = Date.now();
  const rows: string[] = ['minute,cycles,sw_used_mb,sw_total_mb,popup_used_mb,tab_used_mb,process_mb,errors'];
  const series = { hours: [] as number[], sw: [] as number[], swHours: [] as number[], popup: [] as number[], tab: [] as number[], proc: [] as number[], procHours: [] as number[] };
  let cycles = 0;
  async function sample() {
    await lp.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' })).catch(() => {}); // wake the worker
    const [swh, ph, th] = [await workerHeap(DEBUG_PORT, extId).catch(() => null), await pageHeap(lp), await pageHeap(tabA)];
    const proc = processMemoryMB(PROFILE);
    const h = (Date.now() - t0) / 3_600_000;
    series.hours.push(h);
    if (swh) {
      series.sw.push(swh.usedMB);
      series.swHours.push(h);
    }
    series.popup.push(ph.usedMB);
    series.tab.push(th.usedMB);
    if (proc != null) {
      series.proc.push(proc);
      series.procHours.push(h);
    }
    rows.push([Math.round(h * 60), cycles, swh?.usedMB ?? '', swh?.totalMB ?? '', ph.usedMB, th.usedMB, proc ?? '', errors.length].join(','));
    fs.writeFileSync(path.join(RUN, 'samples.csv'), rows.join('\n') + '\n');
    console.log(`[soak] ${rows[rows.length - 1]}`);
  }
  await sample();
  let nextSample = t0 + EVERY * 60_000;

  // ----- the loop -----
  while (Date.now() - t0 < MINUTES * 60_000) {
    cycles++;
    // 1. fill from a short-lived popup (Enter fills the first login)
    await tabB.reload();
    await tabB.waitForLoadState('load');
    p = await openPopup(tabB);
    await p.waitForSelector('.card');
    await p.keyboard.press('Enter');
    await p.waitForEvent('close', { timeout: 5000 }).catch(() => p.close());
    await expect(tabB.locator('#p')).not.toHaveValue('', { timeout: 5000 });
    // 2. copy from a short-lived popup
    p = await openPopup(tabB);
    await p.locator('.card').first().locator('.stub', { hasText: 'Password' }).click();
    await expect(p.locator('#toast')).toContainText('copied');
    await p.close();
    // 3. search in the long-lived popup
    const term = TERMS[cycles % TERMS.length]!;
    await lp.fill('#q', term);
    await lp.waitForTimeout(150);
    await lp.fill('#q', '');
    // 4. in-page menu in the long-lived tab
    await clickIcon(tabA, '#u');
    await surface(tabA, 'menu');
    await tabA.keyboard.press('Escape');
    await expect.poll(() => gone(tabA, 'menu'), { timeout: 5000 }).toBe(true);
    // 5. sync every 3rd cycle, lock and unlock with the PIN every 5th
    if (cycles % 3 === 0) {
      await lp.click('button[aria-label="Sync now"]');
      await expect(lp.locator('button[aria-label="Sync now"]')).toBeEnabled({ timeout: 30_000 });
    }
    if (cycles % 5 === 0) {
      await lp.click('button[aria-label="Lock"]');
      await expect(lp.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
      await lp.keyboard.type(PIN);
      await expect(lp.locator('#q')).toBeVisible({ timeout: 15_000 });
    }
    if (Date.now() >= nextSample) {
      await sample();
      nextSample += EVERY * 60_000;
    }
  }
  await sample();

  // ----- verdict -----
  const warm = Math.min(0.5, (MINUTES / 60) * 0.2); // first 20% of the run, capped at 30 minutes
  const summary = {
    version: VERSION,
    minutes: MINUTES,
    sampleEveryMin: EVERY,
    cycles,
    warmupHours: warm,
    consoleErrors: errors.length,
    serviceWorker: judge(series.swHours, series.sw, warm),
    longLivedPopup: judge(series.hours, series.popup, warm),
    longLivedTab: judge(series.hours, series.tab, warm),
    processTotal: judge(series.procHours, series.proc, warm),
  };
  fs.writeFileSync(path.join(RUN, 'summary.json'), JSON.stringify({ ...summary, errors: errors.slice(0, 50) }, null, 2));
  console.log('[soak] summary ' + JSON.stringify(summary, null, 2));
  await ctx.close();
  // Process memory is reported, not judged: Chrome's own caches grow and shrink on their own schedule.
  for (const k of ['serviceWorker', 'longLivedPopup', 'longLivedTab'] as const) expect(summary[k].pass, `${k} heap grew: ${JSON.stringify(summary[k])}`).not.toBe(false);
  expect(errors, 'console errors during the soak').toEqual([]);
});
