// SPDX-License-Identifier: GPL-3.0-only
// Crypto wallets (mockup "wallet") and Bitwarden's master password re-prompt: making a wallet from "+", what lands on
// the server, the address card and seed phrase, the list row and type button, and re-prompt items refusing to show,
// copy or fill their secrets (popup and in-page menu) until the master password is typed.
import type { Page } from '@playwright/test';
import { CORPUS, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { clipboard, finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';
import { clickIcon, createItems, deleteItems, icons, serverItems, surface } from './inpage-helpers';

test.describe.configure({ mode: 'serial' });

const creds = e2eCreds();
const errors: string[] = [];
const RUN = `W${Date.now().toString(36)}`;
const LEFTOVERS = /^W[0-9a-z]{8} /;
// Well-known sample key and address (web3.js docs) and the BIP39 all-zero test phrase. Never hold funds.
const KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test.beforeAll(async ({ popup, ctx }) => {
  await deleteItems(LEFTOVERS);
  await signOut(() => popup());
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  const p0 = await ctx.newPage();
  await p0.goto(`${CORPUS}/stacked.html`);
  const p = await popup(p0);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.close();
  await p0.close();
});
test.afterAll(async () => {
  await deleteItems(LEFTOVERS);
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  expect(errors, 'console errors').toEqual([]);
});

async function open(popup: (t?: Page, o?: { theme?: 'light' | 'dark' }) => Promise<Page>, theme: 'light' | 'dark' = 'light', target?: Page) {
  const p = await popup(target, { theme });
  watchErrors(p, errors);
  await p.waitForSelector('.row, .card, .empty');
  return p;
}

/** Lock, then unlock with the master password: every re-prompt answer is forgotten. */
async function relock(p: Page) {
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'lock' }));
  await p.reload();
  await p.fill('#pw', creds.main.password);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.row, .card');
}

test('"+" W makes a wallet: network from the name, key and phrase checked, saved as a note with four fields', async ({ popup }) => {
  const p = await open(popup);
  await p.click('button[aria-label="New item"]');
  await expect(p.locator('.newmenu .it').last()).toHaveText(/Wallet\s*W/);
  await p.keyboard.press('w');
  await expect(p.locator('.hdr h1')).toHaveText('New wallet');
  await expect(p.locator('#f-name')).toBeFocused();
  await expect(p.locator('.swrow input[role=switch]')).toBeChecked();

  await p.keyboard.type(`${RUN} Hyperliquid main`);
  await expect(p.locator('#f-network')).toHaveValue('hyperliquid');
  await expect(p.locator('.f-hint').first()).toContainText('Set from the name');
  // A short address gets a warning, the full one doesn't.
  await p.fill('#f-address', ADDR.slice(0, -2));
  await expect(p.locator('.field.err .f-msg')).toHaveText('This 0x address is 2 characters short.');
  await p.fill('#f-address', ADDR);
  await expect(p.locator('#f-network')).toHaveValue('hyperliquid');
  await p.fill('#f-key', KEY.replace('4c08', '5c08'));
  await expect(p.locator('.field.err .f-msg')).toContainText('This key belongs to');
  await p.fill('#f-key', KEY);
  await expect(p.locator('.f-hint.ok')).toHaveText('Matches the address');
  await p.fill('#f-seed', SEED.replace('about', 'abuot'));
  await expect(p.locator('.field.err .f-msg')).toHaveText('Word 12, "abuot", isn\'t on the standard list.');
  // Pasted as a numbered list: tidied on leaving the box.
  await p.fill('#f-seed', SEED.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n'));
  await p.locator('#f-name').focus();
  await expect(p.locator('#f-seed')).toHaveValue(SEED);
  await expect(p.locator('.f-hint.ok').last()).toHaveText('12 words, all on the standard list');
  await shot(p, 'wallet-form-light', 2);

  await p.click('.hdr button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to');
  const [it] = await serverItems(`${RUN} Hyperliquid`);
  expect(it).toMatchObject({ type: 2 });
  expect(it!.fields).toEqual([
    { name: 'Network', value: 'Hyperliquid', type: 0, linkedId: null },
    { name: 'Public address', value: ADDR, type: 0, linkedId: null },
    { name: 'Private key', value: KEY, type: 1, linkedId: null },
    { name: 'Seed phrase', value: SEED, type: 1, linkedId: null },
  ]);
});

test('the wallet page: address card, hidden key and phrase, Copy all; the list row copies the address', async ({ popup, ctx }) => {
  const p = await open(popup);
  await p.fill('#q', RUN);
  const row = p.locator('.row', { hasText: `${RUN} Hyperliquid main` });
  await expect(row.locator('.un')).toContainText('Hyperliquid · 0x2c75…5c23');
  await expect(row.locator('.tile.coin img')).toHaveAttribute('src', '/coins/hyperliquid.svg');
  await row.locator('button[aria-label="Copy address"]').click();
  await expect.poll(() => clipboard(ctx)).toBe(ADDR);
  // Search finds it by the full address too.
  await p.fill('#q', ADDR.slice(0, 12));
  await expect(p.locator('.row', { hasText: RUN })).toHaveCount(1);
  await p.locator('.row', { hasText: RUN }).click();

  await expect(p.locator('.addr-card')).toContainText('Hyperliquid');
  await expect(p.locator('.addr-card .a')).toHaveText(ADDR);
  // Saved just now from this popup, so it's open without asking.
  await expect(p.locator('.lockbox')).toHaveCount(0);
  await expect(p.locator('.kv', { hasText: 'Private key' })).toContainText('••••');
  await expect(p.locator('.seed span')).toHaveCount(12);
  await expect(p.locator('.seed span').first()).toHaveText('1••••••');
  await p.click('.seed-bar button:has-text("Show")');
  await expect(p.locator('.seed span').nth(11)).toHaveText('12about');
  await expect(p.locator('.seed-bar .timer')).toContainText('Hides in 0:');
  await shot(p, 'wallet-view-shown-light', 2);
  await p.click('.seed-bar button:has-text("Copy all")');
  await expect.poll(() => clipboard(ctx)).toBe(SEED);
  // The custom fields list doesn't repeat the wallet's own fields.
  await expect(p.locator('.g-title', { hasText: 'Custom fields' })).toHaveCount(0);

  // The type button shows only wallets.
  await p.keyboard.press('Escape');
  await p.fill('#q', '');
  await p.keyboard.press('Alt+5');
  await expect(p.locator('button[aria-label="Wallets"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('#list .row', { hasText: RUN })).toHaveCount(1);
  expect(await p.locator('#list .row .tile.coin').count()).toBe(await p.locator('#list .row').count());
  await shot(p, 'wallet-list-light', 2);
  await p.keyboard.press('Alt+5');
});

test('re-prompt: after a lock the wallet asks for the master password; a wrong one is refused, the right one shows it', async ({ popup }) => {
  const p = await open(popup, 'dark');
  await relock(p);
  await p.fill('#q', RUN);
  await p.locator('.row', { hasText: RUN }).click();
  await expect(p.locator('.addr-card .a')).toHaveText(ADDR);
  await expect(p.locator('.lockbox .h')).toHaveText('Private key and seed phrase');
  await expect(p.locator('.seed')).toHaveCount(0);
  await expect(p.locator('.hdr .btn.sec', { hasText: 'Edit' })).toHaveCount(0);
  await shot(p, 'wallet-view-locked-dark', 2);
  await p.click('.lockbox button:has-text("Show")');
  await expect(p.locator('#f-reprompt')).toBeFocused();
  await p.keyboard.type('not the password');
  await p.keyboard.press('Enter');
  await expect(p.locator('.lockbox .f-msg')).toContainText("That's not the master password");
  await p.fill('#f-reprompt', creds.main.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('.lockbox')).toHaveCount(0);
  await expect(p.locator('.seed span')).toHaveCount(12);
  await expect(p.locator('.hdr .btn.sec', { hasText: 'Edit' })).toBeVisible();
  await shot(p, 'wallet-view-dark', 2);
});

test('re-prompt on a login: no copy, no fill, no secrets from the worker, in the popup or the page menu, until confirmed', async ({ popup, ctx }) => {
  const name = `${RUN} Reprompt login`;
  await createItems([{ type: 1, name, reprompt: 1, login: { username: 'rp-user', password: 'rp-Secret-123', totp: null, uris: [{ uri: CORPUS, match: null }] } }]);
  const page = await ctx.newPage();
  await page.goto(`${CORPUS}/stacked.html`);
  let p = await open(popup, 'light', page);
  await relock(p);
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }));

  // What the worker answers before the master password: no password, no fill.
  await p.fill('#q', name);
  const id = await p.locator('.row', { hasText: name }).getAttribute('data-id');
  expect(id).toBeTruthy();
  const tabId = await p.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id ?? null, CORPUS);
  const before = await p.evaluate(
    async ({ id, tabId }) => ({
      item: await chrome.runtime.sendMessage({ type: 'getItem', data: { id } }),
      secret: await chrome.runtime.sendMessage({ type: 'getSecret', data: { id, field: 'password' } }),
      user: await chrome.runtime.sendMessage({ type: 'getSecret', data: { id, field: 'username' } }),
      fill: await chrome.runtime.sendMessage({ type: 'fill', data: { tabId, id } }),
      save: await chrome.runtime.sendMessage({ type: 'saveItem', data: { id, draft: { type: 1, name: 'x', notes: null, folderId: null } } }),
    }),
    { id, tabId },
  );
  expect(before.item.data.locked).toBe(true);
  expect(before.item.data.item.login).toBeUndefined();
  expect(JSON.stringify(before.item)).not.toContain('rp-Secret-123');
  expect(before.secret).toMatchObject({ ok: false, error: { name: 'RepromptNeeded' } });
  expect(before.user).toMatchObject({ ok: true, data: { value: 'rp-user' } });
  expect(before.fill).toMatchObject({ ok: true, data: { outcome: 'reprompt' } });
  expect(before.save).toMatchObject({ ok: false, error: { name: 'RepromptNeeded' } });
  await expect(page.locator('#p')).toHaveValue('');

  // The page's menu says to use the toolbar. (Extension tabs stop clicks reaching our frames: lessons.md.)
  await p.close();
  await page.bringToFront();
  await expect.poll(async () => (await icons(page)).length).toBe(2);
  await clickIcon(page, '#u');
  const m = await surface(page, 'menu');
  await expect(m.locator('input[aria-label="Filter logins"]')).toBeFocused();
  await page.keyboard.type(RUN);
  await expect(m.locator('.m-row')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(m.locator('.m-msg')).toContainText('asks for your master password');
  await expect(page.locator('#p')).toHaveValue('');
  await page.keyboard.press('Escape');

  // In the popup, the row's password button opens the item and its master password box.
  p = await open(popup, 'light', page);
  await p.fill('#q', name);
  await p.locator('.row', { hasText: name }).locator('button[aria-label="Copy password"]').click();
  await expect(p.locator('.hdr h1')).toHaveText(name);
  await expect(p.locator('.lockbox')).toBeVisible();
  await expect(p.locator('#f-reprompt')).toBeFocused();
  await expect(p.locator('.kv', { hasText: 'Password' })).toHaveCount(0);
  await shot(p, 'reprompt-login-light', 2);
  await p.keyboard.type(creds.main.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('.kv', { hasText: 'Username' })).toContainText('rp-user');
  await p.click('button[aria-label="Show password"]');
  await expect(p.locator('.kv', { hasText: 'Password' })).toContainText('rp-Secret-123');

  // Confirmed: the worker fills it now.
  const after = await p.evaluate(async ({ id, tabId }) => chrome.runtime.sendMessage({ type: 'fill', data: { tabId, id } }), { id, tabId });
  expect(after).toMatchObject({ ok: true, data: { outcome: 'filled' } });
  await expect(page.locator('#p')).toHaveValue('rp-Secret-123');
  await page.close();
});

test('a note with a street "Address" field stays a note; the edit form keeps other custom fields beside the wallet', async ({ popup }) => {
  await createItems([
    { type: 2, name: `${RUN} Office`, secureNote: { type: 0 }, fields: [{ name: 'Address', value: '120 Ocean Drive, Miami', type: 0 }] },
    { type: 2, name: `${RUN} Locked note`, secureNote: { type: 0 }, reprompt: 1, notes: 'zebracorn phrase in the notes' },
    { type: 2, name: `${RUN} Open note`, secureNote: { type: 0 }, notes: 'zebracorn in an ordinary note' },
    { type: 2, name: `${RUN} Cold storage`, secureNote: { type: 0 }, fields: [{ name: 'Wallet address', value: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', type: 0 }, { name: 'Recovery phrase', value: SEED, type: 1 }, { name: 'Location', value: 'Safe', type: 0 }] },
  ]);
  const p = await open(popup);
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }));
  // A re-prompt item's notes aren't searchable (they'd show as a snippet in the list).
  await p.fill('#q', 'zebracorn');
  await expect(p.locator('.row', { hasText: `${RUN} Open note` })).toHaveCount(1);
  await expect(p.locator('.row', { hasText: `${RUN} Locked note` })).toHaveCount(0);
  await p.fill('#q', RUN);
  await expect(p.locator('.row', { hasText: `${RUN} Office` }).locator('.tile.coin')).toHaveCount(0);
  const cold = p.locator('.row', { hasText: `${RUN} Cold storage` });
  await expect(cold.locator('.un')).toContainText('bc1qar…5mdq');
  await expect(cold.locator('.tile svg.lucide-wallet')).toHaveCount(1);
  await cold.click();
  // No network saved: the card says "Wallet"; its other field is listed under custom fields.
  await expect(p.locator('.addr-card .t')).toHaveText('Wallet');
  await expect(p.locator('.g-title', { hasText: 'Custom fields' })).toBeVisible();
  await expect(p.locator('.kv', { hasText: 'Location' })).toContainText('Safe');
  await p.click('.hdr .btn.sec:has-text("Edit")');
  await expect(p.locator('.hdr h1')).toHaveText('Edit wallet');
  await expect(p.locator('#f-network')).toHaveValue('');
  await p.selectOption('#f-network', 'bitcoin');
  await expect(p.locator('#f-seed')).toHaveValue(SEED);
  await expect(p.locator('.cf input[aria-label="Field 1 name"]')).toHaveValue('Location');
  await p.locator('.swrow').scrollIntoViewIfNeeded();
  await shot(p, 'wallet-edit-light', 2);
  await p.click('.hdr button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to');
  const [it] = await serverItems(`${RUN} Cold storage`);
  expect(it!.fields!.map((f) => [f.name, f.value])).toEqual([
    ['Wallet address', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['Recovery phrase', SEED],
    ['Location', 'Safe'],
    ['Network', 'Bitcoin'],
  ]);
  await expect(p.locator('.addr-card .t')).toHaveText('Bitcoin');
  await expect(p.locator('.addr-card .tile.coin img')).toHaveAttribute('src', '/coins/bitcoin.svg');
});
