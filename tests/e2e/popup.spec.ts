// SPDX-License-Identifier: GPL-3.0-only
// One user's session, in order: first run on the 2,000+ item vault, PIN, fill on every corpus page, copy and
// clipboard clearing, search, lock and unlock, a killed service worker, the server going away, and timing.
import type { Page } from '@playwright/test';
import { totp } from '../../src/core/totp';
import { CORPUS_PORT, OTHER, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { clipboard, finishFirstRun, shot, signIn, signOut, testServer, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ popup }) => signOut(() => popup()));

const creds = e2eCreds();
const errors: string[] = [];

/** Open the popup over `page`, then fill with Enter (first login) or by clicking the card named `name`. */
async function fillFrom(popup: (t?: Page) => Promise<Page>, page: Page, name?: string) {
  const p = await popup(page);
  watchErrors(p, errors);
  await p.waitForSelector('.card, .empty, .row');
  if (name) await p.locator('.card', { hasText: name }).click();
  else await p.keyboard.press('Enter');
  await p.waitForEvent('close', { timeout: 3000 }).catch(async () => console.log(`popup still open over ${page.url()}: toast "${await p.locator('#toast').innerText().catch(() => '')}"`));
  return p;
}

test.afterAll(() => {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
});

test('first run: server check, sign in, decrypt progress, then the site logins', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await expect(p.locator('.fr-done h2')).toHaveText("You're in");
  await finishFirstRun(p);
  await expect(p.locator('div.sec').first()).toContainText('corpus.lw.test');
  await expect(p.locator('.card')).toHaveCount(2);
  await expect(p.locator('.card').first()).toContainText('Corpus · Alice');
  await expect(p.locator('#q')).toBeFocused();
  await shot(p, 'main-light');
  await p.close();
  await page.close();
});

test('settings: turn on PIN unlock', async ({ popup }) => {
  const p = await popup();
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=security]');
  await p.locator('.set', { hasText: 'Unlock with a PIN' }).locator('.sw').click();
  await expect(p.locator('input[aria-label="New PIN digit 1"]')).toBeFocused();
  await p.keyboard.type('135790');
  await expect(p.locator('.sheet')).toContainText('Type it once more');
  await expect(p.locator('input[aria-label="Repeat PIN digit 1"]')).toBeFocused();
  await p.keyboard.type('135790');
  await p.click('button:has-text("Turn on PIN")');
  await expect(p.locator('#toast')).toContainText('PIN unlock is on');
  await shot(p, 'settings-light');
  await p.close();
});

const FILLS: Array<[string, (pg: Page) => Promise<unknown>, unknown]> = [
  ['stacked.html', (pg) => pg.evaluate(() => [(document.getElementById('u') as HTMLInputElement).value, (document.getElementById('p') as HTMLInputElement).value]), ['alice@corpus.test', 'alice-Pa55-word']],
  [
    'unlabeled.html',
    (pg) => pg.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value)),
    ['', 'alice@corpus.test', 'alice-Pa55-word'],
  ],
  ['password-only.html', (pg) => pg.evaluate(() => (document.getElementById('p') as HTMLInputElement).value), 'alice-Pa55-word'],
  [
    'signup.html',
    (pg) => pg.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value)),
    ['alice@corpus.test', '', ''],
  ],
  [
    'change-password.html',
    (pg) => pg.evaluate(() => [...document.querySelectorAll('input[type=password]')].map((i) => (i as HTMLInputElement).value)),
    ['alice-Pa55-word', '', ''],
  ],
  [
    'shadow.html',
    (pg) =>
      pg.evaluate(() => {
        const r = document.querySelector('x-login')!.shadowRoot!;
        return [(r.getElementById('u') as HTMLInputElement).value, (r.querySelector('x-pass')!.shadowRoot!.getElementById('p') as HTMLInputElement).value];
      }),
    ['alice@corpus.test', 'alice-Pa55-word'],
  ],
  [
    'iframe.html',
    (pg) => pg.frames()[1]!.evaluate(() => [(document.getElementById('u') as HTMLInputElement).value, (document.getElementById('p') as HTMLInputElement).value]),
    ['alice@corpus.test', 'alice-Pa55-word'],
  ],
];

for (const [file, read, want] of FILLS) {
  test(`fill: ${file}`, async ({ popup, corpus }) => {
    const page = await corpus(file);
    await page.waitForLoadState('load');
    await fillFrom(popup, page);
    await expect.poll(() => read(page)).toEqual(want);
    await page.close();
  });
}

test('fill: SPA that re-renders its form fills the live fields', async ({ popup, corpus }) => {
  const page = await corpus('spa.html');
  await page.waitForFunction(() => document.body.dataset.render === '2');
  await fillFrom(popup, page);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value))).toEqual(['alice@corpus.test', 'alice-Pa55-word']);
  await page.close();
});

test('fill: React-style controlled inputs keep the values after re-render', async ({ popup, corpus }) => {
  const page = await corpus('react.html');
  await fillFrom(popup, page);
  await page.waitForTimeout(600);
  await expect(page.locator('#out')).toHaveText('{"u":"alice@corpus.test","p":"alice-Pa55-word"}');
  expect(await page.locator('#p').inputValue()).toBe('alice-Pa55-word');
  await page.close();
});

test('fill: two-step login fills the username page, then the password page', async ({ popup, corpus }) => {
  const page = await corpus('step1.html');
  await fillFrom(popup, page, 'Corpus · Alice');
  await expect(page.locator('#e')).toHaveValue('alice@corpus.test');
  await page.click('button[type=submit]');
  await page.waitForURL(/step2/);
  await fillFrom(popup, page, 'Corpus · Alice');
  await expect(page.locator('#p')).toHaveValue('alice-Pa55-word');
  await page.close();
});

test('fill: a form from another site in a frame asks first', async ({ popup, corpus }) => {
  const page = await corpus('cross.html');
  await page.frames()[1]?.waitForLoadState('load');
  await expect.poll(() => page.frames().length).toBe(2);
  const p = await fillFrom(popup, page);
  await expect(p.locator('#confirm')).toContainText('frames.example-lw.test');
  await shot(p, 'confirm-frame-light', 1);
  await p.click('#confirm .c-ok');
  await expect.poll(() => page.frames()[1]!.evaluate(() => (document.getElementById('p') as HTMLInputElement).value)).toBe('alice-Pa55-word');
  await page.close();
});

test('fill: a login for another site asks first; a page with no form says so', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${OTHER}/stacked.html`);
  const p = await popup(page);
  await expect(p.locator('.card')).toHaveCount(1); // Carol, saved for this site
  await expect(p.locator('#q')).toBeFocused();
  await p.keyboard.type('corpus bob');
  await expect(p.locator('.row').first()).toContainText('Corpus · Bob');
  await expect(p.locator('.row.is-sel')).toContainText('Corpus · Bob');
  await p.keyboard.press('Enter');
  await expect(p.locator('#confirm')).toContainText("The sites don't match");
  await p.keyboard.press('Enter');
  await p.waitForEvent('close', { timeout: 3000 }).catch(async () => console.log(`still open: toast "${await p.locator('#toast').innerText()}" confirm "${await p.locator('#confirm').innerText().catch(() => '')}"`));
  await expect(page.locator('#u')).toHaveValue('bob');
  await page.goto(`http://corpus.lw.test:${CORPUS_PORT}/none.html`);
  const p2 = await popup(page);
  await p2.waitForSelector('.card');
  await p2.keyboard.press('Enter');
  await expect(p2.locator('#toast')).toContainText('No login form found');
  await p2.close();
  await page.close();
});

test('copy: password stub copies and the clipboard clears after 30 s; 2FA code copies; fill copies the code', async ({ popup, corpus, ctx, extId }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page);
  await p.locator('.card', { hasText: 'Corpus · Alice' }).locator('.stub', { hasText: 'Password' }).click();
  await expect(p.locator('#toast')).toContainText('Password copied');
  await expect(p.locator('#toast .t-time')).toContainText('Clears in');
  await shot(p, 'copied-light', 1);
  expect(await clipboard(ctx, extId)).toBe('alice-Pa55-word');
  // TOTP stub: the code shown is the code copied.
  await p.bringToFront();
  const stub = p.locator('.card', { hasText: 'Corpus · Alice' }).locator('.stub').nth(2);
  await stub.click();
  const want = await totp('JBSWY3DPEHPK3PXP');
  const got = await clipboard(ctx, extId);
  expect([want, await totp('JBSWY3DPEHPK3PXP', Date.now() - 2000)]).toContain(got);
  // Clipboard clear: the alarm fires 30 s after the last copy.
  await page.waitForTimeout(33_000);
  expect(await clipboard(ctx, extId)).toBe('');
  await p.close();
  // Fill copies the 2FA code (setting on by default). Bob was used last, so his card is first now: click Alice.
  await fillFrom(popup, page, 'Corpus · Alice');
  await expect(page.locator('#p')).toHaveValue('alice-Pa55-word');
  expect(await clipboard(ctx, extId)).toMatch(/^\d{6}$/);
  await page.close();
});

test('search: notes match, keyboard copy, highlight, help overlay, no results', async ({ popup, corpus, ctx, extId }) => {
  const page = await corpus('none.html');
  const p = await popup(page);
  await expect(p.locator('#q')).toBeFocused();
  await p.keyboard.type('blue folder');
  const row = p.locator('.row').first();
  await expect(row).toContainText('Corpus · Alice');
  await expect(row.locator('.nt')).toContainText('blue folder');
  await shot(p, 'search-notes-light', 1);
  await p.keyboard.press('Alt+u');
  await expect(p.locator('#toast')).toContainText('Username copied');
  expect(await clipboard(ctx, extId)).toBe('alice@corpus.test');
  await p.bringToFront();
  await p.fill('#q', 'corpus');
  await expect(p.locator('div.sec').first()).toContainText('2 matches');
  await expect(p.locator('.row mark').first()).toBeVisible();
  await shot(p, 'search-light', 1);
  await p.fill('#q', 'zzqqxx-nothing');
  await expect(p.locator('.nomatch')).toContainText('No match for');
  await p.fill('#q', '');
  await p.keyboard.press('?');
  await expect(p.locator('#help.open')).toBeVisible();
  await shot(p, 'help-light', 1);
  await p.keyboard.press('Escape');
  await expect(p.locator('#help.open')).toHaveCount(0);
  await p.close();
  await page.close();
});

test('lock and unlock: PIN (wrong, then right), master password (wrong, then right)', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  let p = await popup(page);
  await p.click('button[aria-label="Lock"]');
  await expect(p.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
  await shot(p, 'unlock-pin-light');
  await p.keyboard.type('000000');
  await expect(p.locator('.field.err .f-msg')).toContainText('Wrong PIN');
  await p.keyboard.type('135790');
  await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
  await expect(p.locator('.card')).toHaveCount(2);
  await p.click('button[aria-label="Lock"]');
  await p.click('text=Use master password instead');
  await p.fill('#pw', 'not-the-password');
  await p.keyboard.press('Enter');
  await expect(p.locator('.field.err .f-msg')).toContainText("That's not the master password");
  await shot(p, 'unlock-wrong-light', 1);
  await p.fill('#pw', creds.main.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
  await p.close();
  p = await popup(page);
  await expect(p.locator('#q')).toBeVisible();
  await p.close();
  await page.close();
});

test('a killed service worker resumes the session without asking again', async ({ corpus, ctx, sw }) => {
  const page = await corpus('stacked.html');
  const before = await sw();
  const tabId = await before.evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).sort((a, b) => b.id! - a.id!)[0]!.id!, page.url());
  // Stop the worker the way chrome://serviceworker-internals does (what Chrome does to an idle worker).
  const internals = await ctx.newPage();
  await internals.goto('chrome://serviceworker-internals/');
  const extId = new URL(before.url()).host;
  const entry = internals.locator('.serviceworker-registration', { hasText: extId }).first();
  await entry.locator('cr-button[data-command="stop"]').click();
  await expect(entry.locator('.serviceworker-running-status .value')).toHaveText('STOPPED');
  await internals.setViewportSize({ width: 380, height: 600 });
  await internals.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  const p = internals;
  await expect(p.locator('.card')).toHaveCount(2);
  await p.locator('.card', { hasText: 'Corpus · Alice' }).click();
  await expect(page.locator('#p')).toHaveValue('alice-Pa55-word');
  await page.close();
});

test('server down: unlock still works, sync says so in plain words', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  testServer('stop');
  try {
    let p = await popup(page);
    await p.click('button[aria-label="Lock"]');
    await expect(p.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
    await p.keyboard.type('135790');
    await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
    await expect(p.locator('.card')).toHaveCount(2);
    await p.click('button[aria-label="Sync now"]');
    await expect(p.locator('#toast')).toContainText("Sync didn't work");
    await expect(p.locator('.warn')).toContainText("Can't reach");
    await shot(p, 'sync-error-light', 1);
    await p.close();
    p = await popup(page);
    await expect(p.locator('.warn')).toContainText("Can't reach");
    await p.close();
  } finally {
    testServer('start');
  }
  const p = await popup(page);
  await p.click('.warn button:has-text("Retry")');
  await expect(p.locator('.warn')).toHaveCount(0);
  await p.close();
  await page.close();
});

test('popup open time with the full vault (target < 150 ms)', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const p = await popup(page);
    await p.waitForSelector('.card');
    const t = await p.evaluate(() => performance.getEntriesByName('lw-interactive')[0]?.startTime ?? -1);
    times.push(Math.round(t));
    await p.close();
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  console.log(`popup interactive (ms from navigation start): ${times.join(', ')}; median ${median}`);
  expect(median).toBeLessThan(150);
  await page.close();
});

test('dark theme screenshots', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page, { theme: 'dark' });
  await p.waitForSelector('.card');
  await expect(p.locator('#q')).toBeFocused();
  await shot(p, 'main-dark');
  await p.keyboard.type('corpus');
  await shot(p, 'search-dark', 1);
  await p.fill('#q', '');
  await p.click('button[aria-label="Settings"]');
  await shot(p, 'settings-dark', 1);
  await p.click('button[aria-label="Back"]');
  await p.click('button[aria-label="Lock"]');
  await expect(p.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
  await shot(p, 'unlock-pin-dark');
  await p.keyboard.type('135790');
  await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
  await p.close();
  await page.close();
});

test('no console errors in any popup', () => {
  expect(errors).toEqual([]);
});
