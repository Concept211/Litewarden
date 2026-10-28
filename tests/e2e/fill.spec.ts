// SPDX-License-Identifier: GPL-3.0-only
// Faster unlock and filling forms (mockups fill-unlock, picks 1A, 2A, 3A): the PIN typed in the locked in-page menu,
// one login filled straight after the unlock, and cards and addresses filled into checkout and shipping forms,
// including card boxes in a payment company's frames from another site (asked once per shop).
import type { Page } from '@playwright/test';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';
import { clickIcon, createItems, deleteItems, gone, icons, surface } from './inpage-helpers';

test.describe.configure({ mode: 'serial' });

const creds = e2eCreds();
const errors: string[] = [];
const RUN = `F${Date.now().toString(36)}`;
const LEFTOVERS = /^F[0-9a-z]{8} /;
const PIN = '246810';
const C = (f: string) => `http://corpus.lw.test:${CORPUS_PORT}/${f}`;
// Hosts no other spec saves logins for (each is its own site under .test), so the menu lists only these.
const ONE = `http://pinone-2fa.test:${CORPUS_PORT}/stacked.html`;
const TWO = `http://pintwo-2fa.test:${CORPUS_PORT}/stacked.html`;

test.beforeAll(async ({ popup, ctx }) => {
  await deleteItems(LEFTOVERS);
  const login = (host: string, username: string) => ({ username, password: `${username}-Pa55`, totp: null, uris: [{ uri: `http://${host}:${CORPUS_PORT}`, match: 1 }] });
  await createItems([
    { type: 3, name: `${RUN} Visa`, card: { cardholderName: 'Alex Rivera', brand: 'Visa', number: '4242424242424242', expMonth: '8', expYear: '2031', code: '123' } },
    { type: 3, name: `${RUN} Old`, card: { cardholderName: 'Alex Rivera', brand: 'Mastercard', number: '5555555555554444', expMonth: '1', expYear: '2020', code: '999' } },
    { type: 4, name: `${RUN} Home`, identity: { firstName: 'Alex', lastName: 'Rivera', address1: '120 Ocean Drive', address2: 'Apt 4', city: 'Miami', state: 'FL', postalCode: '33139', country: 'US', email: 'alex@example.com', phone: '305-555-0100' } },
    { type: 1, name: `${RUN} One`, login: login('pinone-2fa.test', 'solo') },
    { type: 1, name: `${RUN} Two a`, login: login('pintwo-2fa.test', 'first') },
    { type: 1, name: `${RUN} Two b`, login: login('pintwo-2fa.test', 'second') },
  ]);
  await signOut(() => popup());
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  const p0 = await ctx.newPage();
  await p0.goto(C('stacked.html'));
  const p = await popup(p0);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.close();
  await p0.close();
});

test.afterAll(async ({ popup }) => {
  // Leave the account and the settings as the other spec files expect them.
  const p = await popup();
  await p.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'setSettings', data: { cardFrames: {}, pinInMenu: true } });
    await chrome.runtime.sendMessage({ type: 'setPin', data: { pin: null } });
  });
  await p.close();
  await deleteItems(LEFTOVERS);
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  expect(errors, 'console errors').toEqual([]);
});

async function page(ctx: import('@playwright/test').BrowserContext, url: string): Promise<Page> {
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.setViewportSize({ width: 1100, height: 900 });
  await p.goto(url);
  return p;
}

/** Type the run's id in the menu's filter (the account holds other specs' cards too) and wait for our rows. */
async function filterRun(m: import('@playwright/test').Frame, rows: number) {
  await m.locator('.m-top input').fill(RUN);
  await expect(m.locator('.m-row')).toHaveCount(rows);
}

async function lock(popup: (t?: Page) => Promise<Page>) {
  const s = await popup();
  await s.click('button[aria-label="Lock"]');
  // The locked popup: PIN boxes when a PIN is set, else the master password.
  await s.waitForSelector('.pin input, #go');
  await s.close();
}

test('checkout: the card number field opens the cards, expired last; Enter fills number, name, expiry and code', async ({ ctx }) => {
  const p = await page(ctx, C('checkout.html'));
  // Icons: the shipping name and street, the card number and the name on the card. The email is no sign-in.
  await expect.poll(async () => (await icons(p)).length).toBe(4);
  const em = (await p.locator('#email').boundingBox())!;
  expect((await icons(p)).some((i) => i.y >= em.y && i.y <= em.y + em.height)).toBe(false);
  await clickIcon(p, '#cc');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-top input')).toHaveAttribute('placeholder', 'Filter cards');
  await expect(m.locator('.m-sec')).toHaveText('Cards');
  await filterRun(m, 2);
  await expect(m.locator('.m-row').nth(0)).toContainText(`${RUN} Visa`);
  await expect(m.locator('.m-row').nth(0)).toContainText('08/31');
  await expect(m.locator('.m-row').nth(1)).toContainText('expired');
  await shot(p, 'fill-card-menu-light', 1);
  await m.locator('.m-top input').press('Enter');
  await expect(p.locator('#cc')).toHaveValue('4242424242424242');
  await expect(p.locator('#ccname')).toHaveValue('Alex Rivera');
  await expect(p.locator('#exp')).toHaveValue('08 / 31');
  await expect(p.locator('#cvc')).toHaveValue('123');
  await expect.poll(() => gone(p, 'menu')).toBe(true);
  // The shipping half is untouched by a card.
  await expect(p.locator('#a1')).toHaveValue('');
  await p.close();
});

test('shipping: the name field opens the addresses; Enter fills the address, the state and country menus, email and phone', async ({ ctx }) => {
  const p = await page(ctx, C('checkout.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(4);
  await clickIcon(p, '#sname');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-top input')).toHaveAttribute('placeholder', 'Filter addresses');
  await filterRun(m, 1);
  await expect(m.locator('.m-row')).toContainText('Alex Rivera · Miami, FL');
  await shot(p, 'fill-address-menu-light', 1);
  await m.locator('.m-top input').press('Enter');
  await expect(p.locator('#sname')).toHaveValue('Alex Rivera');
  await expect(p.locator('#a1')).toHaveValue('120 Ocean Drive');
  await expect(p.locator('#a2')).toHaveValue('Apt 4');
  await expect(p.locator('#city')).toHaveValue('Miami');
  await expect(p.locator('#state')).toHaveValue('FL');
  await expect(p.locator('#zip')).toHaveValue('33139');
  await expect(p.locator('#country')).toHaveValue('US');
  await expect(p.locator('#email')).toHaveValue('alex@example.com');
  await expect(p.locator('#phone')).toHaveValue('305-555-0100');
  // An address doesn't touch the card.
  await expect(p.locator('#cc')).toHaveValue('');
  await p.close();
});

test('split expiry: month and year menus, fields known only by their names', async ({ ctx }) => {
  const p = await page(ctx, C('checkout-split.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(2);
  await clickIcon(p, '#n');
  const m = await surface(p, 'menu');
  await filterRun(m, 2);
  await m.locator('.m-top input').press('Enter');
  await expect(p.locator('#n')).toHaveValue('4242424242424242');
  await expect(p.locator('#h')).toHaveValue('Alex Rivera');
  await expect(p.locator('#m')).toHaveValue('8');
  await expect(p.locator('#y')).toHaveValue('2031');
  await expect(p.locator('#v')).toHaveValue('123');
  await p.close();
});

test("payment company's frames: the menu opens on the page beside the card box; asks once per shop, then fills straight away", async ({ ctx }) => {
  const p = await page(ctx, C('checkout-frames.html'));
  const num = p.frames().find((f) => f.url().includes('/pay-number.html'))!;
  const exp = () => p.frames().find((f) => f.url().includes('/pay-exp.html'))!;
  await expect.poll(async () => (await icons(p, num)).length).toBe(1);
  const [ic] = await icons(p, num);
  await p.mouse.click(ic!.x + ic!.w / 2, ic!.y + ic!.h / 2);
  const m = await surface(p, 'menu');
  // The menu is the top page's, not squeezed into the 40 px frame.
  expect(m.parentFrame()).toBe(p.mainFrame());
  const box = (await (await m.frameElement()).boundingBox())!;
  expect(box.height).toBeGreaterThan(120);
  await filterRun(m, 2);
  await m.locator('.m-top input').press('Enter');
  await expect(m.locator('.m-confirm')).toContainText(`frames from frames.example-lw.test:${CORPUS_PORT} on corpus.lw.test. Fill them?`);
  await p.waitForTimeout(400);
  await shot(p, 'fill-card-frames-ask-light', 1);
  // Nothing went into the frames before the answer.
  await expect(num.locator('#n')).toHaveValue('');
  await m.locator('.m-top input').press('Enter');
  await expect(num.locator('#n')).toHaveValue('4242424242424242');
  await expect(exp().locator('#e')).toHaveValue('08 / 31');
  await expect(exp().locator('#c')).toHaveValue('123');
  await expect.poll(() => gone(p, 'menu')).toBe(true);

  // Remembered for this shop: the next fill doesn't ask.
  await p.reload();
  const num2 = p.frames().find((f) => f.url().includes('/pay-number.html'))!;
  await expect.poll(async () => (await icons(p, num2)).length).toBe(1);
  const [ic2] = await icons(p, num2);
  await p.mouse.click(ic2!.x + ic2!.w / 2, ic2!.y + ic2!.h / 2);
  const m2 = await surface(p, 'menu');
  await filterRun(m2, 2);
  await m2.locator('.m-top input').press('Enter');
  await expect(num2.locator('#n')).toHaveValue('4242424242424242');
  await expect(m2.locator('.m-confirm')).toHaveCount(0);
  await p.close();
});

test('PIN in the locked menu: a wrong PIN says the tries left; the right one unlocks and fills the one login', async ({ ctx, popup }) => {
  const s = await popup();
  await s.evaluate((pin) => chrome.runtime.sendMessage({ type: 'setPin', data: { pin } }), PIN);
  await s.close();
  await lock(popup);
  const p = await page(ctx, ONE);
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-pin b')).toHaveText('Type your PIN to unlock');
  await expect(m.locator('.m-pin input').first()).toBeFocused();
  await shot(p, 'fill-pin-menu-light', 2);
  await p.keyboard.type('111111');
  await expect(m.locator('.m-err')).toHaveText("Wrong PIN. 4 tries left, then you'll need the master password.");
  await expect(m.locator('.m-pin input').first()).toBeFocused();
  await p.keyboard.type(PIN);
  await expect(m.locator('.conf b')).toHaveText('Unlocked and filled');
  await expect(m.locator('.conf .t span')).toHaveText('solo on pinone-2fa.test');
  await expect(p.locator('#u')).toHaveValue('solo');
  await expect(p.locator('#p')).toHaveValue('solo-Pa55');
  await expect.poll(() => gone(p, 'menu'), { timeout: 5000 }).toBe(true);
  await p.close();
});

test('unlock and fill: with several logins the list shows, the first one selected, and Enter fills it', async ({ ctx, popup }) => {
  await lock(popup);
  const p = await page(ctx, TWO);
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-pin input').first()).toBeFocused();
  await p.keyboard.type(PIN);
  await expect(m.locator('.m-row')).toHaveCount(2);
  await expect(m.locator('.m-row.is-sel')).toContainText('first');
  await expect(p.locator('#u')).toHaveValue('');
  await m.locator('.m-top input').press('Enter');
  await expect(p.locator('#u')).toHaveValue('first');
  await p.close();
});

test('PIN in the menu turned off: the Unlock button as before; unlocking in the popup fills the one login', async ({ ctx, popup, sw }) => {
  const s = await popup();
  await s.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', data: { pinInMenu: false } }));
  await s.click('button[aria-label="Lock"]');
  await s.waitForSelector('.pin input, #go');
  await s.close();
  const p = await page(ctx, ONE);
  await expect.poll(async () => (await icons(p)).filter((i) => i.locked).length).toBe(2);
  await clickIcon(p, '#u');
  const m = await surface(p, 'menu');
  await expect(m.locator('.m-pin')).toHaveCount(0);
  await expect(m.locator('.m-msg .btn')).toBeFocused();
  const w = await sw();
  await w.evaluate(() => {
    const g = globalThis as unknown as { __opened: number };
    g.__opened = 0;
    chrome.action.openPopup = (async () => void g.__opened++) as typeof chrome.action.openPopup;
  });
  await p.keyboard.press('Enter');
  await expect.poll(() => w.evaluate(() => (globalThis as unknown as { __opened: number }).__opened)).toBe(1);
  // What the toolbar popup would do: unlock (with the PIN there).
  const u = await popup(p);
  watchErrors(u, errors);
  await u.evaluate((pin) => chrome.runtime.sendMessage({ type: 'unlockPin', data: { pin } }), PIN);
  await u.close();
  await expect(p.locator('#u')).toHaveValue('solo');
  await expect(p.locator('#p')).toHaveValue('solo-Pa55');
  await p.close();
});

test('right-click "Show Litewarden icons in fields": unchecking hides every field icon, checking brings them back', async ({ ctx, popup, sw }) => {
  // Chrome's own right-click menu can't be opened by the test: check the item exists and is checked, then flip the
  // setting the item flips and watch the icons.
  const w = await sw();
  const exists = () => w.evaluate(() => new Promise<boolean>((r) => chrome.contextMenus.update('icons', {}, () => r(!chrome.runtime.lastError))));
  expect(await exists()).toBe(true);
  const p = await page(ctx, C('checkout.html'));
  await expect.poll(async () => (await icons(p)).length).toBe(4);
  const s = await popup();
  await s.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', data: { fieldIcon: false } }));
  await expect.poll(async () => (await icons(p)).length).toBe(0);
  await s.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', data: { fieldIcon: true } }));
  await s.close();
  await expect.poll(async () => (await icons(p)).length).toBe(4);
  await p.close();
});
