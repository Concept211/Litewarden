// SPDX-License-Identifier: GPL-3.0-only
// First run edge cases, as a user would hit them: a bad address, a server that isn't there, a wrong password,
// two-step login (wrong code, then right), log out, and an empty vault.
import { totp } from '../../src/core/totp';
import { serverUrl } from '../../scripts/testserver/env';
import { e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { VERSION, finishFirstRun, shot, signOut, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ popup }) => signOut(() => popup()));
const creds = e2eCreds();
const errors: string[] = [];

test('server step: bad address, nothing listening, then found', async ({ popup }) => {
  const p = await popup();
  watchErrors(p, errors);
  await p.fill('#url', 'not a server');
  await p.keyboard.press('Enter');
  await expect(p.locator('.field.err .f-msg')).toContainText('Enter the full address');
  await p.fill('#url', 'http://127.0.0.1:8399');
  await p.keyboard.press('Enter');
  await expect(p.locator('.field.err .f-msg')).toContainText('No answer from 127.0.0.1:8399', { timeout: 15_000 });
  await shot(p, 'firstrun-unreachable-light', 1);
  await p.fill('#url', serverUrl(VERSION));
  await p.keyboard.press('Enter');
  await expect(p.locator('.found')).toContainText(`Vaultwarden ${VERSION}`);
  await shot(p, 'firstrun-found-light');
  await p.click('text=I use Bitwarden cloud');
  await expect(p.locator('h2')).toHaveText('Bitwarden cloud');
  await p.click('text=Use a self-hosted server');
  await p.close();
});

test('two-step login: wrong password, wrong code, right code; remembered next time', async ({ popup, corpus }) => {
  const page = await corpus('stacked.html');
  const p = await popup(page);
  watchErrors(p, errors);
  await p.fill('#url', serverUrl(VERSION));
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', creds.twofa.email);
  await p.fill('#pw', 'wrong-password');
  await p.keyboard.press('Enter');
  await expect(p.locator('.field.err .f-msg')).toContainText('The email or master password is wrong');
  await shot(p, 'firstrun-wrong-light', 1);
  await p.fill('#pw', creds.twofa.password);
  await p.keyboard.press('Enter');
  await expect(p.locator('h2')).toHaveText('Two-step login');
  await expect(p.locator('input[aria-label="Code digit 1"]')).toBeFocused();
  await shot(p, 'firstrun-2fa-light');
  await p.keyboard.type('000000');
  await expect(p.locator('.f-msg')).toContainText("That code didn't work");
  // Codes are single use per 30 s window on the server; the next window's code is accepted (±1 step).
  await expect(p.locator('input[aria-label="Code digit 1"]')).toBeFocused();
  await p.keyboard.type(await totp(creds.twofa.secret!, Date.now() + 30_000));
  await finishFirstRun(p);
  await expect(p.locator('.card')).toHaveCount(1);
  await p.click('button[aria-label="Settings"]');
  await p.click('text=Log out');
  await p.click('.sheet .c-ok');
  await expect(p.locator('#url')).toBeVisible();
  // Signing in again on this browser skips the code (remembered for 30 days).
  await p.fill('#url', serverUrl(VERSION));
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', creds.twofa.email);
  await p.fill('#pw', creds.twofa.password);
  await p.keyboard.press('Enter');
  await finishFirstRun(p);
  await p.click('button[aria-label="Settings"]');
  await p.click('text=Log out');
  await p.click('.sheet .c-ok');
  await p.close();
  await page.close();
});

test('an empty vault says what to do', async ({ popup }) => {
  const p = await popup();
  watchErrors(p, errors);
  await p.fill('#url', serverUrl(VERSION));
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', creds.empty.email);
  await p.fill('#pw', creds.empty.password);
  await p.keyboard.press('Enter');
  await finishFirstRun(p);
  await expect(p.locator('.empty h3')).toHaveText('Your vault is empty');
  await shot(p, 'empty-light', 1);
  await p.close();
});

test('no console errors', () => {
  expect(errors).toEqual([]);
});
