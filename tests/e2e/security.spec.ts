// SPDX-License-Identifier: GPL-3.0-only
// M4 security follow-ups, as a user meets them: a weak-KDF warning after sign-in (and a refusal below the floor
// that never sends the password), and nothing secret readable from the content-script world.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { Api } from '../../src/core/api';
import { serverUrl } from '../../scripts/testserver/env';
import { register } from '../../scripts/testserver/seed';
import { e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { VERSION, finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ popup }) => signOut(() => popup()));

const creds = e2eCreds();
const errors: string[] = [];
const WEAK = { email: 'weak@litewarden.local', password: 'weak-kdf-test-password-1' };
const send = (p: Page, type: string, data?: unknown) => p.evaluate(([t, d]) => chrome.runtime.sendMessage({ type: t, data: d }), [type, data] as const);

test.beforeAll(async () => {
  // PBKDF2 at 100,000 rounds: below Bitwarden's 600,000 recommendation, above its hard floor.
  await register(new Api(serverUrl(VERSION)), WEAK.email, WEAK.password, { kdf: 0, kdfIterations: 100_000, kdfMemory: null, kdfParallelism: null });
});

test.afterAll(() => {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
});

test('a server below the PBKDF2 floor is refused before the password is used', async ({ popup }) => {
  const seen: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', '*');
      const json = (d: unknown) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(d)));
      if (req.method === 'OPTIONS') return res.end();
      if (req.url === '/api/config') return json({ version: '2026.6.0', server: { name: 'Vaultwarden' } });
      if (req.url === '/api/version') return json('1.37.4');
      if (req.url?.includes('prelogin')) return json({ kdf: 0, kdfIterations: 1000 });
      res.statusCode = 400;
      json({});
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  try {
    const p = await popup();
    watchErrors(p, errors);
    await p.fill('#url', `http://127.0.0.1:${(stub.address() as AddressInfo).port}`);
    await p.keyboard.press('Enter');
    await p.waitForSelector('.found');
    await p.keyboard.press('Enter');
    await p.fill('#em', 'someone@example.com');
    await p.fill('#pw', 'my-very-secret-master-password');
    await p.keyboard.press('Enter');
    await expect(p.locator('.field.err .f-msg')).toContainText('weak encryption settings (PBKDF2 runs only 1,000 rounds)');
    await expect(p.locator('.field.err .f-msg')).toContainText('stopped before sending your password');
    await shot(p, 'kdf-refused-light', 3);
    expect(seen.some((s) => s.includes('/connect/token'))).toBe(false);
    expect(seen.join('\n')).not.toContain('my-very-secret');
    await p.close();
  } finally {
    stub.close();
  }
});

test('weak KDF: warning on the main screen (light and dark), dismiss sticks, Settings keeps the row', async ({ popup }) => {
  const p = await popup(undefined, { theme: 'light' });
  watchErrors(p, errors);
  await signIn(p, WEAK.email, WEAK.password);
  await finishFirstRun(p);
  const warn = p.locator('#kdf-warn');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('Weak encryption settings');
  await expect(warn).toContainText('100,000 rounds');
  await expect(warn).toContainText('web vault');
  await shot(p, 'kdf-warning-light', 3);
  const dark = await popup(undefined, { theme: 'dark' });
  await expect(dark.locator('#kdf-warn')).toBeVisible();
  await shot(dark, 'kdf-warning-dark', 3);
  await dark.close();
  await warn.locator('button:has-text("Dismiss")').click();
  await expect(warn).toHaveCount(0);
  // Settings > Account keeps the row even after the notice is dismissed.
  const again = await popup(undefined, { theme: 'light' });
  await again.waitForSelector('#list');
  await expect(again.locator('#kdf-warn')).toHaveCount(0);
  await again.click('button[aria-label="Settings"]');
  await again.click('[data-cat=account]');
  await expect(again.locator('.set', { hasText: 'Weak encryption settings' })).toBeVisible();
  await shot(again, 'kdf-settings-light', 3);
  const againDark = await popup(undefined, { theme: 'dark' });
  await againDark.click('button[aria-label="Settings"]');
  await againDark.click('[data-cat=account]');
  await shot(againDark, 'kdf-settings-dark', 3);
  await againDark.close();
  // Lock and unlock with the master password: the stored settings still count, and dismissal sticks.
  await send(again, 'lock');
  await again.reload();
  await again.fill('#pw', WEAK.password);
  await again.keyboard.press('Enter');
  await again.waitForSelector('#list');
  await expect(again.locator('#kdf-warn')).toHaveCount(0);
  await again.close();
  await p.close();
});

test('a 600,000-round account sees no warning', async ({ popup }) => {
  await signOut(() => popup());
  const p = await popup();
  await signIn(p, creds.empty.email, creds.empty.password);
  await finishFirstRun(p);
  await expect(p.locator('#list')).toBeVisible();
  await expect(p.locator('#kdf-warn')).toHaveCount(0);
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=account]');
  await expect(p.locator('.set', { hasText: 'Weak encryption settings' })).toHaveCount(0);
  await p.close();
});

test('content scripts cannot read storage; the disk mirror of the session is sealed', async ({ popup, corpus, ctx, sw }) => {
  const page = await corpus('none.html');
  const cdp = await ctx.newCDPSession(page);
  const worlds: Array<{ id: number; origin: string }> = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push({ id: e.context.id, origin: e.context.origin }));
  await cdp.send('Runtime.enable');
  await expect.poll(() => worlds.filter((w) => w.origin.startsWith('chrome-extension://')).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const ours = worlds.filter((w) => w.origin.startsWith('chrome-extension://'));
  const read = async (area: 'local' | 'session') => {
    const out: string[] = [];
    for (const w of ours) {
      const r = await cdp.send('Runtime.evaluate', {
        contextId: w.id,
        awaitPromise: true,
        returnByValue: true,
        expression: `(async()=>{ if(!chrome?.runtime?.id) return 'no-api'; try { const v = await chrome.storage.${area}.get(null); return 'READ:' + JSON.stringify(v).length; } catch (e) { return 'DENIED:' + e.message; } })()`,
      });
      out.push(String(r.result.value));
    }
    return out;
  };
  // Something to read: the empty account is signed in and unlocked; turn the disk mirror on.
  const p = await popup();
  await p.waitForSelector('#list');
  const w = await sw();
  await send(p, 'setSettings', { lockOnClose: false });
  const results = [...(await read('local')), ...(await read('session'))];
  console.log('content-script world reads:', results.join(' | '));
  expect(results.some((r) => r.startsWith('DENIED:'))).toBe(true);
  // Control: the same read does succeed when the area is opened up, so a DENIED above means the fence works.
  await w.evaluate(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }));
  const open = await read('local');
  await w.evaluate(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
  console.log('control (area opened up):', open.join(' | '));
  expect(open.some((r) => r.startsWith('READ:'))).toBe(true);
  expect(await read('local')).toEqual(results.slice(0, ours.length));
  expect(results.filter((r) => r.startsWith('READ:'))).toEqual([]);
  // The mirror on disk: sealed, and nothing in it matches the user key in memory.
  const { sess, disk } = (await w.evaluate(async () => ({ sess: (await chrome.storage.session.get('session')).session, disk: (await chrome.storage.local.get('persistedSession')).persistedSession }))) as { sess: { userKey: string }; disk: Record<string, unknown> };
  expect(sess?.userKey).toBeTruthy();
  expect(disk).toMatchObject({ v: 1 });
  expect(JSON.stringify(disk)).not.toContain(sess.userKey);
  expect(Object.keys(disk).sort()).toEqual(['ct', 'iv', 'v']);
  // Lock removes it, and turning the setting back on removes it too.
  await send(p, 'lock');
  expect(await w.evaluate(async () => (await chrome.storage.local.get('persistedSession')).persistedSession ?? null)).toBeNull();
  await send(p, 'setSettings', { lockOnClose: true });
  await p.close();
  await page.close();
});
