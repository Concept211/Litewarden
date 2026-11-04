// SPDX-License-Identifier: GPL-3.0-only
// Share by secure link, through the real popup. On any test server this covers making, listing, copying and deleting
// links. Set LW_SHARE_SERVER to a server with a web vault over HTTPS (scripts/testserver/webvault.ps1), with
// NODE_TLS_REJECT_UNAUTHORIZED=0 for its self-signed cert, and each link is also opened by a stranger: another browser
// with no account and no extension. LW_SHARE_OFF_SERVER adds a server with Sends turned off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Api } from '../../src/core/api';
import { buildTextSend } from '../../src/core/send';
import { serverUrl } from '../../scripts/testserver/env';
import { buildCipher, loginAccount, register } from '../../scripts/testserver/seed';
import { expect, test } from './fixtures';
import { VERSION, clipboard, finishFirstRun, shot, signOut, testServer, watchErrors } from './helpers';

const TLS = process.env.LW_SHARE_SERVER;
const SERVER = TLS ?? serverUrl(VERSION);
const OFF = process.env.LW_SHARE_OFF_SERVER;
const KDF = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };
const account = { email: `share${Date.now()}@litewarden.local`, password: 'share-throwaway-password-1', kdf: KDF };

const errors: string[] = [];
let stranger: Browser | null = null;
let seeded: Awaited<ReturnType<typeof loginAccount>>;

test.beforeAll(async ({ popup }) => {
  await signOut(popup);
  if (TLS) stranger = await chromium.launch({ channel: 'chromium' });
  await register(new Api(SERVER), account.email, account.password, KDF);
  seeded = await loginAccount(SERVER, account as never);
  const { profile } = await seeded.api.sync();
  const items = [
    { type: 1, name: 'Staging login', notes: 'Rotate monthly', login: { username: 'deploy', password: 'k7-Qm2-vXp9', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://staging.acme.test', match: null }] } },
    { type: 1, name: 'Asks first', reprompt: 1, login: { username: 'rp-user', password: 'rp-Secret-123', totp: null, uris: [] } },
    { type: 3, name: 'Team card', card: { cardholderName: 'Alex Rivera', brand: 'Visa', number: '4242424242424242', expMonth: '8', expYear: '2031', code: '737' } },
    { type: 2, name: 'Door note', notes: 'the door code is 1234', secureNote: { type: 0 } },
    { type: 2, name: 'Cold wallet', secureNote: { type: 0 }, fields: [{ name: 'Network', value: 'bitcoin', type: 0 }, { name: 'Address', value: 'bc1qexample', type: 0 }, { name: 'Private key', value: 'wallet-secret', type: 1 }, { name: 'Seed phrase', value: 'one two three', type: 1 }] },
  ];
  const ciphers = [];
  for (const it of items) ciphers.push(await buildCipher(it as never, seeded.userKey, { encryptedFor: profile.id }));
  await seeded.api.req('POST', '/api/ciphers/import', { json: { ciphers, folders: [], folderRelationships: [] } });
});

test.afterAll(async () => {
  await stranger?.close();
  expect(errors).toEqual([]);
});

async function signInHere(p: Page, server: string) {
  await p.waitForSelector('#url');
  await p.fill('#url', server);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', account.email);
  await p.fill('#pw', account.password);
  await p.keyboard.press('Enter');
  await finishFirstRun(p);
}

/** Open a fresh popup, on the list of links. */
async function links(popup: (t?: Page, o?: { resume?: boolean }) => Promise<Page>) {
  const p = await popup();
  watchErrors(p, errors);
  await p.locator('button[aria-label="Shared links"]').click();
  await expect(p.locator('.hdr h1')).toHaveText('Shared links');
  return p;
}

async function newMessage(p: Page, text: string) {
  await p.getByRole('button', { name: 'New link' }).click();
  await p.fill('#share-text', text);
}

async function create(p: Page): Promise<string> {
  await p.click('#share-create');
  await expect(p.locator('.done-t')).toHaveText('Link copied');
  return (await p.locator('#share-link').textContent())!;
}

/** Everything a person reads on the page, including the box the message sits in. */
const readable = (p: Page) => p.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('textarea,input')].map((e) => (e as HTMLInputElement).value).join('\n'));

async function strangerOpens(link: string): Promise<{ page: Page; ctx: BrowserContext } | null> {
  if (!stranger) return null;
  const ctx = await stranger.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.locator('body')).toContainText(/View Send|no longer|password/i, { timeout: 20_000 });
  return { page, ctx };
}

async function strangerReads(link: string, want: string | RegExp) {
  const s = await strangerOpens(link);
  if (!s) return;
  await expect.poll(() => readable(s.page), { timeout: 15_000 }).toMatch(want);
  await s.ctx.close();
}

const gone = /no longer|does not exist/i;

test('a new account has no links yet, and the screen says what they are for', async ({ popup }) => {
  const p = await popup();
  watchErrors(p, errors);
  await signInHere(p, SERVER);
  await expect(p.locator('button[aria-label="Shared links"]')).toBeVisible();
  // Alt S gets there too, and Esc comes back.
  await p.keyboard.press('Alt+s');
  await expect(p.locator('.s-empty')).toContainText('No links yet');
  // A link from a plain HTTP server can't open for anyone, and the screen says so before one is made.
  await expect(p.locator('#share-http')).toHaveCount(TLS ? 0 : 1);
  await shot(p, 'share-empty');
  await p.keyboard.press('Escape');
  await expect(p.locator('#q')).toBeVisible();
  await p.close();
});

test('make a message link: copied at once, and a stranger with no account reads it', async ({ popup, ctx }) => {
  const p = await links(popup);
  await p.getByRole('button', { name: 'New link' }).click();
  await expect(p.locator('#share-text')).toBeFocused();
  await expect(p.locator('#share-create')).toBeDisabled();
  await shot(p, 'share-new-empty');
  await p.fill('#share-text', 'Staging DB\nuser: deploy\npassword: spike-secret-value');
  // The first line is plain words, so it's offered as the title.
  await expect(p.locator('#share-title')).toHaveAttribute('placeholder', 'Staging DB');
  await expect(p.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  await shot(p, 'share-new');
  const link = await create(p);
  await shot(p, 'share-done');
  expect(new URL(link).origin).toBe(new URL(SERVER).origin);
  expect(link).toMatch(/\/#\/send\/[\w-]+\/[\w-]{22}$/);
  expect(await clipboard(ctx)).toBe(link);
  await p.bringToFront();
  await expect(p.locator('#toast')).toContainText('Link copied');
  await expect(p.locator('.facts')).toContainText('Staging DB');
  await expect(p.locator('.facts')).toContainText('Any number of views');
  await strangerReads(link, /spike-secret-value/);

  // On the list, and Copy link gives the same link again.
  await p.getByRole('button', { name: 'Done' }).click();
  await expect(p.locator('.list .row')).toHaveCount(1);
  await expect(p.locator('.row .un')).toContainText('7 days left');
  await shot(p, 'share-list');
  await p.locator('button[aria-label^="Copy link"]').click();
  await expect(p.locator('#toast')).toContainText('Link copied');
  expect(await clipboard(ctx)).toBe(link);
  await p.close();
});

test('a first line that could be the secret is not used as the title', async ({ popup }) => {
  const p = await links(popup);
  await newMessage(p, 'k7#Qm2!vXp9sLt');
  await expect(p.locator('#share-title')).toHaveAttribute('placeholder', 'Shared message');
  // Ctrl Enter creates, and the last choice of how long is kept for next time.
  await p.getByRole('button', { name: '1 hour' }).click();
  await p.keyboard.press('Control+Enter');
  await expect(p.locator('.done-t')).toHaveText('Link copied');
  await expect(p.locator('.hdr h1')).toHaveText('Link ready');
  await expect(p.locator('.facts')).toContainText('Shared message');
  await expect(p.locator('.facts')).not.toContainText('k7#Qm2');
  await p.getByRole('button', { name: 'Done' }).click();
  await p.getByRole('button', { name: 'New link' }).click();
  await expect(p.getByRole('button', { name: '1 hour' })).toHaveAttribute('aria-pressed', 'true');
  await p.getByRole('button', { name: '7 days' }).click();
  await p.close();
});

test('one view: the second open says it no longer exists, and the list moves it to Finished', async ({ popup }) => {
  const p = await links(popup);
  await newMessage(p, 'one view only\nspike-once-value');
  await p.fill('#share-title', 'One view link');
  await p.getByRole('checkbox', { name: 'Only one view' }).check();
  const link = await create(p);
  await expect(p.locator('.facts')).toContainText('0 of 1 view');
  if (stranger) {
    await strangerReads(link, /spike-once-value/);
    await strangerReads(link, gone);
    // The push from the server, or the fresh read on opening the list, brings the count.
    await p.getByRole('button', { name: 'Done' }).click();
    const row = p.locator('.row', { hasText: 'One view link' });
    await expect(row).toHaveClass(/gone/, { timeout: 15_000 });
    await expect(row.locator('.un')).toHaveText('Viewed, link closed');
    await expect(row.locator('button[aria-label^="Copy link"]')).toHaveCount(0);
    await shot(p, 'share-list-finished');
  }
  await p.close();
});

test('a password: asks for one first, says to send it another way, and the stranger needs it', async ({ popup }) => {
  const p = await links(popup);
  await newMessage(p, 'behind a password\nspike-pw-value');
  await p.fill('#share-title', 'Password link');
  await p.getByRole('button', { name: 'Password' }).click();
  await expect(p.locator('#share-password')).toBeFocused();
  await expect(p.locator('.field .f-msg')).toContainText('another way');
  await shot(p, 'share-new-password');
  await p.click('#share-create');
  await expect(p.locator('.field.err .f-msg')).toContainText('Type a password');
  await p.fill('#share-password', 'open-sesame');
  const link = await create(p);
  await expect(p.locator('.done-s')).toContainText('send the password another way');
  await expect(p.locator('.facts')).toContainText('Needs a password');
  const s = await strangerOpens(link);
  if (s) {
    expect(await readable(s.page)).not.toContain('spike-pw-value');
    await s.page.locator('input[type=password]').first().fill('wrong-password');
    await s.page.getByRole('button', { name: /continue|view|access/i }).first().click();
    await s.page.waitForTimeout(800);
    expect(await readable(s.page)).not.toContain('spike-pw-value');
    await s.page.locator('input[type=password]').first().fill('open-sesame');
    await s.page.getByRole('button', { name: /continue|view|access/i }).first().click();
    await expect.poll(() => readable(s.page), { timeout: 15_000 }).toContain('spike-pw-value');
    await s.ctx.close();
  }
  await p.close();
});

test('hide my email: the stranger page leaves it out, and the popup says so', async ({ popup }) => {
  const p = await links(popup);
  await newMessage(p, 'no email here\nspike-nomail-value');
  await p.fill('#share-title', 'Hidden email link');
  await p.getByRole('button', { name: 'Hide my email' }).click();
  await expect(p.getByRole('button', { name: 'Hide my email' })).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('.body > .f-msg')).toContainText('trust the link');
  const link = await create(p);
  await expect(p.locator('.facts')).toContainText('Your email is hidden');
  const s = await strangerOpens(link);
  if (s) {
    await expect.poll(() => readable(s.page), { timeout: 15_000 }).toContain('spike-nomail-value');
    expect(await readable(s.page)).not.toContain(account.email);
    await s.ctx.close();
  }
  await p.close();
});

test('delete: asks first, and after that the link is dead for everyone', async ({ popup }) => {
  const p = await links(popup);
  await newMessage(p, 'delete me\nspike-del-value');
  await p.fill('#share-title', 'Link to delete');
  const link = await create(p);
  await strangerReads(link, /spike-del-value/);
  await p.getByRole('button', { name: 'Delete link' }).click();
  const sheet = p.getByRole('dialog', { name: 'Delete link' });
  await expect(sheet).toContainText('no longer exists');
  await shot(p, 'share-delete');
  // Esc closes the question, not the page.
  await p.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(p.locator('.hdr h1')).toHaveText('Link ready');
  await p.getByRole('button', { name: 'Delete link' }).click();
  await sheet.getByRole('button', { name: 'Delete' }).click();
  await expect(p.locator('.hdr h1')).toHaveText('Shared links');
  await expect(p.locator('.row', { hasText: 'Link to delete' })).toHaveCount(0);
  await strangerReads(link, gone);

  // From the list too.
  await newMessage(p, 'also delete me');
  await p.fill('#share-title', 'Second to delete');
  await create(p);
  await p.getByRole('button', { name: 'Done' }).click();
  await p.locator('button[aria-label="Delete link: Second to delete"]').click();
  await p.getByRole('dialog', { name: 'Delete link' }).getByRole('button', { name: 'Delete' }).click();
  await expect(p.locator('.row', { hasText: 'Second to delete' })).toHaveCount(0);
  await p.close();
});

test('an expired link shows under Finished, and a stranger can\'t open it', async ({ popup }) => {
  const { body, material } = await buildTextSend((await import('../../src/core/crypto')).webCrypto, { title: 'Old link', lasts: '1h', oneView: false, password: null, hideEmail: false }, 'spike-expired-value', seeded.userKey);
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const made = await seeded.api.createSend({ ...body, expirationDate: past });
  const p = await links(popup);
  const row = p.locator('.row', { hasText: 'Old link' });
  await expect(row).toHaveClass(/gone/, { timeout: 15_000 });
  await expect(row.locator('.un')).toContainText('Expired');
  await row.click();
  await expect(p.locator('.done-s')).toHaveText('This link no longer opens.');
  await expect(p.locator('#share-link')).toHaveCount(0);
  await strangerReads(`${new URL(SERVER).origin}/#/send/${made.accessId}/${Buffer.from(material).toString('base64url')}`, gone);
  await p.close();
});

/** The item's page, by name. */
async function openItem(p: Page, name: string) {
  await p.fill('#q', name);
  await p.locator(`button[aria-label="Open ${name}"]`).first().click();
  await expect(p.locator('.hdr h1')).toHaveText(name);
}

test('share a saved login: chips pick the fields, the 2FA secret starts off, Esc goes back to the item', async ({ popup }) => {
  const p = await popup();
  watchErrors(p, errors);
  await openItem(p, 'Staging login');
  await shot(p, 'share-item-button');
  await p.getByRole('button', { name: 'Share' }).click();
  await expect(p.locator('.hdr h1')).toHaveText('Share login');
  await expect(p.locator('#share-text')).toHaveValue('Username: deploy\nPassword: k7-Qm2-vXp9\nWebsite: https://staging.acme.test');
  await expect(p.locator('#share-title')).toHaveValue('Staging login');
  const chip = (name: string) => p.locator('.pickf').getByRole('button', { name });
  await expect(chip('2FA secret')).toHaveAttribute('aria-pressed', 'false');
  await expect(chip('Notes')).toHaveAttribute('aria-pressed', 'false');
  await shot(p, 'share-item');
  await chip('Username').click();
  await chip('Website').click();
  await expect(p.locator('#share-text')).toHaveValue('Password: k7-Qm2-vXp9');
  await chip('2FA secret').click();
  await expect(p.locator('#share-text')).toHaveValue('Password: k7-Qm2-vXp9\n2FA secret: JBSWY3DPEHPK3PXP');
  await chip('2FA secret').click();
  await p.keyboard.press('Escape');
  await expect(p.locator('.hdr h1')).toHaveText('Staging login');
  await p.getByRole('button', { name: 'Share' }).click();
  await expect(p.locator('#share-text')).toHaveValue(/Username: deploy/);
  const link = await create(p);
  await strangerReads(link, /k7-Qm2-vXp9/);
  await p.close();
});

test('cards and notes share too; a wallet and a locked item offer no Share', async ({ popup }) => {
  const p = await popup();
  watchErrors(p, errors);
  await openItem(p, 'Team card');
  await p.getByRole('button', { name: 'Share' }).click();
  await expect(p.locator('.hdr h1')).toHaveText('Share card');
  await expect(p.locator('#share-text')).toHaveValue('Name on card: Alex Rivera\nNumber: 4242424242424242\nExpires: 08/31');
  await expect(p.locator('.pickf').getByRole('button', { name: 'Security code' })).toHaveAttribute('aria-pressed', 'false');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await expect(p.locator('#q')).toBeVisible();

  await openItem(p, 'Door note');
  await p.getByRole('button', { name: 'Share' }).click();
  await expect(p.locator('#share-text')).toHaveValue('the door code is 1234');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');

  await openItem(p, 'Cold wallet');
  await expect(p.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await p.keyboard.press('Escape');

  // Asks for the master password: nothing to share until it's typed.
  await openItem(p, 'Asks first');
  await expect(p.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await p.fill('#f-reprompt', account.password);
  await p.keyboard.press('Enter');
  await p.getByRole('button', { name: 'Share' }).click();
  await expect(p.locator('#share-text')).toHaveValue(/rp-Secret-123/);
  await p.close();
});

test('a file: the toolbar popup hands over to the window, which encrypts and uploads it; the stranger gets the same bytes', async ({ popup, ctx, extId }) => {
  const p = await links(popup);
  await p.getByRole('button', { name: 'New link' }).click();
  await p.getByRole('button', { name: 'File', exact: true }).click();
  await p.fill('#share-title', 'Q3 contract');
  await expect(p.locator('#share-create')).toBeDisabled();
  await shot(p, 'share-file-popup');
  const [win] = await Promise.all([ctx.waitForEvent('page', (w) => w.url().includes('popout=1')), p.locator('button.drop').click()]);
  watchErrors(win, errors);
  // The window opens on the same screen, with what was typed.
  await expect(win.locator('#share-title')).toHaveValue('Q3 contract');
  await expect(win.locator('.drop')).toContainText('or drop it here');
  await shot(win, 'share-file-window');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-share-'));
  const big = path.join(dir, 'too-big.bin');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 100 * 1024 * 1024 + 1);
  await win.setInputFiles('#share-file', big);
  await expect(win.locator('.f-msg[role=alert]')).toContainText('limit is 100 MB');
  await expect(win.locator('#share-create')).toBeDisabled();

  const empty = path.join(dir, 'empty.txt');
  fs.writeFileSync(empty, '');
  await win.setInputFiles('#share-file', empty);
  await expect(win.locator('.f-msg[role=alert]')).toContainText('empty');

  // A real-sized file, with a name the server only sees encrypted.
  const file = path.join(dir, 'Q3 contract (final) é.bin');
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
  fs.writeFileSync(file, bytes);
  await win.setInputFiles('#share-file', file);
  await expect(win.locator('.file-sel')).toContainText('3.0 MB');
  await shot(win, 'share-file-chosen');
  const link = await create(win);
  await expect(win.locator('.facts')).toContainText('Q3 contract');

  const s = await strangerOpens(link);
  if (s) {
    const [dl] = await Promise.all([s.page.waitForEvent('download'), s.page.getByRole('button', { name: /download/i }).first().click()]);
    expect(dl.suggestedFilename()).toContain('Q3 contract');
    const got = fs.readFileSync((await dl.path())!);
    expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    await s.ctx.close();
  }
  await win.getByRole('button', { name: 'Done' }).click();
  await expect(win.locator('.row', { hasText: 'Q3 contract' }).locator('.tile')).toBeVisible();
  await win.close();
  await p.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  void extId;
});

test('a big file at the limit goes through', async ({ popup, ctx, extId, sw }) => {
  test.skip(!TLS, 'only worth the minutes on the full local run');
  await (await sw()).evaluate(() => chrome.storage.session.remove('popupWhere'));
  const win = await ctx.newPage();
  watchErrors(win, errors);
  await win.setViewportSize({ width: 400, height: 660 });
  await win.goto(`chrome-extension://${extId}/popup.html?popout=1`);
  await win.locator('button[aria-label="Shared links"]').click();
  await win.getByRole('button', { name: 'New link' }).click();
  await win.getByRole('button', { name: 'File', exact: true }).click();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-share-'));
  const file = path.join(dir, 'exactly-100mb.bin');
  const bytes = Buffer.alloc(100 * 1024 * 1024, 7);
  fs.writeFileSync(file, bytes);
  await win.setInputFiles('#share-file', file);
  const t0 = Date.now();
  await win.click('#share-create');
  await expect(win.locator('.done-t')).toHaveText('Link copied', { timeout: 120_000 });
  console.log(`100 MB encrypted and uploaded in ${Date.now() - t0} ms`);
  const link = (await win.locator('#share-link').textContent())!;
  const s = (await strangerOpens(link))!;
  const [dl] = await Promise.all([s.page.waitForEvent('download', { timeout: 120_000 }), s.page.getByRole('button', { name: /download/i }).first().click()]);
  const got = fs.readFileSync((await dl.path())!);
  expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  await s.ctx.close();
  await win.close();
  fs.rmSync(dir, { recursive: true, force: true });
  void popup;
});

test('closing the popup mid-message keeps it; locking removes it', async ({ popup }) => {
  let p = await links(popup);
  await newMessage(p, 'half written\nspike-draft-value');
  await p.waitForTimeout(100);
  await p.close();
  p = await popup(undefined, { resume: true });
  watchErrors(p, errors);
  await expect(p.locator('#share-text')).toHaveValue('half written\nspike-draft-value');
  // Closing asks first, since something's been typed.
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog', { name: 'Discard message' })).toBeVisible();
  await p.getByRole('button', { name: 'Keep writing' }).click();
  await expect(p.locator('#share-text')).toBeVisible();
  // A lock takes the message and the screen with it.
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'lock' }));
  await expect(p.locator('#pw, #pin, input[type=password]').first()).toBeVisible();
  const where = await p.evaluate(async () => (await chrome.storage.session.get('popupWhere')).popupWhere ?? null);
  expect(where).toBeNull();
  const onDisk = await p.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(onDisk).not.toContain('spike-draft-value');
  // Back in: the links are there, and nothing about them on disk is readable.
  await p.fill('input[type=password]', account.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('#q')).toBeVisible();
  expect(await p.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)))).not.toMatch(/Staging DB|spike-secret-value|\/#\/send\//);
  await p.close();
});

test('a server that is down: the message stays, and the error says why', async ({ popup }) => {
  test.skip(!!TLS, 'the plain server run stops and restarts its server');
  const p = await links(popup);
  await newMessage(p, 'while the server is away');
  testServer('stop');
  try {
    await p.click('#share-create');
    await expect(p.locator('.body-foot .note.warn')).toContainText("Can't reach");
    await expect(p.locator('#share-text')).toHaveValue('while the server is away');
    await shot(p, 'share-unreachable');
  } finally {
    testServer('start');
  }
  await p.click('#share-create');
  await expect(p.locator('.done-t')).toHaveText('Link copied');
  await p.close();
});

test('the popup holds together at every size, light and dark', async ({ popup, sw }) => {
  for (const [size, w, h] of [['compact', 340, 520], ['standard', 380, 600], ['wide', 480, 600]] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const p = await popup(undefined, { theme });
      watchErrors(p, errors);
      await p.setViewportSize({ width: w, height: h });
      await p.evaluate((s) => chrome.runtime.sendMessage({ type: 'setSettings', data: { popupSize: s } }), size);
      await p.locator('button[aria-label="Shared links"]').click();
      await expect(p.locator('.hdr h1')).toHaveText('Shared links');
      await expect(p.locator('.row').first()).toBeVisible();
      await shot(p, `share-list-${size}-${theme}`, 1);
      const noOverflow = async () => expect(await p.evaluate(() => [...document.querySelectorAll('.scr *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && getComputedStyle(e).position !== 'absolute').map((e) => e.className || e.tagName))).toEqual([]);
      await noOverflow();
      await p.getByRole('button', { name: 'New link' }).click();
      await p.fill('#share-text', 'user: deploy\npassword: x');
      await p.getByRole('button', { name: 'Password' }).click();
      await p.getByRole('button', { name: 'Hide my email' }).click();
      await shot(p, `share-new-${size}-${theme}`, 1);
      await noOverflow();
      // The Create button is always in view, below a body that scrolls.
      const b = await p.locator('#share-create').boundingBox();
      expect(b!.y + b!.height).toBeLessThanOrEqual(h);
      await p.close();
    }
  }
  const p = await popup();
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', data: { popupSize: 'standard' } }));
  await p.close();
  void sw;
});

test('a server with Sends off: the popup says so in plain words', async ({ popup }) => {
  test.skip(!OFF, 'needs LW_SHARE_OFF_SERVER');
  const out = await popup();
  await out.evaluate(() => chrome.runtime.sendMessage({ type: 'logout' }));
  await out.close();
  await register(new Api(OFF!), account.email, account.password, KDF);
  const p = await popup();
  watchErrors(p, errors);
  await signInHere(p, OFF!);
  await p.locator('button[aria-label="Shared links"]').click();
  await newMessage(p, 'nobody will read this');
  await p.click('#share-create');
  await expect(p.locator('.body-foot .note.warn')).toContainText('Shared links are turned off');
  await expect(p.locator('#share-text')).toHaveValue('nobody will read this');
  await shot(p, 'share-off');
  await p.close();
});
