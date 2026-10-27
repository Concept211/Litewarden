// SPDX-License-Identifier: GPL-3.0-only
// M2b part 2, as a user's session: the all-items list on a fresh install, a new login from "nothing saved",
// the generator, edits (checked from a second device), errors that keep the edit, trash, live updates from another
// device, settings categories taking effect, and the pop-out window. Throwaway test servers only.
import type { Page } from '@playwright/test';
import QRCode from 'qrcode';
import { decryptItem, type Keys } from '../../src/core';
import { webCrypto as C } from '../../src/core/crypto';
import { buildCipher, loginAccount } from '../../scripts/testserver/seed';
import { serverUrl } from '../../scripts/testserver/env';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { VERSION, finishFirstRun, shot, signIn, signOut, testServer, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ popup }) => {
  await signOut(() => popup());
  // A fresh install: default settings, no remembered pop-out size.
  const p = await popup();
  await p.evaluate(() => chrome.storage.local.remove(['settings', 'popoutBounds']));
  await p.close();
  // Leftovers from an interrupted earlier run would change what "nothing saved for this site" means.
  const d = await device();
  for (const n of [NAME, 'Pushed from another device', 'Renamed on the phone']) {
    for (let hit = await d.find(n); hit; hit = await d.find(n)) await d.api.trashCipher(hit.cipher.id);
  }
  // Anything else an interrupted run left on the test site (whatever its name ended up as).
  for (const c of (await d.api.sync()).ciphers) {
    if (c.deletedDate || c.organizationId || c.type !== 1) continue;
    const it = await decryptItem(C, c, d.keys).catch(() => null);
    if (it?.login?.uris.some((u) => u.uri.includes('newsite-lw.test'))) await d.api.trashCipher(c.id);
  }
});

const creds = e2eCreds();
const errors: string[] = [];
const KDF = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };
const NEWSITE = `http://www.newsite-lw.test:${CORPUS_PORT}`;
const NAME = 'www.newsite-lw.test';

/** A second "device": its own login to the same account, used to check what the server stored and to push changes. */
async function device() {
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...creds.main, kdf: KDF });
  const keys: Keys = { userKey, privateKeys: null, orgKeys: new Map(), orgKeyErrors: new Map() };
  const sync = await api.sync();
  const find = async (name: string, includeDeleted = false) => {
    const s = await api.sync();
    for (const c of s.ciphers) {
      if (c.organizationId || (!includeDeleted && c.deletedDate)) continue;
      const n = await C.decryptString(c.name, userKey).catch(() => null);
      if (n === name) return { cipher: c, item: await decryptItem(C, c, keys) };
    }
    return null;
  };
  return { api, userKey, keys, userId: sync.profile.id, find };
}

async function open(popup: (t?: Page) => Promise<Page>, target?: Page) {
  const p = await popup(target);
  watchErrors(p, errors);
  return p;
}

test.afterAll(() => {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
});

test('fresh install: all items A to Z under the site cards, virtualized, keyboard reaches them', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const p = await open(popup, page);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await expect(p.locator('.card')).toHaveCount(2);
  const all = p.locator('div.sec', { hasText: 'All items' });
  await expect(all).toBeVisible();
  const total = Number((await all.locator('span').nth(1).innerText()).replace(/\D/g, ''));
  expect(total).toBeGreaterThan(2000);
  // Only the rows near the viewport are in the DOM.
  expect(await p.locator('.vlist .row').count()).toBeLessThan(60);
  await shot(p, 'allitems-light', 1);
  // Scroll to the end: the last rows render, still a small DOM.
  await p.evaluate(() => {
    const l = document.getElementById('list')!;
    l.scrollTop = l.scrollHeight;
  });
  await expect.poll(() => p.locator('.vlist .row').count()).toBeGreaterThan(5);
  expect(await p.locator('.vlist .row').count()).toBeLessThan(60);
  // Arrow keys walk past the cards into the list and keep the selection on screen.
  await p.evaluate(() => (document.getElementById('list')!.scrollTop = 0));
  await p.locator('#q').focus();
  for (let i = 0; i < 12; i++) await p.keyboard.press('ArrowDown');
  const sel = p.locator('.vlist .row.is-sel');
  await expect(sel).toHaveCount(1);
  await expect(sel).toBeInViewport();
  // Alt+E opens the selected item.
  const name = await sel.locator('.nm').innerText();
  await p.keyboard.press('Alt+e');
  await expect(p.locator('.hdr h1')).toHaveText(name);
  await p.keyboard.press('Escape');
  await expect(p.locator('#q')).toBeVisible();
  await p.close();
  await page.close();
});

test('settings: default username for new logins', async ({ popup }) => {
  const p = await open(popup);
  await p.click('button[aria-label="Settings"]');
  await expect(p.locator('.cat')).toHaveCount(7);
  await shot(p, 'settings-home-light', 2);
  await p.click('[data-cat=autofill]');
  await p.fill('input[aria-label="Default username"]', 'alex-default');
  await p.keyboard.press('Enter');
  await expect(p.locator('#toast')).toContainText('Saved');
  await p.close();
});

test('new login from "Nothing saved for this site": prefilled, generator, saved encrypted, then fills', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  const p = await open(popup, page);
  await expect(p.locator('.empty')).toContainText('Nothing saved for this site');
  await p.click('button:has-text("Save a login for this site")');
  await expect(p.locator('.hdr h1')).toHaveText('New login');
  await expect(p.locator('#f-name')).toHaveValue(NAME);
  await expect(p.locator('#f-name')).toBeFocused();
  await expect(p.locator('#f-user')).toHaveValue('alex-default');
  expect((await p.locator('#f-pw').inputValue()).length).toBe(20);
  await expect(p.locator('input[aria-label="Website 1"]')).toHaveValue(NEWSITE);
  await shot(p, 'new-light', 2);
  // Generator: 32 characters, no symbols.
  await p.click('button[aria-label="Generate a password"]');
  await p.locator('#g-len').fill('32');
  await p.locator('.gen .sw', { has: p.locator('input[aria-label="Symbols"]') }).click();
  await expect(p.locator('input[aria-label="Symbols"]')).not.toBeChecked();
  const gen = await p.locator('.gen .pv').innerText();
  expect(gen).toHaveLength(32);
  expect(gen).toMatch(/^[A-Za-z0-9]+$/);
  await shot(p, 'generator-light', 2);
  await p.click('button:has-text("Use this password")');
  await expect(p.locator('#f-pw')).toHaveValue(gen);
  await p.click('button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to');
  await expect(p.locator('.hdr h1')).toHaveText(NAME);
  await expect(p.locator('.kv', { hasText: 'Username' })).toContainText('alex-default');
  await shot(p, 'item-view-light', 2);
  // What the server holds decrypts to exactly that (checked from a second device).
  const d = await device();
  const got = await d.find(NAME);
  expect(got?.item.login).toMatchObject({ username: 'alex-default', password: gen, uris: [{ uri: NEWSITE, match: null }] });
  // Back in the list the new card is there, and Enter fills the page.
  await p.click('button[aria-label="Back"]');
  await expect(p.locator('.card')).toHaveCount(1);
  await p.keyboard.press('Enter');
  await p.waitForEvent('close', { timeout: 3000 }).catch(() => {});
  await expect(page.locator('#u')).toHaveValue('alex-default');
  await expect(page.locator('#p')).toHaveValue(gen);
  await page.close();
});

test('edit: username and a second website; a new password keeps the old one in the history', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  const p = await open(popup, page);
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  await expect(p.locator('.hdr h1')).toHaveText('Edit login');
  await p.fill('#f-user', 'alex-edited');
  await p.click('button:has-text("Add website")');
  await p.fill('input[aria-label="Website 2"]', 'https://login.newsite-lw.test');
  await p.selectOption('select[aria-label="Match for website 2"]', '1');
  await shot(p, 'edit-light', 2);
  await p.keyboard.press('Control+s');
  await expect(p.locator('#toast')).toContainText('Saved to');
  await expect(p.locator('.kv', { hasText: 'Exact host' })).toContainText('https://login.newsite-lw.test');
  const d = await device();
  let got = await d.find(NAME);
  expect(got?.item.login?.username).toBe('alex-edited');
  expect(got?.item.login?.uris).toEqual([{ uri: NEWSITE, match: null }, { uri: 'https://login.newsite-lw.test', match: 1 }]);
  expect((got?.cipher.passwordHistory as unknown[] | null)?.length ?? 0).toBe(0);
  const oldPw = got!.item.login!.password;
  // New password from the generator: the old one moves to the history.
  await p.click('button:has-text("Edit")');
  await p.click('button[aria-label="Generate a password"]');
  await p.click('button:has-text("Use this password")');
  await p.click('button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to');
  await expect(p.locator('.meta').first()).toContainText('1 older password');
  got = await d.find(NAME);
  expect(got?.item.login?.password).not.toBe(oldPw);
  const hist = got?.cipher.passwordHistory as Array<{ password: string }>;
  expect(hist).toHaveLength(1);
  expect(await C.decryptString(hist[0]!.password, d.userKey)).toBe(oldPw);
  // Reveal with Alt+R.
  await p.keyboard.press('Alt+r');
  await expect(p.locator('.kv .pw')).toHaveText(got!.item.login!.password!);
  await p.close();
  await page.close();
});

test('errors keep the edit: empty name, a value the server refuses, the server going away', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  const p = await open(popup, page);
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  const d = await device();
  const before = (await d.find(NAME))!.cipher.revisionDate;
  // Empty name: inline error, nothing sent.
  await p.fill('#f-name', '   ');
  await p.click('button[type=submit]');
  await expect(p.locator('.field.err .f-msg')).toHaveText('Give it a name.');
  await expect(p.locator('#f-name')).toBeFocused();
  expect((await d.find(NAME))!.cipher.revisionDate).toBe(before);
  await p.fill('#f-name', NAME);
  // A very long note: whatever the server says, the edit stays open with the text intact.
  const long = 'lorem ipsum '.repeat(2000);
  await p.fill('#f-notes', long);
  await p.click('button[type=submit]');
  const outcome = await Promise.race([
    p.locator('.note.warn').waitFor().then(() => 'refused' as const),
    p.locator('#toast:has-text("Saved to")').waitFor().then(() => 'saved' as const),
  ]);
  console.log(`[${VERSION}] 24,000-character note: ${outcome}${outcome === 'refused' ? `: ${await p.locator('.note.warn').innerText()}` : ''}`);
  if (outcome === 'refused') {
    await expect(p.locator('#f-notes')).toHaveValue(long);
    await shot(p, 'edit-refused-light', 1);
  } else await p.click('button:has-text("Edit")');
  await p.fill('#f-notes', 'Recovery codes are in the safe.');
  // The server goes away mid-edit.
  testServer('stop');
  try {
    await p.click('button[type=submit]');
    await expect(p.locator('.note.warn')).toContainText("Can't reach");
    await expect(p.locator('.note.warn')).toContainText('Your changes are still here');
    await expect(p.locator('#f-notes')).toHaveValue('Recovery codes are in the safe.');
    await shot(p, 'edit-offline-light', 2);
  } finally {
    testServer('start');
  }
  await p.click('button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to', { timeout: 20_000 });
  expect((await d.find(NAME))!.item.notes).toBe('Recovery codes are in the safe.');
  // Esc with unsaved changes asks first.
  await p.click('button:has-text("Edit")');
  await p.fill('#f-user', 'not-saved');
  await p.keyboard.press('Escape');
  await expect(p.locator('.sheet')).toContainText('Discard your changes?');
  await p.click('.sheet button:has-text("Discard")');
  await expect(p.locator('.kv', { hasText: 'Username' })).toContainText('alex-edited');
  await p.close();
  await page.close();
});

/** Paste into the focused field the way the browser delivers it (a trusted paste needs the system clipboard). */
async function paste(p: Page, sel: string, text: string) {
  await p.fill(sel, '');
  await p.focus(sel);
  await p.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    // Nobody tidied it: insert it as Chrome would (a line break becomes a space in a one-line field).
    if (document.activeElement!.dispatchEvent(ev)) document.execCommand('insertText', false, t.replace(/\r?\n/g, ' '));
  }, text);
}

test('paste drops the line breaks a selection picks up at either end', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  const p = await open(popup, page);
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  await paste(p, '#f-pw', '\nPasted-Pa55\r\n');
  await expect(p.locator('#f-pw')).toHaveValue('Pasted-Pa55');
  // A password keeps a space of its own; only whitespace around the line break goes.
  await paste(p, '#f-pw', ' Two words \n');
  await expect(p.locator('#f-pw')).toHaveValue(' Two words');
  await paste(p, '#f-user', '  alex@site.test \n');
  await expect(p.locator('#f-user')).toHaveValue('alex@site.test');
  await paste(p, 'input[aria-label="Website 1"]', '\nhttps://www.newsite-lw.test/login\n');
  await expect(p.locator('input[aria-label="Website 1"]')).toHaveValue('https://www.newsite-lw.test/login');
  // Ctrl+Z still undoes a tidied paste.
  await p.keyboard.press('Control+z');
  await expect(p.locator('input[aria-label="Website 1"]')).not.toHaveValue('https://www.newsite-lw.test/login');
  // Clean text goes in untouched; the notes (several lines on purpose) are left alone.
  await paste(p, '#f-user', 'plain');
  await expect(p.locator('#f-user')).toHaveValue('plain');
  await p.close();
  await page.close();
});

test('the popup closing mid-edit: opening it again lands back in the edit, until saved, discarded or locked', async ({ popup, ctx, sw }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  type Where = { at: number; screen: { mode?: string; settings?: string; draft?: { notes: string | null } } };
  const where = async () => (await (await sw()).evaluate(() => chrome.storage.session.get('popupWhere'))).popupWhere as Where | undefined;
  // The popup records its place just after each change paints; a person can't close it faster than that, a test can.
  const settled = (f: (w: Where | undefined) => unknown) => expect.poll(async () => !!f(await where())).toBe(true);
  let p = await open(popup, page);
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  await p.fill('#f-user', 'mid-edit');
  await p.fill('#f-notes', 'line one\nline two');
  await settled((w) => w?.screen.draft?.notes === 'line one\nline two');
  // Focus goes elsewhere and the toolbar popup closes.
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('.hdr h1')).toHaveText('Edit login');
  await expect(p.locator('#f-user')).toHaveValue('mid-edit');
  await expect(p.locator('#f-notes')).toHaveValue('line one\nline two');
  await shot(p, 'edit-resumed-light', 2);
  // Unsaved edits wait however long it takes.
  await (await sw()).evaluate(() => chrome.storage.session.get('popupWhere').then((r) => chrome.storage.session.set({ popupWhere: { ...(r.popupWhere as object), at: Date.now() - 3_600_000 } })));
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('#f-user')).toHaveValue('mid-edit');
  // Discard: back on the item, and that's where the popup opens next.
  await p.keyboard.press('Escape');
  await p.locator('.sheet button:has-text("Discard")').click();
  await expect(p.locator('button:has-text("Edit")')).toBeVisible();
  await settled((w) => w?.screen.mode === 'view');
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('button:has-text("Edit")')).toBeVisible();
  // A screen with nothing unsaved is remembered for 5 minutes, then the popup starts on the list again.
  await (await sw()).evaluate(() => chrome.storage.session.get('popupWhere').then((r) => chrome.storage.session.set({ popupWhere: { ...(r.popupWhere as object), at: Date.now() - 6 * 60_000 } })));
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('.card button[aria-label^="Open"]')).toBeVisible();
  // Settings: the page you were on.
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=autofill]');
  await settled((w) => w?.screen.settings === 'autofill');
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.getByRole('switch', { name: 'Open the menu when a field gets focus' })).toBeVisible();
  // Back to the list: nothing to come back to.
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await expect(p.locator('.card button[aria-label^="Open"]')).toBeVisible();
  await expect.poll(where).toBeUndefined();
  // Locking forgets an edit in progress (it can hold a password that was never saved).
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  await p.fill('#f-pw', 'Never-Saved-Pa55');
  await expect.poll(where).toBeDefined();
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'lock' }));
  await expect(p.locator('#pw')).toBeVisible();
  expect(await where()).toBeUndefined();
  await p.fill('#pw', creds.main.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('.card button[aria-label^="Open"]')).toBeVisible({ timeout: 30_000 });
  await p.close();
  p = await popup(page, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('.card button[aria-label^="Open"]')).toBeVisible();
  const d = await device();
  expect((await d.find(NAME))?.item.login?.password).not.toBe('Never-Saved-Pa55');
  await p.close();
  await page.close();
});

test('live update: an item added on another device appears without pressing sync', async ({ popup, ctx, sw }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/password-only.html`);
  const p = await open(popup, page);
  await expect(p.locator('.card')).toHaveCount(1);
  // Wait for the hub connection (it reconnects after the server restart above).
  await expect.poll(async () => (await (await sw()).evaluate(() => chrome.storage.session.get('live')) as { live?: { status: string } }).live?.status, { timeout: 60_000 }).toBe('connected');
  const d = await device();
  const body = await buildCipher({ type: 1, name: 'Pushed from another device', login: { username: 'phone', password: 'p', totp: null, uris: [{ uri: NEWSITE, match: null }] } } as never, d.userKey, { encryptedFor: d.userId });
  const t0 = Date.now();
  const created = await d.api.createCipher(body as Record<string, unknown>);
  await expect(p.locator('.card')).toHaveCount(2, { timeout: 10_000 });
  console.log(`[${VERSION}] live update reached the popup in ${Date.now() - t0} ms`);
  await expect(p.locator('.card', { hasText: 'Pushed from another device' })).toBeVisible();
  await expect(p.locator('[data-sync-label]')).toHaveText('Synced just now');
  // A rename on the other device shows up too.
  const rename = { ...(body as Record<string, unknown>), name: await C.encryptString('Renamed on the phone', d.userKey), lastKnownRevisionDate: created.revisionDate };
  await d.api.updateCipher(created.id, rename);
  await expect(p.locator('.card', { hasText: 'Renamed on the phone' })).toBeVisible({ timeout: 10_000 });
  await d.api.trashCipher(created.id);
  await expect(p.locator('.card')).toHaveCount(1, { timeout: 10_000 });
  await p.close();
  await page.close();
});

test('delete moves the login to the trash', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`${NEWSITE}/stacked.html`);
  const p = await open(popup, page);
  await p.locator('.card button[aria-label^="Open"]').click();
  await p.click('button:has-text("Edit")');
  await p.click('button:has-text("Delete this login")');
  await expect(p.locator('.sheet')).toContainText('moves to the trash');
  await shot(p, 'delete-light', 1);
  await p.click('.sheet button:has-text("Delete")');
  await expect(p.locator('#toast')).toContainText('to the trash');
  await expect(p.locator('.empty')).toContainText('Nothing saved for this site');
  const d = await device();
  expect(await d.find(NAME)).toBeNull();
  expect((await d.find(NAME, true))?.cipher.deletedDate).toBeTruthy();
  await p.close();
  await page.close();
});

test('settings take effect at once: theme, density, size, live updates, autofill switch; Esc walks back', async ({ popup, sw }) => {
  let p = await open(popup);
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=appearance]');
  await p.click('.seg[aria-label="Theme"] button:has-text("Dark")');
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark');
  await p.click('.seg[aria-label="Density"] button:has-text("Compact")');
  await expect(p.locator('html')).toHaveAttribute('data-density', 'compact');
  await p.selectOption('select[aria-label="Popup size"]', 'wide');
  await expect.poll(() => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pw').trim())).toBe('480px');
  // Chrome sizes the real popup to the page; the test tab has to be told.
  await p.setViewportSize({ width: 480, height: 600 });
  await shot(p, 'settings-appearance-dark', 2);
  await p.keyboard.press('Escape');
  await expect(p.locator('.cat')).toHaveCount(7);
  await p.keyboard.press('Escape');
  await expect(p.locator('#q')).toBeVisible();
  await shot(p, 'main-compact-dark', 1);
  await p.close();
  // It sticks: a new popup opens dark and compact.
  p = await open(popup);
  await p.setViewportSize({ width: 480, height: 600 });
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(p.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
  await p.click('button[aria-label="Settings"]');
  await shot(p, 'settings-home-dark', 2);
  await p.click('[data-cat=appearance]');
  await p.click('.seg[aria-label="Theme"] button:has-text("System")');
  await p.click('.seg[aria-label="Density"] button:has-text("Roomy")');
  await p.selectOption('select[aria-label="Popup size"]', 'standard');
  await expect(p.locator('html')).toHaveAttribute('data-theme', 'light');
  await p.keyboard.press('Escape');
  // Live updates off closes the connection; on reconnects.
  await p.click('[data-cat=sync]');
  await expect(p.locator('[data-live]')).toHaveAttribute('data-live', 'connected', { timeout: 20_000 });
  await shot(p, 'settings-sync-light', 2);
  await p.locator('.set', { hasText: 'Live updates' }).locator('.sw').click();
  await expect(p.locator('[data-live]')).toContainText('Off.');
  await expect.poll(async () => ((await (await sw()).evaluate(() => chrome.storage.session.get('live'))) as { live?: { status: string } }).live?.status).toBe('off');
  await p.locator('.set', { hasText: 'Live updates' }).locator('.sw').click();
  await expect(p.locator('[data-live]')).toHaveAttribute('data-live', 'connected', { timeout: 20_000 });
  await p.click('button:has-text("Sync now")');
  await expect(p.locator('#ls')).toContainText('items.');
  await p.keyboard.press('Escape');
  // Autofill switch persists.
  await p.click('[data-cat=autofill]');
  const sw2 = p.locator('.set', { hasText: 'Copy the 2FA code after filling' }).locator('input');
  await expect(sw2).toBeChecked();
  await p.locator('.set', { hasText: 'Copy the 2FA code after filling' }).locator('.sw').click();
  await expect(sw2).not.toBeChecked();
  await p.keyboard.press('Escape');
  await p.click('[data-cat=keyboard]');
  await p.click('.set:has-text("All shortcuts")');
  await expect(p.locator('.body')).toContainText('Open the item');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.click('[data-cat=about]');
  await expect(p.locator('.body')).toContainText('Not affiliated with Bitwarden, Inc. or the Vaultwarden project');
  await p.close();
  p = await open(popup);
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=autofill]');
  await expect(p.locator('input[aria-label="Copy the 2FA code after filling"]')).not.toBeChecked();
  await p.locator('.set', { hasText: 'Copy the 2FA code after filling' }).locator('.sw').click();
  await p.close();
});

test('pop-out: a window that stays open after filling, follows the tab, remembers its size', async ({ popup, corpus, ctx, sw }) => {
  const page = await corpus('stacked.html');
  const p = await open(popup, page);
  const [po] = await Promise.all([ctx.waitForEvent('page'), p.click('button[aria-label="Pop out"]')]);
  watchErrors(po, errors);
  await po.waitForLoadState();
  expect(po.url()).toContain('popout=1');
  const w = await sw();
  const pops = async () => (await w.evaluate(() => chrome.windows.getAll({ windowTypes: ['popup'] }))).map((x) => ({ id: x.id!, width: x.width! }));
  expect(await pops()).toHaveLength(1);
  // The popup itself closed; the corpus page becomes the active tab and the pop-out follows it.
  await p.close().catch(() => {});
  await page.bringToFront();
  await expect(po.locator('.card')).toHaveCount(2, { timeout: 10_000 });
  await po.locator('.card', { hasText: 'Corpus · Bob' }).click();
  await expect(page.locator('#u')).toHaveValue('bob');
  await expect(po.locator('#toast')).toContainText('Filled bob');
  expect(po.isClosed()).toBe(false);
  await shot(po, 'popout-light', 1);
  // A second click on Pop out focuses the same window.
  const p2 = await open(popup, page);
  await p2.click('button[aria-label="Pop out"]');
  await page.waitForTimeout(400);
  expect(await pops()).toHaveLength(1);
  await p2.close().catch(() => {});
  // Size is remembered.
  const id = (await pops())[0]!.id;
  await w.evaluate((wid) => chrome.windows.update(wid, { width: 520, height: 700 }), id);
  await expect.poll(async () => (await w.evaluate(() => chrome.storage.local.get('popoutBounds')) as { popoutBounds?: { width: number } }).popoutBounds?.width).toBe(520);
  await w.evaluate((wid) => chrome.windows.remove(wid), id);
  await expect.poll(async () => (await pops()).length).toBe(0);
  // Playwright's headless window emulation resizes new windows to the context viewport, so check what Litewarden
  // asked Chrome for (a spy on windows.create in the worker) rather than the emulated result.
  await w.evaluate(() => {
    const g = globalThis as unknown as { __lwCreate?: unknown; __lwOrig?: typeof chrome.windows.create };
    g.__lwOrig ??= chrome.windows.create.bind(chrome.windows);
    (chrome.windows as { create: unknown }).create = (o: chrome.windows.CreateData) => ((g.__lwCreate = o), g.__lwOrig!(o));
  });
  const p3 = await open(popup, page);
  const [po2] = await Promise.all([ctx.waitForEvent('page'), p3.click('button[aria-label="Pop out"]')]);
  await po2.waitForLoadState();
  const asked = (await w.evaluate(() => (globalThis as unknown as { __lwCreate?: { width?: number; height?: number; type?: string } }).__lwCreate)) ?? {};
  expect(asked).toMatchObject({ width: 520, height: 700, type: 'popup' });
  await w.evaluate(async () => {
    for (const x of await chrome.windows.getAll({ windowTypes: ['popup'] })) await chrome.windows.remove(x.id!);
  });
  await page.close();
});

test('2FA secret: the scan button reads the setup QR code showing on the page', async ({ popup, ctx }) => {
  const page = await ctx.newPage();
  await page.goto(`http://corpus.lw.test:${CORPUS_PORT}/none.html`);
  const showQr = (text: string) =>
    QRCode.toDataURL(text, { margin: 4, width: 220 }).then((src) =>
      page.evaluate((s) => {
        document.getElementById('qr')?.remove();
        const i = document.createElement('img');
        i.id = 'qr';
        i.src = s;
        document.body.prepend(i);
        return i.decode();
      }, src),
    );
  const p = await popup(page);
  await p.click('button[aria-label="New login"]');
  await expect(p.locator('.hdr h1')).toHaveText('New login');
  const scan = async () => {
    // The scan reads the tab the popup is over, which has to be the one showing (as it is under the real popup).
    await page.bringToFront();
    await p.locator('button[aria-label="Scan the QR code on the page"]').click();
  };
  await scan();
  await expect(p.locator('#toast')).toContainText('No QR code found on the page');
  await showQr('https://example.com/not-a-2fa-code');
  await scan();
  await expect(p.locator('#toast')).toContainText("That QR code isn't a 2FA setup code");
  await showQr('otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGFRlc3QgVXNlcg');
  await scan();
  await expect(p.locator('#toast')).toContainText('Google Authenticator export');
  await expect(p.locator('#f-totp')).toHaveValue('');
  const uri = 'otpauth://totp/Example%20Site:alex%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example%20Site';
  await showQr(uri);
  await scan();
  await expect(p.locator('#f-totp')).toHaveValue(uri);
  await expect(p.locator('#toast')).toContainText('2FA key added: Example Site, alex@example.com');
  await shot(p, 'scan-qr-light', 1);

  // A setup page: a small dense code among steps, fields, icons and text. This drives the real scan (the page's
  // measurements, the screenshot's scale, both ways of finding the code); the decoding itself is checked against a
  // page that broke it in tests/unit/scanqr.test.ts.
  const long = 'otpauth://totp/Cloudflare:alex.morgan%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cloudflare';
  const src = await QRCode.toDataURL(long, { margin: 0, width: 170 });
  const busy = (qr: string) =>
    page.evaluate(
      ([qr, src]) => {
        const lorem = 'Install an authenticator app on your mobile device, then enter the code it shows below. ';
        const icon = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M3 3h18v18H3z M7 7h10v10H7z" fill="#222"/></svg>';
        document.body.innerHTML = `
          <style>body{font:13px system-ui;margin:0;display:grid;grid-template-columns:120px 1fr}nav p{margin:10px 8px}main{min-width:0}
            .qrbg{width:370px;height:190px;background:#fff url(${JSON.stringify(src)}) 20px 10px/170px 170px no-repeat}</style>
          <nav>${Array.from({ length: 14 }, (_, i) => `<p>${icon} Menu item ${i + 1}</p>`).join('')}</nav>
          <main><p>&larr; Back</p><ol><li>${lorem}</li><li>Scan the following QR code in your authenticator app</li></ol>
            ${qr}
            <ol start="3"><li>Enter the code from your authenticator app below</li></ol><input style="width:300px;height:26px">
            <ol start="4"><li>Enter your password</li></ol><input type="password" style="width:300px;height:26px"> ${icon}
            <p>${lorem.repeat(2)}</p><p>Can't scan the QR code? Follow alternative steps ${icon}</p><button>Next</button></main>`;
        return Promise.all([...document.images].map((i) => i.decode()));
      },
      [qr, src],
    );
  const clear = () => p.locator('#f-totp').fill('');
  // The screenshot is of the real test window, which is smaller than the page's emulated viewport.
  await page.setViewportSize({ width: 500, height: 505 });
  // An <img> in a white box: found where the page drew it.
  await busy(`<div style="background:#fff;padding:20px;width:170px;margin:6px 60px"><img src="${src}" width="170" height="170"></div>`);
  await clear();
  await scan();
  await expect(p.locator('#f-totp')).toHaveValue(long);
  // A CSS background on a wide element the page doesn't mark as an image: found by its look in the screenshot.
  await busy('<div class="qrbg"></div>');
  await clear();
  await scan();
  await expect(p.locator('#f-totp')).toHaveValue(long);
  await expect(p.locator('#toast')).toContainText('2FA key added: Cloudflare, alex.morgan@example.com');
  await p.close();
  await page.close();
});

test('dark: item view, editor and generator', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page, { theme: 'dark' });
  watchErrors(p, errors);
  await p.locator('.card', { hasText: 'Corpus · Alice' }).locator('button[aria-label^="Open"]').click();
  await expect(p.locator('.code-big')).toHaveText(/^\d{3} \d{3}$/);
  await shot(p, 'item-view-dark', 2);
  await p.click('button:has-text("Edit")');
  await p.click('button[aria-label="Generate a password"]');
  await shot(p, 'edit-dark', 2);
  await p.keyboard.press('Escape');
  await p.close();
  await page.close();
});

test('no console errors in any popup', () => {
  expect(errors).toEqual([]);
});

