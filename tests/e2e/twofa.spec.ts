// SPDX-License-Identifier: GPL-3.0-only
// 2FA setup pages, as a user meets them: a site shows its QR code and/or a typed key; Litewarden's card offers to
// add the key to the site's login and types the current code into the page. Checked on the server. Also: a site
// with no login yet, the popup's note and "Add 2FA" after the card was dismissed, Undo, "Never for this site", a
// key that's already saved, and pages that only look like setup pages.
// The e2e window is 500 x 505 (the screenshot that finds a QR code is of the real window), so the pages are small.
import type { Page } from '@playwright/test';
import QRCode from 'qrcode';
import { totp } from '../../src/core/totp';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';
import { createLogins, frameBox, gone, overlaps, serverLogins, surface } from './inpage-helpers';

test.describe.configure({ mode: 'default' });

const creds = e2eCreds();
const errors: string[] = [];
const RUN = Date.now().toString(36);
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A fresh key per test run (keys already saved get no card). */
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => B32[b % 32]).join('');
const group = (k: string) => k.match(/.{1,4}/g)!.join(' ');
// Each test's site is its own domain: logins match a whole domain, so sibling test sites would share them.
const hostOf = (name: string) => `${name}-${RUN}-2fa.test`;
const url = (name: string) => `http://${hostOf(name)}:${CORPUS_PORT}/twofa-setup.html`;

test.beforeAll(async ({ popup, ctx }) => {
  await signOut(() => popup());
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  const p0 = await ctx.newPage();
  await p0.goto(`http://corpus.lw.test:${CORPUS_PORT}/stacked.html`);
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

async function sync(popup: (t?: Page) => Promise<Page>) {
  const s = await popup();
  expect(((await s.evaluate(() => chrome.runtime.sendMessage({ type: 'sync' }))) as { ok: boolean }).ok).toBe(true);
  await s.close();
}

async function open(ctx: import('@playwright/test').BrowserContext, u: string): Promise<Page> {
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.setViewportSize({ width: 500, height: 505 });
  await p.goto(u);
  await p.bringToFront();
  return p;
}

/** What a site does after "Turn on 2FA": show the QR code and/or the key to type. */
async function showSetup(p: Page, o: { qr?: string; key?: string; digits?: 'boxes' | 'none' }) {
  const src = o.qr ? await QRCode.toDataURL(o.qr, { margin: 2, width: 130 }) : null;
  await p.evaluate(
    ([src, key, digits]) => {
      // Six one-digit boxes instead of one field, or no field yet (some sites ask on the next step).
      const code = document.getElementById('code')!;
      if (digits === 'boxes') code.outerHTML = `<div id="code" style="display:flex;gap:3px">${'<input maxlength="1" inputmode="numeric" style="width:16px;letter-spacing:0;padding:0">'.repeat(6)}</div>`;
      if (digits === 'none') code.remove();
      if (src) document.getElementById('qr')!.innerHTML = `<img src="${src}" width="130" height="130" alt="QR code">`;
      // One span per group, as many sites print it.
      if (key) document.getElementById('alt')!.innerHTML = `<p class="small">Can't scan it? Type this key instead</p><div id="key">${key.split(' ').map((g) => `<span>${g}</span>`).join(' ')}</div>`;
      return Promise.all([...document.images].map((i) => i.decode()));
    },
    [src, o.key ? group(o.key) : null, o.digits ?? null] as const,
  );
}

const codesNow = async (key: string) => [await totp(key), await totp(key, Date.now() - 30_000)];

/** The card covers nothing the user needs: the QR code, the key, the code field, the button. */
async function assertClear(p: Page, f: import('@playwright/test').Frame) {
  const box = await frameBox(f);
  const vp = p.viewportSize()!;
  expect(box.x + box.w).toBeLessThanOrEqual(vp.width + 0.5);
  for (const sel of ['#qr img', '#key', '#code', '#go']) {
    if (!(await p.locator(sel).count())) continue;
    const b = await p.locator(sel).boundingBox();
    if (b) expect(overlaps(box, { x: b.x, y: b.y, w: b.width, h: b.height }), `covers ${sel}`).toBe(false);
  }
}

test('QR code on a setup page: the card adds the key to the login and types the code in; Undo takes it back', async ({ ctx, popup }) => {
  const key = newKey();
  const host = hostOf('qr');
  await createLogins([{ name: host, username: `qr-user-${RUN}`, password: 'Qr-Pa55', uri: `http://${host}:${CORPUS_PORT}` }]);
  await sync(popup);
  const p = await open(ctx, url('qr'));
  const uri = `otpauth://totp/Example%20Support:qr-user-${RUN}?secret=${key}&issuer=Example%20Support`;
  await showSetup(p, { qr: uri });
  const f = await surface(p, 'twofa');
  await expect(f.locator('.p-head b')).toContainText('Add 2FA to Litewarden?');
  await expect(f.locator('.t2-login')).toContainText(`qr-user-${RUN}`);
  await expect(f.locator('.t2-login')).toContainText('No 2FA yet');
  await p.waitForTimeout(600);
  await assertClear(p, f);
  await shot(p, 'twofa-card-light', 2);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText(`2FA added to qr-user-${RUN}`);
  await expect(f.locator('.conf')).toContainText('Code typed into the page');
  expect(await codesNow(key)).toContain(await p.locator('#code').inputValue());
  await shot(p, 'twofa-added-light', 2);
  await expect.poll(async () => (await serverLogins(host)).find((x) => !x.deleted)?.totp).toBe(uri);
  // Undo: the login is back to no 2FA.
  // The card ignores clicks for a moment after it changes (clickjacking guard).
  await p.waitForTimeout(600);
  await f.locator('button', { hasText: 'Undo' }).click();
  await expect(f.locator('.p-head b')).toContainText('Add 2FA to Litewarden?');
  await expect.poll(async () => (await serverLogins(host)).find((x) => !x.deleted)?.totp ?? null).toBeNull();
  // Add again, then the card goes by itself.
  await p.waitForTimeout(600);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText('2FA added');
  await expect.poll(() => gone(p, 'twofa'), { timeout: 15_000 }).toBe(true);
  // The same page again: the key is saved, so no card.
  await p.reload();
  await showSetup(p, { qr: uri });
  await p.waitForTimeout(3500);
  expect(await gone(p, 'twofa')).toBe(true);
  await p.close();
});

test('typed key on a site with no login: saves a new login with the key, code into six boxes', async ({ ctx }) => {
  const key = newKey();
  const host = hostOf('new');
  const p = await open(ctx, url('new'));
  await showSetup(p, { key, digits: 'boxes' });
  const f = await surface(p, 'twofa');
  await expect(f.locator('.p-head b')).toContainText('Save 2FA for this site?');
  await f.locator('input[aria-label=Username]').fill(`new-user-${RUN}`);
  await p.waitForTimeout(600);
  await assertClear(p, f);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText(`2FA added to new-user-${RUN}`);
  const typed = (await p.locator('#code input').evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value))).join('');
  expect(await codesNow(key)).toContain(typed);
  await expect.poll(async () => (await serverLogins(host)).filter((x) => !x.deleted).map((x) => [x.username, x.totp])).toEqual([[`new-user-${RUN}`, key]]);
  await p.close();
});

test('the popup offers the key after the card was dismissed: note and "Add 2FA"', async ({ ctx, popup }) => {
  const key = newKey();
  const host = hostOf('pop');
  await createLogins([{ name: host, username: `pop-user-${RUN}`, password: 'Pop-Pa55', uri: `http://${host}:${CORPUS_PORT}` }]);
  await sync(popup);
  const p = await open(ctx, url('pop'));
  await showSetup(p, { key, qr: `otpauth://totp/Pop:pop-user?secret=${key}` });
  const f = await surface(p, 'twofa');
  await p.waitForTimeout(600);
  await f.locator('.p-acts .btn.sec').click();
  await expect.poll(() => gone(p, 'twofa')).toBe(true);
  const s = await popup(p);
  watchErrors(s, errors);
  await expect(s.locator('#tfa-note')).toContainText('2FA setup on this page');
  await expect(s.locator('#tfa-note')).toContainText(`Add its key to pop-user-${RUN}`);
  await expect(s.locator('.card .stub.add')).toHaveText('Add 2FA');
  await shot(s, 'twofa-popup-light', 2);
  await s.locator('.card .stub.add').click();
  await expect(s.locator('#toast')).toContainText(`2FA added to pop-user-${RUN}. The code is typed into the page.`);
  await expect(s.locator('#tfa-note')).toHaveCount(0);
  // The stub now shows the live code.
  await expect(s.locator('.card .stub .code')).toHaveText(/^\d{3} \d{3}$/);
  expect(await codesNow(key)).toContain(await p.locator('#code').inputValue());
  await expect.poll(async () => keyOfServer(await serverLogins(host))).toBe(key);
  await s.close();
  await p.close();
});
const keyOfServer = (xs: Array<{ totp: string | null; deleted: boolean }>) => new URL(xs.find((x) => !x.deleted)?.totp ?? 'otpauth://x/?secret=').searchParams.get('secret');

test('"Never for this site" stops the card there; Undo brings it back', async ({ ctx }) => {
  const key = newKey();
  const p = await open(ctx, url('never'));
  await showSetup(p, { key });
  const f = await surface(p, 'twofa');
  await p.waitForTimeout(600);
  await f.locator('.never').click();
  await expect(f.locator('.conf')).toContainText(`Won't offer 2FA on ${hostOf('never')}`);
  // The card ignores clicks for a moment after it changes (clickjacking guard).
  await p.waitForTimeout(600);
  await f.locator('button', { hasText: 'Undo' }).click();
  await expect(f.locator('.p-head b')).toContainText('Save 2FA for this site?');
  await p.waitForTimeout(600);
  await f.locator('.never').click();
  await expect(f.locator('.conf')).toContainText("Won't offer 2FA");
  await p.reload();
  await showSetup(p, { key: newKey() });
  await p.waitForTimeout(3500);
  expect(await gone(p, 'twofa')).toBe(true);
  await p.close();
});

test('pages that only look like setup pages get no card', async ({ ctx }) => {
  // A key-like string with no talk of 2FA, and 2FA talk with nothing to add.
  const p = await open(ctx, url('plain'));
  await p.evaluate(() => {
    document.querySelector('h1')!.textContent = 'Your order';
    document.querySelector('.small')!.textContent = 'Thanks for shopping.';
    document.querySelector('main p:nth-of-type(2)')!.textContent = 'Gift code:';
    document.getElementById('alt')!.innerHTML = '<div>JBSW Y3DP EHPK 3PXP</div>';
  });
  await p.waitForTimeout(3500);
  expect(await gone(p, 'twofa')).toBe(true);
  await p.goto(url('talk'));
  await p.evaluate(() => (document.getElementById('alt')!.innerHTML = '<p>Two-factor authentication is on. Lost your phone? Use a backup code.</p>'));
  await p.waitForTimeout(3500);
  expect(await gone(p, 'twofa')).toBe(true);
  await p.close();
});

test('no code field on the page: the card shows the code to type (dark)', async ({ ctx, popup }) => {
  const key = newKey();
  const host = hostOf('dark');
  await createLogins([{ name: host, username: `dark-user-${RUN}`, password: 'Dark-Pa55', uri: `http://${host}:${CORPUS_PORT}` }]);
  await sync(popup);
  const p = await ctx.newPage();
  watchErrors(p, errors);
  await p.setViewportSize({ width: 500, height: 505 });
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.goto(url('dark'));
  await p.bringToFront();
  await showSetup(p, { key, digits: 'none' });
  const f = await surface(p, 'twofa');
  await expect(f.locator('.p-head b')).toContainText('Add 2FA to Litewarden?');
  await p.waitForTimeout(600);
  await shot(p, 'twofa-card-dark', 2);
  await f.locator('.p-acts .btn:not(.sec)').click();
  await expect(f.locator('.conf')).toContainText(`2FA added to dark-user-${RUN}`);
  const shown = (await f.locator('.t2-code').innerText()).replace(/\s/g, '');
  expect(await codesNow(key)).toContain(shown);
  await shot(p, 'twofa-code-dark', 2);
  // It stays up (the code is needed) until closed.
  await p.waitForTimeout(9000);
  expect(await gone(p, 'twofa')).toBe(false);
  await p.close();
});

test('a login that already has a key: Replace warns, keeps the old key in the notes, and Undo restores it', async ({ ctx, popup }) => {
  const old = newKey();
  const key = newKey();
  const host = hostOf('repl');
  await createLogins([{ name: host, username: `repl-user-${RUN}`, password: 'Repl-Pa55', uri: `http://${host}:${CORPUS_PORT}`, totp: old }]);
  await sync(popup);
  const p = await open(ctx, url('repl'));
  await showSetup(p, { key });
  const f = await surface(p, 'twofa');
  await expect(f.locator('.p-head b')).toContainText('Replace the 2FA key?');
  await expect(f.locator('.t2-login')).toContainText('Already has a 2FA key');
  await expect(f.locator('.t2-warn')).toContainText("Replace it only if you're setting up 2FA again");
  await expect(f.locator('.p-acts .btn:not(.sec)')).toHaveText('Replace');
  await p.waitForTimeout(600);
  await shot(p, 'twofa-replace-light', 2);
  const replace = async () => {
    await f.locator('.p-acts .btn:not(.sec)').click();
    await expect(f.locator('.conf')).toContainText(`2FA added to repl-user-${RUN}`);
  };
  const now = async () => (await serverLogins(host)).find((x) => !x.deleted)!;
  // Undo first (the confirmation goes by itself after 8 s): the old key and the notes are back.
  await replace();
  await p.waitForTimeout(600);
  await f.locator('button', { hasText: 'Undo' }).click();
  await expect(f.locator('.p-head b')).toContainText('Replace the 2FA key?');
  await expect.poll(async () => (await now()).totp).toBe(old);
  expect((await now()).notes).toBeNull();
  // Replace for good: the new key, and the old one in the notes.
  await p.waitForTimeout(600);
  await replace();
  await expect.poll(async () => (await now()).totp).toBe(key);
  expect((await now()).notes).toMatch(/^Previous 2FA key, replaced \d{4}-\d{2}-\d{2} on /);
  expect((await now()).notes).toContain(` on ${host}: ${old}`);
  await p.close();
});
