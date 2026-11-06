// SPDX-License-Identifier: GPL-3.0-only
// Generating a password from the page, as a user meets it: the row in the menu on create and confirm boxes (marked or
// not), the link on sign-in boxes, a box's length limits, the save card keeping the new password on every kind of form,
// and getting a password back when no save card came. Test servers and the local corpus only.
import type { BrowserContext, Page } from '@playwright/test';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';
import { clickIcon, createLogins, deleteItems, gone, icons, serverLogins, surface } from './inpage-helpers';

test.describe.configure({ mode: 'default' });

const creds = e2eCreds();
const errors: string[] = [];
const RUN = Date.now().toString(36);
// Each its own site: logins from other tests on a shared domain would fill the menu's list.
const SITE = (host: string, f: string) => `http://gen-${host}-${RUN}-2fa.test:${CORPUS_PORT}/${f}`;

async function page(ctx: BrowserContext, url: string, count: number): Promise<Page> {
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.setViewportSize({ width: 1100, height: 800 });
  await p.goto(url);
  await expect.poll(async () => (await icons(p)).length).toBe(count);
  return p;
}

async function setGen(popup: () => Promise<Page>, patch: Record<string, unknown>) {
  const s = await popup();
  await s.evaluate((data) => chrome.runtime.sendMessage({ type: 'setSettings', data }), patch);
  await s.close();
}

const DEFAULT = { gen: { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true } };

test.beforeAll(async ({ popup, ctx }) => {
  await signOut(() => popup());
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  const p0 = await ctx.newPage();
  await p0.goto(SITE('start', 'stacked.html'));
  const p = await popup(p0);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.evaluate((data) => chrome.runtime.sendMessage({ type: 'setSettings', data }), DEFAULT); // other specs change them
  await p.close();
  await p0.close();
});

test.afterAll(async () => {
  await deleteItems(/^gen-.*-2fa\.test$|^Gen /);
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  expect(errors, 'console errors').toEqual([]);
});

/** The menu's password, once it's there. */
const shown = async (m: import('@playwright/test').Frame) => {
  await expect(m.locator('[data-pw]')).not.toBeEmpty();
  return (await m.locator('[data-pw]').textContent())!;
};

test('unmarked Create and Confirm, like Google: new password in both boxes, then saved from the card', async ({ ctx }) => {
  const site = SITE('create', 'create-unmarked.html');
  const p = await page(ctx, site, 2);
  await clickIcon(p, '#n1');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-use')).toContainText('Use this new password');
  await expect(m.locator('.m-note')).toContainText('Fills both boxes');
  await expect(m.locator('.m-row'), 'saved logins stay out of a create box').toHaveCount(0);
  await expect(m.locator('.m-top'), 'nothing to filter').toHaveCount(0);
  await shot(p, 'generate-create-light', 2);
  const first = await shown(m);
  expect(first).toHaveLength(20);
  await m.locator('button[aria-label="Another one"]').click();
  await expect(m.locator('[data-pw]')).not.toHaveText(first);
  const pw = await shown(m);
  await p.waitForTimeout(350);
  await m.locator('.m-use').click();
  await expect(p.locator('#n1')).toHaveValue(pw);
  await expect(p.locator('#n2')).toHaveValue(pw);
  await expect(m.locator('.conf')).toContainText('New password filled');
  await shot(p, 'generate-filled-light', 2);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await p.click('button[type=submit]');
  const f = await surface(p, 'prompt');
  await expect(f.locator('input[aria-label=Password]')).toHaveValue(pw);
  await p.waitForTimeout(600);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText('Login saved');
  const host = new URL(site).hostname;
  await expect.poll(async () => (await serverLogins(host)).filter((x) => !x.deleted).map((x) => x.password)).toEqual([pw]);
  await f.locator('button[aria-label="Not now"]').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  // It's in a login now, so the menu has nothing to remind you of.
  await clickIcon(p, '#n1');
  const again = await surface(p, 'menu');
  await expect(again.locator('.m-use')).toBeVisible();
  await expect(again.locator('.m-missed')).toHaveCount(0);
  await p.close();
});

test('marked sign-up form: the new boxes get the icon, and the keyboard does it all', async ({ ctx }) => {
  const p = await page(ctx, SITE('signup', 'signup.html'), 2);
  await clickIcon(p, '#n2');
  const m = await surface(p, 'menu');
  const pw = await shown(m);
  await p.keyboard.press('Escape');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await expect(p.locator('#n1')).toHaveValue('');
  await clickIcon(p, '#n2');
  const m2 = await surface(p, 'menu');
  const pw2 = await shown(m2);
  expect(pw2, 'a new one each time the menu opens').not.toBe(pw);
  await p.waitForTimeout(350);
  await p.keyboard.press('Enter');
  await expect(p.locator('#n1')).toHaveValue(pw2);
  await expect(p.locator('#n2')).toHaveValue(pw2);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await p.close();
});

test('change-password form with no marks: old password goes in Current only, and the card updates to the new one', async ({ ctx, popup }) => {
  const site = SITE('change', 'change-unmarked.html');
  const host = new URL(site).hostname;
  await createLogins([{ name: 'Gen change', username: 'gen-change@corpus.test', password: 'Old-Gen-Pa55', uri: new URL(site).origin }]);
  const s = await popup();
  await s.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }));
  await s.close();
  const p = await page(ctx, site, 3);
  // Current password: the saved login, with the generator a click away.
  await clickIcon(p, '#c');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-foot')).toContainText('Generate password');
  await m.locator('.m-top input').fill('Gen change');
  await expect(m.locator('.m-row')).toHaveCount(1);
  await p.waitForTimeout(350);
  await m.locator('.m-row').click();
  await expect(p.locator('#c')).toHaveValue('Old-Gen-Pa55');
  await expect(p.locator('#n1'), 'never in a new box').toHaveValue('');
  await expect(p.locator('#n2')).toHaveValue('');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  // New password: the generator.
  await clickIcon(p, '#n1');
  const g = await surface(p, 'menu');
  const pw = await shown(g);
  await p.waitForTimeout(350);
  await g.locator('.m-use').click();
  await expect(p.locator('#n2')).toHaveValue(pw);
  await expect(p.locator('#c'), 'current password untouched').toHaveValue('Old-Gen-Pa55');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await p.click('button[type=submit]');
  const f = await surface(p, 'prompt');
  await expect(f.locator('.p-head b')).toContainText('Update');
  await p.waitForTimeout(600);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect.poll(async () => (await serverLogins(host)).filter((x) => !x.deleted).map((x) => x.password)).toEqual([pw]);
  await p.close();
});

test('a saved password never goes in an unmarked Create box from the toolbar either', async ({ ctx, popup }) => {
  const site = SITE('nofill', 'create-unmarked.html');
  await createLogins([{ name: 'Gen nofill', username: 'gen-nofill@corpus.test', password: 'Old-Gen-Pa55', uri: new URL(site).origin }]);
  const s0 = await popup();
  await s0.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }));
  await s0.close();
  const p = await page(ctx, site, 2);
  const s = await popup(p);
  await s.waitForSelector('.card');
  await s.locator('.card', { hasText: 'Gen nofill' }).first().click();
  await s.waitForTimeout(500);
  await s.close();
  await expect(p.locator('#n1')).toHaveValue('');
  await expect(p.locator('#n2')).toHaveValue('');
  await p.close();
});

test('boxes that say nothing: the footer link fills from this box on, and the card still saves the generated one', async ({ ctx }) => {
  const p = await page(ctx, SITE('opaque', 'boxes-opaque.html'), 3);
  await p.fill('#a', 'Old-Opaque-Pa55');
  await clickIcon(p, '#b');
  const m = await surface(p, 'menu');
  await shot(p, 'generate-signin-light', 2);
  await p.waitForTimeout(600);
  await m.locator('.m-foot button', { hasText: 'Generate password' }).click();
  await expect(m.locator('.m-note')).toContainText('Fills both boxes');
  // The frame resizes with each view, and the click guard wants it steady for a moment: people take longer than this.
  await p.waitForTimeout(600);
  await m.locator('.m-foot button', { hasText: 'Back to logins' }).click();
  await expect(m.locator('.m-top')).toBeVisible();
  await p.waitForTimeout(600);
  await m.locator('.m-foot button', { hasText: 'Generate password' }).click();
  const pw = await shown(m);
  await p.waitForTimeout(600);
  await m.locator('.m-use').click();
  await expect(p.locator('#b')).toHaveValue(pw);
  await expect(p.locator('#c')).toHaveValue(pw);
  await expect(p.locator('#a'), 'boxes before it stay as they are').toHaveValue('Old-Opaque-Pa55');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  await p.click('button[type=submit]');
  const f = await surface(p, 'prompt');
  await expect(f.locator('input[aria-label=Password]')).toHaveValue(pw);
  await p.waitForTimeout(600);
  await f.locator('button[aria-label="Not now"]').click();
  await p.close();
});

test("a box's limits decide the length, and options narrow what's in it", async ({ ctx, popup }) => {
  const p = await page(ctx, SITE('limits', 'new-limits.html'), 2);
  try {
    await clickIcon(p, '#n1');
    const m = await surface(p, 'menu');
    expect(await shown(m), 'a whole password of 16, not 20 cut short').toHaveLength(16);
    await m.locator('button[aria-label=Options]').click();
    await expect(m.locator('[data-len]')).toHaveText('16');
    await expect(m.locator('button[aria-label=Longer]')).toBeDisabled();
    await shot(p, 'generate-options-light', 2);
    for (let i = 0; i < 4; i++) await m.locator('button[aria-label=Shorter]').click();
    await expect(m.locator('[data-len]')).toHaveText('12');
    await expect(m.locator('button[aria-label=Shorter]'), 'the minlength holds').toBeDisabled();
    expect(await shown(m)).toHaveLength(12);
    await m.getByRole('switch', { name: 'Symbols' }).click({ force: true });
    await expect(m.locator('[data-pw]')).toHaveText(/^[A-Za-z0-9]{12}$/);
    await m.getByRole('switch', { name: 'Numbers' }).click({ force: true });
    await expect(m.locator('[data-pw]')).toHaveText(/^[A-Za-z]{12}$/);
    const pw = await shown(m);
    await p.waitForTimeout(350);
    await m.locator('.m-use').click();
    await expect(p.locator('#n1')).toHaveValue(pw);
    await expect(p.locator('#n2')).toHaveValue(pw);
    // Remembered, as in the popup's generator.
    const s = await popup();
    const st = (await s.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }))) as { data: { settings: { gen: { length: number; symbols: boolean; digits: boolean } } } };
    await s.close();
    expect(st.data.settings.gen).toMatchObject({ length: 12, symbols: false, digits: false });
  } finally {
    await setGen(popup, DEFAULT);
    await p.close();
  }
});

test('a PIN box offers no generator', async ({ ctx }) => {
  const p = await page(ctx, SITE('pin', 'new-pin.html'), 1);
  await clickIcon(p, '#n1');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-foot')).toContainText('Esc to close');
  await expect(m.locator('.m-use')).toHaveCount(0);
  await expect(m.locator('.m-foot')).not.toContainText('Generate');
  await p.close();
});

test('a sign-in with a masked security code and a hidden trap box is still a sign-in', async ({ ctx, popup }) => {
  const site = SITE('extra', 'login-extra.html');
  await createLogins([{ name: 'Gen extra', username: 'gen-extra@corpus.test', password: 'Extra-Pa55', uri: new URL(site).origin }]);
  const s = await popup();
  await s.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }));
  await s.close();
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.goto(site);
  await expect.poll(async () => (await icons(p)).length).toBeGreaterThanOrEqual(2);
  await clickIcon(p, '#p');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-use')).toHaveCount(0);
  await expect(m.locator('.m-foot')).toContainText('Generate password');
  await m.locator('.m-top input').fill('Gen extra');
  await expect(m.locator('.m-row')).toHaveCount(1);
  await p.keyboard.press('Enter');
  await expect(p.locator('#u')).toHaveValue('gen-extra@corpus.test');
  await expect(p.locator('#p')).toHaveValue('Extra-Pa55');
  await expect(p.locator('#s')).toHaveValue('');
  await p.close();
});

test('no save card: the password survives a reload and a lock, on disk only as ciphertext, and only this site sees it', async ({ ctx, popup, sw }) => {
  const site = SITE('missed', 'create-unmarked.html');
  const host = new URL(site).hostname;
  const p = await page(ctx, site, 2);
  await clickIcon(p, '#n1');
  const m = await surface(p, 'menu');
  const pw = await shown(m);
  await p.waitForTimeout(350);
  await m.locator('.m-use').click();
  await expect(p.locator('#n2')).toHaveValue(pw);
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  // The page moves on with no submit we could see.
  await p.reload();
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await expect(p.locator('#n1')).toHaveValue('');

  // Locked: what's on disk says nothing.
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('#go');
  const w = await sw();
  const disk = JSON.stringify(await w.evaluate(() => chrome.storage.local.get(null)));
  expect(disk).toContain('"generated"');
  expect(disk, 'password on disk').not.toContain(pw);
  expect(disk, 'site on disk').not.toContain('"origin"');
  const gen = JSON.stringify(await w.evaluate(async () => (await chrome.storage.local.get('generated')).generated));
  expect(gen, 'site in the list').not.toContain(host);
  expect(gen).toMatch(/"enc":"2\./);
  await s.fill('#pw', creds.main.password);
  await s.click('#go');
  await s.waitForSelector('#q');
  await s.close();

  // Another site: nothing.
  const other = await page(ctx, SITE('other', 'create-unmarked.html'), 2);
  await clickIcon(other, '#n1');
  const om = await surface(other, 'menu');
  await expect(om.locator('.m-use')).toBeVisible();
  await expect(om.locator('.m-missed')).toHaveCount(0);
  await other.close();

  // Back here: it's offered, and Fill puts that same one back.
  await p.reload();
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#n1');
  const back = await surface(p, 'menu');
  await expect(back.locator('.m-missed')).toContainText(/Generated here (just now|\d+ min ago)/);
  await expect(back.locator('.m-missed')).not.toContainText(pw);
  await shot(p, 'generate-missed-light', 2);
  await p.waitForTimeout(350);
  await back.locator('.m-missed button', { hasText: 'Fill' }).click();
  await expect(p.locator('#n1')).toHaveValue(pw);
  await expect(p.locator('#n2')).toHaveValue(pw);
  await expect.poll(() => gone(p, 'menu')).toBe(true);

  // Save: the usual card, then it stops being offered.
  await clickIcon(p, '#n1');
  const again = await surface(p, 'menu');
  await p.waitForTimeout(350);
  await again.locator('.m-missed button', { hasText: 'Save' }).click();
  const f = await surface(p, 'prompt');
  await expect(f.locator('input[aria-label=Password]')).toHaveValue(pw);
  await p.waitForTimeout(600);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText('Login saved');
  await expect.poll(async () => (await serverLogins(host)).filter((x) => !x.deleted).map((x) => x.password)).toEqual([pw]);
  await f.locator('button[aria-label="Not now"]').click();
  await expect.poll(() => gone(p, 'prompt')).toBe(true);
  await clickIcon(p, '#n1');
  const done = await surface(p, 'menu');
  await expect(done.locator('.m-use')).toBeVisible();
  await expect(done.locator('.m-missed')).toHaveCount(0);
  await p.close();
});

test('forget, on a sign-in box too: the sign-in box can take the kept password back', async ({ ctx }) => {
  const a = await page(ctx, SITE('forget', 'create-unmarked.html'), 2);
  await clickIcon(a, '#n1');
  const m = await surface(a, 'menu');
  const pw = await shown(m);
  await a.waitForTimeout(350);
  await m.locator('.m-use').click();
  await expect(a.locator('#n1')).toHaveValue(pw);
  await expect.poll(() => gone(a, 'menu')).toBe(true);
  // The account was made: the site's sign-in page.
  await a.goto(SITE('forget', 'stacked.html'));
  await expect.poll(async () => (await icons(a)).length).toBe(2);
  await clickIcon(a, '#p');
  const s = await surface(a, 'menu');
  await expect(s.locator('.m-missed')).toBeVisible();
  await expect(s.locator('.m-foot')).toContainText('Generate password');
  await shot(a, 'generate-missed-signin-light', 2);
  await a.waitForTimeout(350);
  await s.locator('.m-missed button', { hasText: 'Fill' }).click();
  await expect(a.locator('#p')).toHaveValue(pw);
  await expect.poll(() => gone(a, 'menu')).toBe(true);
  await clickIcon(a, '#p');
  const s2 = await surface(a, 'menu');
  await a.waitForTimeout(350);
  await s2.locator('.m-missed button[aria-label="Forget this password"]').click();
  await expect(s2.locator('.m-missed')).toHaveCount(0);
  await a.close();
});

test('locked: unlock first, then the generator; filling with "open on focus" on does not open a second menu', async ({ ctx, popup }) => {
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('#go');
  await s.close();
  const p = await page(ctx, SITE('locked', 'signup.html'), 2);
  await clickIcon(p, '#n1');
  const m = await surface(p, 'menu');
  await expect(m.locator('.menu')).toContainText('Unlock it to generate a password here');
  await expect(m.locator('.m-use')).toHaveCount(0);
  const u = await popup();
  await u.fill('#pw', creds.main.password);
  await u.click('#go');
  await u.waitForSelector('#q');
  await u.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', data: { menuOnFocus: true } }));
  await u.close();
  try {
    await expect(m.locator('.m-use'), 'the open menu changes by itself after the unlock').toBeVisible();
    // A fresh page: Playwright's input doesn't reach frames in a tab that went to the background for the popup tab.
    const q = await page(ctx, SITE('locked', 'signup.html'), 2);
    await q.click('#n1');
    const m2 = await surface(q, 'menu');
    const pw = await shown(m2);
    await q.waitForTimeout(350);
    await m2.locator('.m-use').click();
    await expect(q.locator('#n1')).toHaveValue(pw);
    await expect(q.locator('#n2')).toHaveValue(pw);
    await expect.poll(() => gone(q, 'menu')).toBe(true);
    await q.waitForTimeout(800);
    expect(await gone(q, 'menu'), 'no menu from the fill moving the focus').toBe(true);
    await q.close();
  } finally {
    await setGen(popup, { menuOnFocus: false });
    await p.close();
  }
});

test('dark theme: the row and its options', async ({ ctx, popup }) => {
  await setGen(popup, { theme: 'dark' });
  try {
    const p = await page(ctx, SITE('dark', 'signup.html'), 2);
    await clickIcon(p, '#n1');
    const m = await surface(p, 'menu');
    await shown(m);
    await shot(p, 'generate-create-dark', 2);
    await m.locator('button[aria-label=Options]').click();
    await shot(p, 'generate-options-dark', 2);
    await p.close();
  } finally {
    await setGen(popup, { theme: 'system' });
  }
});
