// SPDX-License-Identifier: GPL-3.0-only
// One user's session, in order: first run on the 2,000+ item vault, PIN, fill on every corpus page, copy and
// clipboard clearing, search, lock and unlock, a killed service worker, the server going away, and timing.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { totp } from '../../src/core/totp';
import { CORPUS, CORPUS_PORT, OTHER, e2eCreds } from './accounts';
import { ensureFolders } from './inpage-helpers';
import { EXT, expect, test } from './fixtures';
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
  // Each digit shows briefly as it's typed, then turns into a dot.
  const box = (n: number) => p.locator(`input[aria-label="Repeat PIN digit ${n}"]`);
  await p.keyboard.type('13');
  await expect(box(1)).toHaveClass(/masked/);
  await expect(box(2)).not.toHaveClass(/masked/);
  await shot(p, 'settings-pin-reveal');
  await expect(box(2)).toHaveClass(/masked/, { timeout: 2000 });
  expect(await box(2).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-text-security'))).toBe('disc');
  await p.keyboard.type('5790');
  await shot(p, 'settings-pin-masked');
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

test('fill: a login for another site asks first (fill here, or open its site); a page with no form says so', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${OTHER}/stacked.html`);
  const p = await popup(page);
  await expect(p.locator('.card')).toHaveCount(1); // Carol, saved for this site
  await expect(p.locator('#q')).toBeFocused();
  await p.keyboard.type('corpus bob');
  await expect(p.locator('.row').first()).toContainText('Corpus · Bob');
  await expect(p.locator('.row.is-sel')).toContainText('Corpus · Bob');
  await p.keyboard.press('Enter');
  await expect(p.locator('#confirm')).toContainText("login and you're on frames.example-lw.test");
  await expect(p.locator('#confirm .c-ok')).toHaveText('Open corpus.lw.test');
  await shot(p, 'confirm-site-light', 1);
  await p.locator('#confirm button', { hasText: 'Fill here' }).click();
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

/** What the corpus serves at a site's "/" (a tab the extension opens loads before Playwright can route it). */
async function root(site: string, page: string | null) {
  await fetch(`http://127.0.0.1:${CORPUS_PORT}/__root?host=${new URL(site).host}${page ? `&page=${page}` : ''}`);
}
test.afterAll(async () => {
  for (const site of [CORPUS, OTHER]) await root(site, null).catch(() => {});
});

test("open and fill: the sheet, the row icon and Alt O open the login's site in a new tab and fill it", async ({ popup, ctx, extId, sw }) => {
  const page = await ctx.newPage();
  await page.goto(`${OTHER}/none.html`);
  /** Do `act` in the popup; return the tab it opens once the popup has closed. */
  const opens = async (p: Page, act: () => Promise<void>) => {
    const tab = ctx.waitForEvent('page', { predicate: (t) => !t.url().startsWith('chrome-extension://') });
    const closed = p.isClosed() ? Promise.resolve() : p.waitForEvent('close', { timeout: 5000 });
    // The popup closes as soon as the tab opens, which can be before a key press has finished (keyup).
    await act().catch((e) => {
      if (!p.isClosed()) throw e;
    });
    const t = await tab;
    await closed;
    return t;
  };
  const search = async (p: Page, q: string) => {
    await expect(p.locator('#q')).toBeFocused();
    await p.keyboard.type(q);
  };

  // The "sites don't match" sheet: Enter takes its main button, Open.
  let p = await popup(page);
  await search(p, 'corpus bob');
  await expect(p.locator('.row.is-sel')).toContainText('Corpus · Bob');
  await p.keyboard.press('Enter');
  await expect(p.locator('#confirm .c-ok')).toHaveText('Open corpus.lw.test');
  let t = await opens(p, () => p.keyboard.press('Enter'));
  await expect(t).toHaveURL(`${CORPUS}/`);
  await expect(t.locator('#u')).toHaveValue('bob');
  await expect(t.locator('#p')).toHaveValue('bob-S3cret!');
  await expect(page.locator('body')).not.toContainText('bob'); // the page the popup was on is left alone
  // It opens next to the tab the popup was on.
  const idx = await (await sw()).evaluate(async (urls) => { const all = await chrome.tabs.query({}); return urls.map((u) => all.find((x) => x.url === u)?.index ?? -1); }, [page.url(), t.url()]);
  expect(idx[1]).toBe(idx[0]! + 1);
  await t.close();

  // The row icon: only on the selected row and the one under the mouse. 2FA logins copy the code, as a fill does.
  p = await popup(page);
  await search(p, 'corpus');
  await expect(p.locator('.row.is-sel .ib.launch')).toBeVisible();
  const alice = p.locator('.row:not(.is-sel)', { hasText: 'Corpus · Alice' });
  await expect(alice.locator('.ib.launch')).toBeHidden();
  await alice.hover();
  await expect(alice.locator('.ib.launch')).toHaveAttribute('title', 'Open corpus.lw.test and fill (Alt O)');
  await shot(p, 'row-open-light', 1);
  t = await opens(p, () => alice.locator('.ib.launch').click());
  await expect(t.locator('#p')).toHaveValue('alice-Pa55-word');
  await expect.poll(() => clipboard(ctx, extId), { timeout: 10_000 }).toMatch(/^\d{6}$/);
  await t.close();

  // Alt O on the selected row. A login whose page sends you on to another site gets nothing.
  await root(CORPUS, 'go-other.html');
  p = await popup(page);
  await search(p, 'corpus bob');
  await expect(p.locator('.row.is-sel')).toContainText('Corpus · Bob');
  t = await opens(p, () => p.keyboard.press('Alt+o'));
  await expect(t).toHaveURL(`${OTHER}/stacked.html`);
  await t.waitForTimeout(3000);
  await expect(t.locator('#u')).toHaveValue('');
  await t.close();

  // An app that draws the form late and then draws it again (spa.html): the fill lands on the form that stays.
  await root(CORPUS, 'spa.html');
  p = await popup(page);
  await search(p, 'corpus bob');
  t = await opens(p, () => p.keyboard.press('Alt+o'));
  await expect(t.locator('body')).toHaveAttribute('data-render', '2');
  await expect(t.locator('[name=pw]')).toHaveValue('bob-S3cret!');
  await expect(t.locator('[name=email]')).toHaveValue('bob');
  await t.close();
  await root(CORPUS, null);

  // The item view's "sites don't match" sheet offers it too.
  p = await popup(page);
  await search(p, 'corpus bob');
  await p.keyboard.press('Alt+e');
  await p.locator('.dock .btn', { hasText: 'Fill on frames.example-lw.test' }).click();
  await expect(p.locator('.sheet .c-ok')).toHaveText('Open corpus.lw.test');
  t = await opens(p, () => p.locator('.sheet .c-ok').click());
  await expect(t.locator('#p')).toHaveValue('bob-S3cret!');
  await t.close();
  await page.close();
});

test("open and fill: a sign-in form framed from the login's own site fills without asking; another site's doesn't", async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${CORPUS}/none.html`);
  // Carol's login is for frames.example-lw.test (base domain example-lw.test): login.example-lw.test is hers.
  await root(OTHER, 'framed-own.html');
  const open = async () => {
    const p = await popup(page);
    await expect(p.locator('#q')).toBeFocused();
    await p.keyboard.type('frames carol');
    await expect(p.locator('.row.is-sel')).toContainText('Frames · Carol');
    const tab = ctx.waitForEvent('page', { predicate: (t) => !t.url().startsWith('chrome-extension://') });
    // The popup closes as soon as the tab opens, which can be before the key press has finished (keyup).
    await p.keyboard.press('Alt+o').catch((e) => {
      if (!p.isClosed()) throw e;
    });
    const t = await tab;
    await expect.poll(() => t.frames().length).toBe(2);
    return t;
  };
  let t = await open();
  await expect.poll(() => t.frames()[1]!.locator('#p').inputValue().catch(() => '')).toBe('carol-Fr4me');
  await t.close();
  await root(OTHER, 'framed-other.html');
  t = await open();
  await t.waitForTimeout(3000);
  expect(await t.frames()[1]!.locator('#p').inputValue()).toBe('');
  await t.close();
  await root(OTHER, null);
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

test('folders: the rail filters the list and search, sticks across opens, Alt+arrows step; site cards stay', async ({ popup, corpus }) => {
  await ensureFolders();
  const page = await corpus('stacked.html');
  let p = await popup(page);
  watchErrors(p, errors);
  await p.click('button[aria-label="Sync now"]');
  await expect(p.locator('#toast')).toContainText('Vault synced');
  const rail = p.locator('.rail');
  await expect(rail.locator('.chip')).toHaveText([/^All\s*[\d,]+$/, /E2E Crypto\s*1$/, /E2E Rental\s*1$/, /^No folder\s*[\d,]+$/]);
  await expect(rail.locator('.chip.on')).toHaveText(/^All/);
  // The unfiltered list names the folder in place of the site.
  await p.fill('#q', 'carol');
  await expect(p.locator('.row').first().locator('.un')).toContainText('carol@frames.test');
  await p.fill('#q', 'rental');
  await expect(p.locator('.row').first()).toContainText('Frames · Carol');
  await expect(p.locator('.row').first().locator('.fd mark')).toHaveText('Rental');
  await p.fill('#q', '');
  await shot(p, 'folders-all-light', 1);

  await rail.locator('.chip', { hasText: 'E2E Crypto' }).click();
  await expect(p.locator('#q')).toBeFocused();
  await expect(p.locator('#q')).toHaveAttribute('placeholder', 'Search E2E Crypto');
  // This site's logins still show on top (Bob isn't in the folder); below, only the folder.
  await expect(p.locator('.card')).toHaveCount(2);
  await expect(p.locator('div.sec', { hasText: 'Recently used' })).toHaveCount(0);
  await expect(p.locator('div.sec').last()).toHaveText(/E2E Crypto\s*1/);
  await expect(p.locator('.list .row')).toHaveCount(1);
  await expect(p.locator('.list .row')).toContainText('Corpus · Alice');
  await shot(p, 'folders-picked-light', 1);
  // Search stays inside the folder, with a way out.
  await p.keyboard.type('bob');
  await expect(p.locator('.nomatch')).toContainText('in E2E Crypto');
  await p.click('button:has-text("Search all folders")');
  await expect(rail.locator('.chip.on')).toHaveText(/^All/);
  await expect(p.locator('.row').first()).toContainText('Corpus · Bob');
  await p.fill('#q', '');
  await rail.locator('.chip', { hasText: 'E2E Rental' }).click();
  await p.close();

  // The pick sticks for the next popup; Alt+arrows step through the rail and wrap.
  p = await popup(page);
  await expect(p.locator('.rail .chip.on')).toHaveText(/E2E Rental/);
  await expect(p.locator('.list .row')).toHaveCount(1);
  await p.keyboard.press('Alt+ArrowRight');
  await expect(p.locator('.rail .chip.on')).toHaveText(/^No folder/);
  await p.keyboard.press('Alt+ArrowRight');
  await expect(p.locator('.rail .chip.on')).toHaveText(/^All/);
  await p.keyboard.press('Alt+ArrowLeft');
  await expect(p.locator('.rail .chip.on')).toHaveText(/^No folder/);
  // Enter still fills this site's first login with a folder picked.
  await p.keyboard.press('Enter');
  await expect(page.locator('#u')).toHaveValue(/alice|bob/);
  await p.close().catch(() => {});

  // Back to All for the tests after this one.
  p = await popup();
  await p.locator('.rail .chip', { hasText: 'All' }).click();
  await expect(p.locator('.rail .chip.on')).toHaveText(/^All/);
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

test("unlock screen: the account's picture is its email domain's favicon, from the user's server", async ({ popup, corpus, ctx, sw }) => {
  // The test servers don't download icons (every domain gets the fallback), so serve one for the email's domain.
  const domain = creds.main.email.split('@')[1]!;
  const fav = fs.readFileSync(path.join(EXT, 'icon', '32.png'));
  const seen: string[] = [];
  await ctx.route(`**/icons/${domain}/icon.png`, (r) => (seen.push(r.request().url()), r.fulfill({ status: 200, contentType: 'image/png', body: fav })));
  try {
    // Favicons are cached for the browser session; earlier tests cached "no icon" for this domain.
    await (await sw()).evaluate(() => chrome.storage.session.remove('iconCache'));
    const page = await corpus('stacked.html');
    const p = await popup(page);
    await p.click('button[aria-label="Lock"]');
    await expect(p.locator('.acct .av.fav img')).toBeVisible();
    expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/icons\//); // the user's own server, nobody else
    await expect(p.locator('.acct .av')).not.toContainText(/\w/);
    await shot(p, 'unlock-avatar-light');
    await p.keyboard.type('135790');
    await expect(p.locator('#q')).toBeVisible({ timeout: 15_000 });
    await p.close();
    await page.close();
  } finally {
    await ctx.unroute(`**/icons/${domain}/icon.png`);
  }
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
