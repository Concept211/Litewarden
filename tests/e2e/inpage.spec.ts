// SPDX-License-Identifier: GPL-3.0-only
// In-page Litewarden, as a user meets it: field icons, the menu (placement that covers nothing, at three window
// widths), Esc and outside clicks, filling from the menu, the save and update prompts (checked on the server),
// "never for this site", saving while locked, an SPA login over fetch, and "teach this site" end to end.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { EXT, expect, test } from './fixtures';
import { finishFirstRun, shot, signIn, signOut, watchErrors, budget } from './helpers';
import { clickIcon, contentCost, frameBox, gone, icons, overlaps, protectedBoxes, serverLogins, surface, tabIdOf, pressOrExplain, createLogins } from './inpage-helpers';

// Independent tests: each opens its own page. Sign-in happens per worker in beforeAll, so after a failure
// Playwright's fresh worker signs in again and the rest of the file still runs (serial mode would skip it).
test.describe.configure({ mode: 'default' });

const creds = e2eCreds();
const errors: string[] = [];
const C = (f: string) => `http://corpus.lw.test:${CORPUS_PORT}/${f}`;
const SAVE = (host: string, f: string) => `http://${host}.save-lw.test:${CORPUS_PORT}/${f}`;

test.beforeAll(async ({ popup, ctx }) => {
  await signOut(() => popup());
  // Popup tabs left open by earlier spec files stop Playwright's input from reaching extension frames in other
  // tabs (a harness quirk; the real toolbar popup and pop-out window don't do it). Start clean.
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  // The test servers don't download icons (every site gets the fallback): give the test sites one, so the cards
  // show a site's favicon beside its name as they do for real sites.
  const fav = fs.readFileSync(path.join(EXT, 'icon', '32.png'));
  await ctx.route(/\/icons\/[^/]*lw\.test\/icon\.png$/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: fav }));
  const p0 = await page(ctx, C('stacked.html'));
  const p = await popup(p0);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.close();
  await p0.close();
});
test.afterAll(() => {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  expect(errors, 'console errors').toEqual([]);
});

async function page(ctx: import('@playwright/test').BrowserContext, url: string, width = 1100, height = 760): Promise<Page> {
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.setViewportSize({ width, height });
  await p.goto(url);
  return p;
}

/** Assert the menu (or any surface) covers no form control and stays inside the viewport. */
async function assertCoversNothing(p: Page, box: { x: number; y: number; w: number; h: number }, scope?: string) {
  const vp = p.viewportSize()!;
  expect(box.x, 'inside the window (left)').toBeGreaterThanOrEqual(0);
  expect(box.y, 'inside the window (top)').toBeGreaterThanOrEqual(0);
  expect(box.x + box.w, 'inside the window (right)').toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.h, 'inside the window (bottom)').toBeLessThanOrEqual(vp.height + 0.5);
  for (const b of await protectedBoxes(p, scope)) expect(overlaps(box, b), `covers ${b.label}`).toBe(false);
}

test('field icons: in the username and password fields, clear of the eye button', async ({ ctx }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  const [u, pw] = await icons(p);
  const uf = (await p.locator('#u').boundingBox())!;
  const pf = (await p.locator('#p').boundingBox())!;
  const eye = (await p.locator('.eye').boundingBox())!;
  // inside its field, vertically centered
  expect(u!.y).toBeGreaterThan(uf.y);
  expect(u!.y + u!.h).toBeLessThan(uf.y + uf.height);
  expect(u!.x + u!.w).toBeLessThanOrEqual(uf.x + uf.width);
  expect(Math.abs(pw!.y + pw!.h / 2 - (pf.y + pf.height / 2))).toBeLessThan(1.5);
  // never over the page's own eye button
  expect(pw!.x + pw!.w, 'password icon ends before the eye').toBeLessThanOrEqual(eye.x - 2);
  // focusing a field opens nothing
  await p.click('#u');
  await p.waitForTimeout(600);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await shot(p, 'inpage-icons-light', 2);
  await p.close();
});

for (const width of [1100, 760, 420]) {
  for (const field of ['#u', '#p']) {
    test(`menu at ${width}px from ${field === '#u' ? 'username' : 'password'}: covers nothing`, async ({ ctx }) => {
      const p = await page(ctx, C('stacked.html'), width);
      await expect.poll(async () => (await icons(p)).length).toBe(2);
      await clickIcon(p, field);
      const m = await surface(p, 'menu');
      await expect(m.locator('.m-row').first()).toBeVisible();
      // the frame settles at the menu's natural height
      await p.waitForTimeout(300);
      const box = await frameBox(m);
      await assertCoversNothing(p, box);
      if (width === 1100 && field === '#u') await shot(p, 'inpage-menu-light', 2);
      await p.close();
    });
  }
}

test('menu: Esc closes, the field stays usable, an outside click closes', async ({ ctx }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('input[aria-label="Filter logins"]')).toBeFocused();
  // type to filter
  await p.keyboard.type('bob');
  await expect(m.locator('.m-row')).toHaveCount(1);
  await p.keyboard.press('Escape');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  // the keyboard goes back to the field the menu belonged to
  await expect(p.locator('#u')).toBeFocused();
  // the field under the menu still takes clicks and typing
  await clickIcon(p, '#u');
  await surface(p, 'menu');
  await p.click('#u');
  await p.keyboard.type('typed');
  await expect(p.locator('#u')).toHaveValue('typed');
  expect(await gone(p, 'menu')).toBe(false);
  await p.mouse.click(30, 700);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await p.close();
});

test('menu whose record is gone (expired, extension updated): says so, not "locked", and still closes', async ({ ctx, sw }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await (await sw()).evaluate(() => chrome.storage.session.set({ surfaces: {} }));
  // Wipe the record between "open" and the menu's first request: forget every record the moment one is written.
  await (await sw()).evaluate(() => {
    const on = (ch: Record<string, chrome.storage.StorageChange>) => {
      if (ch.surfaces && Object.keys(ch.surfaces.newValue ?? {}).length) void chrome.storage.session.set({ surfaces: {} });
    };
    chrome.storage.onChanged.addListener(on);
    (globalThis as unknown as { __lwOff: () => void }).__lwOff = () => chrome.storage.onChanged.removeListener(on);
  });
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-msg')).toContainText('expired');
  await expect(m.locator('text=Litewarden is locked')).toHaveCount(0);
  await m.locator('button', { hasText: 'Close' }).focus();
  await p.keyboard.press('Escape');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await (await sw()).evaluate(() => (globalThis as unknown as { __lwOff: () => void }).__lwOff());
  // Back to normal: the next menu lists the logins.
  await clickIcon(p, '#u');
  await expect((await surface(p, 'menu')).locator('.m-row')).toHaveCount(2);
  await p.close();
});

test('menu: Enter fills the first login, arrows pick another, the menu closes', async ({ ctx }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#p');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-row')).toHaveCount(2);
  await expect(m.locator('.m-row .code').first()).toHaveText(/^\d{3} \d{3}$/);
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await expect(p.locator('#u')).toHaveValue('bob');
  await expect(p.locator('#p')).toHaveValue('bob-S3cret!');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  // click fills too
  await clickIcon(p, '#u');
  const m2 = await surface(p, 'menu');
  // A click that lands the instant the menu appears is ignored on purpose (clickjacking guard); people take longer.
  await p.waitForTimeout(350);
  await m2.locator('.m-row', { hasText: 'Alice' }).click();
  await expect(p.locator('#u')).toHaveValue('alice@corpus.test');
  await p.close();
});

// ---------- save and update prompts ----------

const RUN = Date.now().toString(36);
const NEW_USER = `new-${RUN}@shop.test`;

async function submitLogin(p: Page, user: string, pw: string) {
  await p.fill('#u', user);
  await p.fill('#p', pw);
  await p.click('button[type=submit]');
}

test('save prompt: a new login, after the form navigates; it lands on the server', async ({ ctx }) => {
  const p = await page(ctx, SAVE('shop', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await submitLogin(p, NEW_USER, 'Shop-Pa55-2026');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-head b')).toContainText('Save login for shop.save-lw.test?');
  await expect(f.locator('.p-head .site img')).toBeVisible();
  await expect(f.locator('input[aria-label=Username]')).toHaveValue(NEW_USER);
  await expect(f.locator('input[aria-label=Password]')).toHaveValue('Shop-Pa55-2026');
  await p.waitForTimeout(300);
  await assertCoversNothing(p, await frameBox(f), 'main');
  await shot(p, 'inpage-save-light', 2);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText('Login saved');
  const mine = async () => (await serverLogins('shop.save-lw.test')).filter((x) => x.username === NEW_USER && !x.deleted);
  await expect.poll(async () => (await mine()).map((x) => x.password)).toEqual(['Shop-Pa55-2026']);
  // the confirmation closes with X
  await f.locator('button[aria-label="Not now"]').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  // the same login again: nothing new, no prompt
  await p.goto(SAVE('shop', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2); // ready, as a user would see it
  await submitLogin(p, NEW_USER, 'Shop-Pa55-2026');
  await p.waitForURL(/welcome\.html/);
  await p.waitForTimeout(1500);
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  await p.close();
});

test('Google-style two-page sign-in: the save card has the username (Enter, "Next" button, account chooser)', async ({ ctx }) => {
  // Google: Enter on the email page is caught by script (no submit), "Next" is type=button, the page swaps in place,
  // and after "Choose an account" the address is only text above the password box. The footer has another address.
  const cases = [
    { host: 'genter', q: '?nochip=1', user: `enter-${RUN}@gmail.test`, go: (p: Page) => p.press('#identifierId', 'Enter') },
    { host: 'gnext', q: '?nochip=1', user: `next-${RUN}@gmail.test`, go: (p: Page) => p.click('#identifierNext span') },
    { host: 'gpick', q: '?chooser=1', user: 'bob-pick@gmail.test', go: (p: Page) => p.click('.tile[data-identifier^=bob] div >> nth=1') },
  ];
  for (const c of cases) {
    const p = await page(ctx, SAVE(c.host, `google-signin.html${c.q}`));
    if (!c.q.includes('chooser')) await p.fill('#identifierId', c.user);
    await c.go(p);
    await expect.poll(async () => (await icons(p)).length).toBe(1); // the password page is ready, as a user would see it
    await p.fill('#pw', `G-${c.host}-Pa55`);
    await p.click('#passwordNext span');
    await p.waitForURL(/welcome\.html/);
    const f = await surface(p, 'prompt');
    await expect(f.locator('input[aria-label=Username]'), c.host).toHaveValue(c.user);
    await p.waitForTimeout(600); // past the card's click guard
    await f.locator('button[aria-label="Not now"]').click();
    await expect.poll(() => gone(p, 'prompt')).toBe(true);
    await p.close();
  }
});

test('a site with many saved logins: submitting one that exists gives no prompt', async ({ ctx, popup }) => {
  // Regression: the save check only looked at the first 40 logins for the site (by name), so an existing login
  // further down the list got a "Save login" prompt.
  const host = `many${RUN}`.toLowerCase();
  const url = SAVE(host, 'login-nav.html');
  await createLogins([
    ...Array.from({ length: 45 }, (_, i) => ({ name: `A many ${String(i).padStart(2, '0')}`, username: `filler-${i}`, password: `F-${i}`, uri: url })),
    { name: 'Zz the one', username: `zz-${RUN}`, password: 'Zz-Pa55', uri: url },
  ]);
  const s = await popup();
  // Sync through the worker and check its answer. (The popup's "Vault synced" toast is gone within a second, which a
  // slow runner can miss; what matters here is that the worker has the new logins before the page loads.)
  const synced = (await s.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }))) as { ok: boolean };
  expect(synced.ok).toBe(true);
  await s.close();
  const p = await page(ctx, url);
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await submitLogin(p, `zz-${RUN}`, 'Zz-Pa55');
  await p.waitForURL(/welcome\.html/);
  await p.waitForTimeout(2500);
  expect(await gone(p, 'prompt'), 'no prompt for a login that is already saved').toBe(true);
  await p.close();
});

test('update prompt: a changed password updates the server; Undo puts the old one back', async ({ ctx }) => {
  const p = await page(ctx, SAVE('shop', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await submitLogin(p, NEW_USER, 'Shop-NEW-pass-77');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-head b')).toContainText(`Update password for ${NEW_USER}?`);
  await f.locator('button[aria-label="Show new password"]').click();
  await expect(f.locator('.diff')).toContainText('Shop-NEW-pass-77');
  await shot(p, 'inpage-update-light', 2);
  await p.waitForTimeout(300);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText('Password updated');
  const pw = async () => (await serverLogins('shop.save-lw.test')).find((x) => x.username === NEW_USER && !x.deleted)?.password;
  await expect.poll(pw).toBe('Shop-NEW-pass-77');
  await f.locator('.conf .btn.ghost').click();
  await expect.poll(pw).toBe('Shop-Pa55-2026');
  await expect(f.locator('.p-head b')).toContainText('Update password');
  await f.locator('.p-acts .btn.sec').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  await p.close();
});

test('never for this site: no more prompts there, listed in Settings, removable', async ({ ctx, popup }) => {
  const p = await page(ctx, SAVE('never', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2); // ready, as a user would see it
  await submitLogin(p, `never-${RUN}`, 'Never-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await p.waitForTimeout(300);
  await f.locator('.never').click();
  await expect(f.locator('.conf')).toContainText("Won't ask on never.save-lw.test");
  await p.goto(SAVE('never', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2); // ready, as a user would see it
  await submitLogin(p, `never2-${RUN}`, 'Never-Pa55-2');
  await p.waitForURL(/welcome\.html/);
  await p.waitForTimeout(1500);
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  expect((await serverLogins('never.save-lw.test')).length).toBe(0);
  // Settings > Autofill > Sites that never ask to save
  const s = await popup(p);
  watchErrors(s, errors);
  await s.click('button[aria-label="Settings"]');
  await s.click('[data-cat=autofill]');
  await s.locator('.set', { hasText: 'Sites that never ask to save' }).click();
  await expect(s.locator('[data-list=neverSaveSites]')).toContainText('never.save-lw.test');
  await shot(s, 'settings-neversites-light', 2);
  await s.click('button[aria-label="Remove never.save-lw.test"]');
  await expect(s.locator('.body')).toContainText('No sites');
  await s.close();
  await p.close();
});

test('SPA login over fetch (no form, no navigation): the prompt shows; Not now closes it', async ({ ctx }) => {
  const p = await page(ctx, SAVE('spa', 'spa-fetch.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.fill('#u', `spa-${RUN}@spa.test`);
  await p.fill('#p', 'Spa-Pa55');
  await p.click('#go');
  await expect(p.locator('h2')).toHaveText('Welcome back');
  const f = await surface(p, 'prompt');
  await expect(f.locator('input[aria-label=Username]')).toHaveValue(`spa-${RUN}@spa.test`);
  await p.waitForTimeout(300);
  await f.locator('.p-acts .btn.sec').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  expect((await serverLogins('spa.save-lw.test')).filter((x) => x.username === `spa-${RUN}@spa.test`).length).toBe(0);
  await p.close();
});

test('a wrong password gets no save card; the retry that works does (app that checks in place)', async ({ ctx }) => {
  // Regression: the card asked to save a password the site had just rejected, while the form was still up.
  const p = await page(ctx, SAVE('retryspa', 'login-retry-spa.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  const user = `retry-${RUN}`;
  await submitLogin(p, user, 'Wrong-Pa55');
  await expect(p.locator('#err')).toBeVisible();
  await p.waitForTimeout(2000);
  expect(await gone(p, 'prompt'), 'no card while the login form is still there').toBe(true);
  await p.fill('#p', 'Right-Pa55');
  await p.click('button[type=submit]');
  await expect(p.locator('h2')).toHaveText('Welcome back');
  const f = await surface(p, 'prompt');
  await expect(f.locator('input[aria-label=Username]')).toHaveValue(user);
  await expect(f.locator('input[aria-label=Password]')).toHaveValue('Right-Pa55');
  await p.waitForTimeout(300);
  await f.locator('.p-acts .btn.sec').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  expect((await serverLogins('retryspa.save-lw.test')).length).toBe(0);
  await p.close();
});

test('a wrong password gets no save card; the retry that works does (login page served again)', async ({ ctx }) => {
  const p = await page(ctx, SAVE('retry', 'login-retry.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  const user = `retry-${RUN}`;
  await submitLogin(p, user, 'Wrong-Pa55');
  await p.waitForURL(/err=1/);
  await expect(p.locator('#err')).toBeVisible();
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.waitForTimeout(2000);
  expect(await gone(p, 'prompt'), 'no card on the login page that came back').toBe(true);
  await submitLogin(p, user, 'Right-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-head b')).toContainText('Save login for retry.save-lw.test?');
  await expect(f.locator('input[aria-label=Password]')).toHaveValue('Right-Pa55');
  await p.waitForTimeout(300);
  await f.locator('.p-acts .btn.sec').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  await p.close();
});

test('open the menu on focus: not while the save card is up; the field icon still opens it', async ({ ctx, popup }) => {
  const focusSwitch = async (on: boolean) => {
    const s = await popup();
    watchErrors(s, errors);
    await s.click('button[aria-label="Settings"]');
    await s.click('[data-cat=autofill]');
    const sw = s.getByRole('switch', { name: 'Open the menu when a field gets focus' });
    if ((await sw.isChecked()) !== on) await s.locator('.set', { has: sw }).locator('.sw').click();
    await expect(sw).toBeChecked({ checked: on });
    await s.close();
  };
  await focusSwitch(true);
  try {
    // A change-password form stays up after its submit, so its card shows next to it at once.
    const p = await page(ctx, SAVE('focus', 'change-password.html'));
    await expect.poll(async () => (await icons(p)).length).toBeGreaterThan(0);
    await p.fill('#c', 'Old-Pa55');
    await p.fill('#n1', 'New-Pa55-x');
    await p.fill('#n2', 'New-Pa55-x');
    await p.click('button[type=submit]');
    await surface(p, 'prompt');
    await p.click('#c');
    await p.waitForTimeout(800);
    expect(await gone(p, 'menu'), 'no menu on focus while the card is up').toBe(true);
    await clickIcon(p, '#c');
    await surface(p, 'menu');
    await p.close();
    // Without a card, focus still opens the menu.
    const q = await page(ctx, C('stacked.html'));
    await expect.poll(async () => (await icons(q)).length).toBe(2);
    await q.click('#u');
    await surface(q, 'menu');
    await q.close();
  } finally {
    await focusSwitch(false);
  }
});

test('locked menu: the Unlock button has the focus, so Enter opens the unlock popup', async ({ ctx, popup, sw }) => {
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('#go');
  await s.close();
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-msg')).toContainText('Litewarden is locked');
  await expect(m.locator('.m-unlock')).toHaveText(/Unlock\s*or press Enter/);
  await expect(m.locator('.m-msg .btn')).toBeFocused();
  await shot(p, 'inpage-menu-locked-light', 2);
  // Headless Chromium has no toolbar to show the popup in: count the worker's calls to open it instead.
  const w = await sw();
  await w.evaluate(() => {
    const g = globalThis as unknown as { __opened: number };
    g.__opened = 0;
    chrome.action.openPopup = (async () => void g.__opened++) as typeof chrome.action.openPopup;
  });
  await p.keyboard.press('Enter');
  await expect.poll(() => w.evaluate(() => (globalThis as unknown as { __opened: number }).__opened)).toBe(1);
  // Unlock the way the popup would, so the tests after this one start unlocked.
  const u = await popup(p);
  watchErrors(u, errors);
  await u.fill('#pw', creds.main.password);
  await u.keyboard.press('Enter');
  await u.waitForSelector('#q', { timeout: 30_000 });
  await u.close();
  await p.close();
});

test('saving while locked: "Unlock to save", unlock, then save', async ({ ctx, popup }) => {
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('#go');
  await s.close();
  const p = await page(ctx, SAVE('locked', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await submitLogin(p, `locked-${RUN}`, 'Locked-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-body')).toContainText('Litewarden is locked');
  await shot(p, 'inpage-locked-light', 1);
  await p.waitForTimeout(300);
  // "Unlock to save" opens the toolbar popup (chrome.action.openPopup). Headless Chromium doesn't show the toolbar
  // popup as a page, so the test unlocks in a popup page of its own, like a user who clicks the toolbar button.
  await f.locator('.p-acts .btn:not(.sec)').click();
  const u = await popup(p);
  watchErrors(u, errors);
  await u.fill('#pw', creds.main.password);
  await u.keyboard.press('Enter');
  await u.waitForSelector('#q', { timeout: 30_000 });
  await u.close();
  // In real use the pop-out (opened when Chrome can't show the toolbar popup) closes once you're done with it.
  for (const x of ctx.pages()) if (x.url().includes('popout=1')) await x.close();
  await p.bringToFront();
  await expect(f.locator('.p-head b')).toContainText('Save login for locked.save-lw.test?', { timeout: 15_000 });
  // Harness limit: while a popup.html *tab* is (or was) open in the window, Playwright's clicks stop reaching the
  // extension frames that page had; the real toolbar popup and pop-out window don't do this (checked). So the
  // test reloads the page: the waiting prompt comes back in a fresh frame, already as "Save".
  await p.reload();
  const f2 = await surface(p, 'prompt');
  await expect(f2.locator('.p-head b')).toContainText('Save login for locked.save-lw.test?');
  await p.waitForTimeout(400);
  await f2.locator('.p-acts .btn:not(.sec)').click();
  await expect(f2.locator('.conf')).toContainText('Login saved');
  await expect.poll(async () => (await serverLogins('locked.save-lw.test')).some((x) => x.username === `locked-${RUN}`)).toBe(true);
  await p.close();
});

test('never for this site while locked: no unlock needed, no more prompts there, Undo brings the card back', async ({ ctx, popup }) => {
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('#go');
  await s.close();
  const p = await page(ctx, SAVE('lockednever', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await submitLogin(p, `ln-${RUN}`, 'Locked-Never-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-body')).toContainText('Litewarden is locked');
  // All three actions on one row, nothing clipped.
  const row = await f.locator('.p-acts').evaluate((el) => ({
    fits: el.scrollWidth <= el.clientWidth,
    mids: [...el.querySelectorAll('button')].map((b) => (b.getBoundingClientRect().top + b.getBoundingClientRect().bottom) / 2),
    oneLine: [...el.querySelectorAll('button')].every((b) => (b as HTMLElement).offsetHeight <= 32),
  }));
  expect(row.fits).toBe(true);
  expect(Math.max(...row.mids) - Math.min(...row.mids)).toBeLessThanOrEqual(1);
  expect(row.oneLine).toBe(true);
  await p.waitForTimeout(300);
  await f.locator('.never').click();
  await expect(f.locator('.conf')).toContainText("Won't ask on lockednever.save-lw.test");
  // Undo: back to the locked card, and the site is off the list again.
  await f.locator('.conf .btn.ghost').click();
  await expect(f.locator('.p-body')).toContainText('Litewarden is locked');
  await p.waitForTimeout(300);
  await f.locator('.never').click();
  await expect(f.locator('.conf')).toContainText("Won't ask on lockednever.save-lw.test");
  await p.goto(SAVE('lockednever', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await submitLogin(p, `ln2-${RUN}`, 'Locked-Never-Pa55-2');
  await p.waitForURL(/welcome\.html/);
  await p.waitForTimeout(1500);
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  // Unlock again for the tests after this one; the site stays on the list and nothing was saved.
  const u = await popup(p);
  watchErrors(u, errors);
  await u.fill('#pw', creds.main.password);
  await u.keyboard.press('Enter');
  await u.waitForSelector('#q', { timeout: 30_000 });
  await u.click('button[aria-label="Settings"]');
  await u.click('[data-cat=autofill]');
  await u.locator('.set', { hasText: 'Sites that never ask to save' }).click();
  await expect(u.locator('[data-list=neverSaveSites]')).toContainText('lockednever.save-lw.test');
  await u.close();
  for (const x of ctx.pages()) if (x.url().includes('popout=1')) await x.close();
  expect((await serverLogins('lockednever.save-lw.test')).length).toBe(0);
  await p.close();
});

// ---------- teach this site ----------

test('teach this site: offered when a fill finds no fields; point at the fields; the rule fills; Settings removes it', async ({ ctx, popup, sw }) => {
  const p = await page(ctx, C('weird.html'));
  // Detection can't read this form: no icons, and a fill from the popup finds nothing.
  await p.waitForTimeout(800);
  expect((await icons(p)).length).toBe(0);
  const s = await popup(p);
  watchErrors(s, errors);
  await s.waitForSelector('.card');
  await s.keyboard.press('Enter');
  await expect(s.locator('#confirm')).toContainText('No login form found');
  await s.locator('#confirm .c-ok', { hasText: 'Teach this site' }).click();
  const t0 = await surface(p, 'teach');
  await expect(t0.locator('.role.cur')).toContainText('Username or email');
  await s.close().catch(() => {});
  // Esc cancels at any step; nothing is saved
  await p.bringToFront();
  await p.keyboard.press('Escape');
  await expect.poll(() => gone(p, 'teach')).toBe(true);

  // Start again (the in-page menu's "Wrong fields?" sends the same message) and walk the steps. A fresh page, so
  // no popup tab ever shared its window (see the harness note in the locked-save test).
  await p.reload();
  const tab = await tabIdOf(sw, p);
  await (await sw()).evaluate((id) => chrome.tabs.sendMessage(id, { lw: 'teach' }, { frameId: 0 }), tab);
  const t = await surface(p, 'teach');
  await p.waitForTimeout(400);
  await assertCoversNothing(p, await frameBox(t));
  await p.hover('#mcode');
  await p.click('#mcode');
  await expect(t.locator('.role.cur')).toContainText('Password');
  // Back undoes the last pick
  await p.waitForTimeout(300);
  await t.locator('.p-acts .btn.sec', { hasText: 'Back' }).click();
  await expect(t.locator('.role.cur')).toContainText('Username or email');
  await p.click('#mcode');
  await p.click('#sec');
  await expect(t.locator('.role.cur')).toContainText('2FA code');
  await expect(p.locator('#mcode')).toHaveValue('');
  await shot(p, 'inpage-teach-light', 2);
  await p.click('#otp');
  await expect(t.locator('.saved')).toContainText('Saved for corpus.lw.test');
  await expect(t.locator('.saved .site img')).toBeVisible();
  await expect(t.locator('.map')).toContainText('#mcode');
  await shot(p, 'inpage-teach-saved-light', 1);
  await p.waitForTimeout(300);
  await t.locator('.acts .btn:not(.ghost)').click();
  await expect.poll(() => gone(p, 'teach')).toBe(true);
  // icons now sit in the taught fields
  await expect.poll(async () => (await icons(p)).length).toBe(2);

  // The rule fills, 2FA code included.
  const s2 = await popup(p);
  watchErrors(s2, errors);
  await s2.waitForSelector('.card');
  await s2.locator('.card', { hasText: 'Alice' }).click();
  await expect(p.locator('#mcode')).toHaveValue('alice@corpus.test');
  await expect(p.locator('#sec')).toHaveValue('alice-Pa55-word');
  await expect(p.locator('#otp')).toHaveValue(/^\d{6}$/);
  await s2.close().catch(() => {});

  // Settings > Autofill > Site rules lists it; removing it puts detection back in charge.
  const s3 = await popup(p);
  watchErrors(s3, errors);
  await s3.click('button[aria-label="Settings"]');
  await s3.click('[data-cat=autofill]');
  await expect(s3.locator('.set', { hasText: 'Site rules' })).toContainText('corpus.lw.test');
  await s3.locator('.set', { hasText: 'Site rules' }).click();
  await expect(s3.locator('[data-list=rules]')).toContainText('username #mcode');
  await shot(s3, 'settings-rules-light', 2);
  await s3.click('button[aria-label="Remove the rule for corpus.lw.test"]');
  await expect(s3.locator('.body')).toContainText('No rules yet');
  await s3.close();
  await p.reload();
  await p.waitForTimeout(800);
  expect((await icons(p)).length).toBe(0);
  await p.close();
});

// ---------- more pages and settings ----------

test('hide here: the icon goes away on that site; Settings brings it back', async ({ ctx, popup }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await p.waitForTimeout(400);
  await m.locator('.m-foot button', { hasText: 'Hide here' }).click();
  await expect.poll(async () => (await icons(p)).length).toBe(0);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  const s = await popup(p);
  watchErrors(s, errors);
  await s.click('button[aria-label="Settings"]');
  await s.click('[data-cat=autofill]');
  await s.locator('.set', { hasText: 'Sites without the icon' }).click();
  await expect(s.locator('[data-list=iconOffSites]')).toContainText('corpus.lw.test');
  await s.click('button[aria-label="Remove corpus.lw.test"]');
  await expect(s.locator('.body')).toContainText('Every site shows the icon');
  await s.close();
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.close();
});

test('"open the menu when a field gets focus": off by default; on, focus opens it without taking the typing', async ({ ctx, popup }) => {
  const s = await popup();
  watchErrors(s, errors);
  await s.click('button[aria-label="Settings"]');
  await s.click('[data-cat=autofill]');
  await s.locator('.set', { hasText: 'Open the menu when a field gets focus' }).locator('.sw').click();
  await expect(s.locator('#toast')).toContainText('Turned on');
  await s.close();
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.click('#u');
  await surface(p, 'menu');
  await p.keyboard.type('abc');
  await expect(p.locator('#u')).toHaveValue('abc');
  // Moving between the fields fast, and focus plus an icon click at once, used to lose the new menu's token (it said
  // "locked", couldn't close) and stack a second frame. Now: one menu, with the logins, and Esc closes it.
  const shown = async () => {
    const out = [];
    for (const f of p.frames().filter((x) => x.url().includes('/menu.html'))) {
      // A frame being removed can detach between the two calls.
      const b = await f
        .frameElement()
        .then((e) => e.boundingBox())
        .catch(() => null);
      if (b && b.x > -100) out.push(f);
    }
    return out;
  };
  for (let i = 0; i < 4; i++) {
    await p.click('#p');
    await p.click('#u');
    await p.click('#p');
    await clickIcon(p, '#u');
    await expect.poll(async () => (await shown()).length).toBe(1);
    const m = (await shown())[0]!;
    await expect(m.locator('.m-row')).toHaveCount(2);
    await expect(m.locator('.m-msg')).toHaveCount(0);
    await p.keyboard.press('Escape');
    await expect.poll(async () => (await shown()).length).toBe(0);
  }
  await p.close();
  const s2 = await popup();
  await s2.click('button[aria-label="Settings"]');
  await s2.click('[data-cat=autofill]');
  await s2.locator('.set', { hasText: 'Open the menu when a field gets focus' }).locator('.sw').click();
  await expect(s2.locator('#toast')).toContainText('Turned off');
  await s2.close();
});

test('Alt+Shift+L in a focused field opens the menu there', async ({ ctx, sw }) => {
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.click('#p');
  await p.keyboard.press('Alt+Shift+L');
  await p.waitForTimeout(600);
  if (await gone(p, 'menu')) {
    // Headless Chromium doesn't route extension keyboard shortcuts; send what chrome.commands would trigger.
    const tab = await tabIdOf(sw, p);
    await (await sw()).evaluate((id) => chrome.tabs.sendMessage(id, { lw: 'open-menu' }), tab);
  }
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-row')).toHaveCount(2);
  const box = await frameBox(m);
  const pf = (await p.locator('#p').boundingBox())!;
  expect(box.x, 'opened next to the password field').toBeGreaterThan(pf.x + pf.width);
  await p.close();
});

test('right-click, "Fill with Litewarden": the menu opens on the field that was right-clicked', async ({ ctx, sw }) => {
  const w = await sw();
  // The item exists (update fails on an unknown id).
  expect(await w.evaluate(() => chrome.contextMenus.update('open-menu', {}).then(() => true, () => false))).toBe(true);
  const p = await page(ctx, C('stacked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await p.click('#u', { button: 'right' });
  await p.keyboard.press('Escape');
  // Focus has moved on: the menu still goes to the field the right-click was on.
  await p.click('#p');
  // Playwright can't click Chrome's own context menu; send what its onClicked handler sends.
  const tab = await tabIdOf(sw, p);
  await w.evaluate((id) => chrome.tabs.sendMessage(id, { lw: 'open-menu', ctx: true }, { frameId: 0 }), tab);
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-row')).toHaveCount(2);
  const box = await frameBox(m);
  const uf = (await p.locator('#u').boundingBox())!;
  const pf = (await p.locator('#p').boundingBox())!;
  expect(box.y, 'anchored on the username field, above the password field').toBeLessThan(pf.y);
  expect(box.y + box.h).toBeGreaterThan(uf.y);
  await p.close();
});

test('two-step page with no autocomplete hints (T-Mobile style): the username step gets the icon; a newsletter form does not', async ({ ctx }) => {
  const p = await page(ctx, C('step-unmarked.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(1);
  const [ic] = await icons(p);
  const ef = (await p.locator('#e').boundingBox())!;
  expect(ic!.y).toBeGreaterThan(ef.y);
  expect(ic!.x + ic!.w).toBeLessThanOrEqual(ef.x + ef.width);
  await clickIcon(p, '#e');
  await expect((await surface(p, 'menu')).locator('.m-row')).toHaveCount(2);
  await shot(p, 'inpage-step-unmarked', 1);
  await p.goto(C('newsletter.html'));
  await p.waitForTimeout(1500);
  expect(await icons(p)).toEqual([]);
  await p.close();
});

for (const [file, scope] of [
  ['modal.html', '.dlg'],
  ['edge.html', 'form'],
] as const) {
  for (const width of [1100, 420]) {
    test(`${file} at ${width}px: menu from both fields covers nothing`, async ({ ctx }) => {
      const p = await page(ctx, C(file), width);
      await expect.poll(async () => (await icons(p)).length).toBe(2);
      for (const f of ['#u', '#p']) {
        await clickIcon(p, f);
        const m = await surface(p, 'menu');
        await expect(m.locator('.m-row').first()).toBeVisible();
        await p.waitForTimeout(300);
        await assertCoversNothing(p, await frameBox(m), scope);
        await pressOrExplain(p, 'Escape');
        await expect.poll(() => gone(p, 'menu')).toBe(true);
      }
      if (width === 420) await shot(p, `inpage-${file.replace('.html', '')}-420`, 1);
      await p.close();
    });
  }
}

test('web components: login fields inside shadow roots get the icons (found at idle time)', async ({ ctx }) => {
  const p = await page(ctx, C('shadow.html'));
  await expect.poll(async () => (await icons(p)).length, { timeout: 8000 }).toBe(2);
  await p.close();
});

test('login form in a same-origin frame: menu in the frame, fill there', async ({ ctx, sw }) => {
  const p = await page(ctx, C('iframe.html'));
  const fr = p.frameLocator('#fr');
  await expect(fr.locator('#u')).toBeVisible();
  await fr.locator('#u').click();
  const tab = await tabIdOf(sw, p);
  await p.waitForTimeout(500);
  await (await sw()).evaluate((id) => chrome.tabs.sendMessage(id, { lw: 'open-menu' }), tab);
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-row')).toHaveCount(2);
  await expect(m.locator('input[aria-label="Filter logins"]')).toBeFocused();
  await p.waitForTimeout(400);
  await m.locator('.m-row').first().click();
  await expect(fr.locator('#u')).not.toHaveValue('');
  await expect(fr.locator('#p')).not.toHaveValue('');
  await p.close();
});

test('narrow, short window: the save prompt becomes the slim bar and still covers nothing', async ({ ctx }) => {
  const p = await page(ctx, SAVE('bar', 'login-nav.html'), 400, 260);
  await expect.poll(async () => (await icons(p)).length).toBe(2); // ready, as a user would see it
  await submitLogin(p, `bar-${RUN}`, 'Bar-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('.bar')).toBeVisible();
  await p.waitForTimeout(300);
  const b = await frameBox(f);
  expect(b.h).toBeLessThan(70);
  // The title (with its site name inline) and the username line each take one line, inside the bar.
  const fit = await f.locator('.bar').evaluate((bar) => {
    const t = bar.querySelector('.t b')!;
    return { title: t.getBoundingClientRect().height, lines: bar.querySelector('.t')!.scrollHeight, bar: bar.clientHeight, site: getComputedStyle(t.querySelector('.site')!).display };
  });
  expect(fit.site).toBe('inline');
  expect(fit.title).toBeLessThan(24);
  expect(fit.lines).toBeLessThanOrEqual(fit.bar);
  await assertCoversNothing(p, b, 'main');
  await shot(p, 'inpage-bar-light', 2);
  await f.locator('button[aria-label="Not now"]').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  await p.close();
});

test('dark theme: menu, prompt and teach panel follow the system', async ({ ctx, sw }) => {
  const p = await page(ctx, C('stacked.html'));
  await p.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('html')).toHaveAttribute('data-theme', 'dark');
  await p.waitForTimeout(300);
  await shot(p, 'inpage-menu-dark', 2);
  await p.keyboard.press('Escape');
  const tab = await tabIdOf(sw, p);
  await (await sw()).evaluate((id) => chrome.tabs.sendMessage(id, { lw: 'teach' }, { frameId: 0 }), tab);
  const t = await surface(p, 'teach');
  await expect(t.locator('html')).toHaveAttribute('data-theme', 'dark');
  await p.waitForTimeout(300);
  await shot(p, 'inpage-teach-dark', 2);
  await p.keyboard.press('Escape');
  await p.goto(SAVE('dark', 'login-nav.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2); // ready, as a user would see it
  await submitLogin(p, `dark-${RUN}`, 'Dark-Pa55');
  await p.waitForURL(/welcome\.html/);
  const f = await surface(p, 'prompt');
  await expect(f.locator('html')).toHaveAttribute('data-theme', 'dark');
  await p.waitForTimeout(300);
  await shot(p, 'inpage-save-dark', 2);
  await f.locator('button[aria-label="Not now"]').click();
  await p.close();
});

test('cost: the content script adds under 5 ms on pages without a login form', async ({ ctx }) => {
  const out: Record<string, { init: number; scan: number; idle: number }> = {};
  for (const f of ['none.html', 'article.html']) {
    const p = await page(ctx, C(f));
    await p.waitForTimeout(2500);
    const c = await contentCost(p);
    expect(c, 'content script ran').not.toBeNull();
    out[f] = c!;
    // On the page's load path: start-up plus the first (cheap) scan. Later, at idle: the shadow-DOM walk.
    expect(c!.init, `${f}: start-up plus the first scan`).toBeLessThan(budget(5));
    expect(c!.init + c!.idle, `${f}: everything it ran`).toBeLessThan(budget(5));
    // nothing drawn, no worker round trip
    expect((await icons(p)).length).toBe(0);
    await p.close();
  }
  console.log(`content-script cost (ms, budget ${budget(5).toFixed(1)}):`, JSON.stringify(out));
});

