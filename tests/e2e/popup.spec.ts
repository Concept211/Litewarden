// SPDX-License-Identifier: GPL-3.0-only
// One user's session, in order: first run on the 2,000+ item vault, PIN, fill on every corpus page, copy and
// clipboard clearing, search, lock and unlock, a killed service worker, the server going away, and timing.
import type { Page } from '@playwright/test';
import { totp } from '../../src/core/totp';
import { CORPUS_PORT, OTHER, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { clipboard, finishFirstRun, shot, signIn, signOut, testServer, watchErrors, budget } from './helpers';

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

test('popup frame keeps its set size (the toolbar popup sizes itself from it)', async ({ popup }) => {
  const p = await popup();
  await p.waitForSelector('#q');
  // Chrome opens the toolbar popup small and grows it to the page's size, so a height relative to the window collapses.
  await p.setViewportSize({ width: 380, height: 120 });
  const size = () => p.evaluate(() => [document.documentElement, document.body].map((e) => `${e.offsetWidth}x${e.offsetHeight}`).join(' '));
  expect(await size()).toBe('380x600 380x600');
  await p.close();
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

test('settings: About shows the beta version and Report a bug opens the issue form', async ({ popup, ctx }) => {
  const p = await popup();
  watchErrors(p, errors);
  await p.click('button[aria-label="Settings"]');
  await expect(p.locator('[data-cat=about]')).toContainText(/Version \d+\.\d+\.\d+ beta, GPLv3/);
  await p.click('[data-cat=about]');
  await expect(p.locator('.body')).toContainText(/Litewarden \d+\.\d+\.\d+ beta/);
  const [tab] = await Promise.all([ctx.waitForEvent('page'), p.locator('.set', { hasText: 'Report a bug' }).click()]);
  // Signed out, GitHub shows its sign-in page first and returns to the form after.
  await expect.poll(() => decodeURIComponent(tab.url())).toContain('github.com/Concept211/Litewarden/issues/new/choose');
  await shot(p, 'settings-about');
  await tab.close();
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
  // No form: the popup offers to teach the site instead of failing quietly.
  await expect(p2.locator('#confirm')).toContainText('No login form found');
  await expect(p2.locator('#confirm .c-ok')).toHaveText('Teach this site');
  await p2.close();
  await page.close();
});

test('copy: password stub copies and the clipboard clears after 30 s; 2FA code copies; fill copies the code', async ({ popup, corpus, ctx, extId, sw }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page);
  await p.locator('.card', { hasText: 'Corpus · Alice' }).locator('.stub', { hasText: 'Password' }).click();
  await expect(p.locator('#toast')).toContainText('Password copied');
  await expect(p.locator('#toast .t-time')).toContainText('Clears in');
  await shot(p, 'copied-light', 1);
  // The popup shows "copied" only after its write resolved, but reading from another tab right away races the
  // write on a slow machine: poll.
  await expect.poll(() => clipboard(ctx, extId)).toBe('alice-Pa55-word');
  // TOTP stub: the code shown is the code copied.
  await p.bringToFront();
  const stub = p.locator('.card', { hasText: 'Corpus · Alice' }).locator('.stub').nth(2);
  await stub.click();
  // Wait for the popup's own confirmation before reading from another tab: bringing that tab forward takes focus
  // from the popup, and navigator.clipboard.writeText refuses to write from an unfocused document.
  await expect(p.locator('#toast')).toContainText(/Code \d{3} \d{3} copied/);
  await expect
    .poll(async () => {
      const got = await clipboard(ctx, extId);
      return [await totp('JBSWY3DPEHPK3PXP'), await totp('JBSWY3DPEHPK3PXP', Date.now() - 2000)].includes(got);
    })
    .toBe(true);
  // Clipboard clear: the alarm fires 30 s after the last copy. Chrome doesn't promise alarms to the second, so
  // after 30 s allow a few more for it to land.
  const copiedAt = Date.now();
  await page.waitForTimeout(30_000);
  try {
    await expect.poll(() => clipboard(ctx, extId), { timeout: 15_000 }).toBe('');
  } catch (e) {
    // Evidence for an intermittent CI failure: is the clear alarm still pending (late) or gone (fired, clear lost)?
    const w = await sw();
    const alarms = await w.evaluate(() => chrome.alarms.getAll());
    const offscreen = await w.evaluate(() => chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] }).then((c) => c.length)).catch(() => 'n/a');
    console.log(`clipboard not cleared ${Date.now() - copiedAt} ms after the copy; alarms: ${JSON.stringify(alarms.map((a) => ({ name: a.name, inMs: Math.round(a.scheduledTime - Date.now()) })))}; offscreen docs: ${offscreen}`);
    throw e;
  }
  await p.close();
  // Fill copies the 2FA code (setting on by default). Bob was used last, so his card is first now: click Alice.
  await fillFrom(popup, page, 'Corpus · Alice');
  await expect(page.locator('#p')).toHaveValue('alice-Pa55-word');
  await expect.poll(() => clipboard(ctx, extId)).toMatch(/^\d{6}$/);
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
  // The boxes clear and take the focus back right after the error shows: type once they have it, as a person would.
  await expect(p.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
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

test('Lock right as the popup opens stays locked: nothing writes the session or index back', async ({ popup, corpus, sw }) => {
  // Regression: the popup's start-up "touch" read the session, awaited, then wrote it back; a Lock in between was
  // undone (CI, 1.36.0). Background syncs and live pushes had the same shape.
  const page = await corpus('stacked.html');
  for (let i = 0; i < 8; i++) {
    const p = await popup(page);
    await p.locator('button[aria-label="Lock"]').click();
    await expect(p.locator('input[aria-label="PIN digit 1"]')).toBeFocused();
    await p.waitForTimeout(400);
    const left = await (await sw()).evaluate(() => chrome.storage.session.get(['session', 'index', 'notes', 'recentItems', 'tabMatches']));
    expect(Object.keys(left).filter((k) => left[k] != null && !(typeof left[k] === 'object' && !Array.isArray(left[k]) && Object.keys(left[k]).length === 0)), `round ${i + 1}: left after lock`).toEqual([]);
    await p.keyboard.type('135790');
    await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
    await p.close();
  }
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
  console.log(`popup interactive (ms from navigation start): ${times.join(', ')}; median ${median}; budget ${budget(150).toFixed(0)}`);
  expect(median).toBeLessThan(budget(150));
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
