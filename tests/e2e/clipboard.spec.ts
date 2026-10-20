// SPDX-License-Identifier: GPL-3.0-only
// The timed clipboard clear only clears what Litewarden copied: a newer copy of yours survives it.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { clipboard, finishFirstRun, signIn, signOut, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ popup }) => signOut(() => popup()));

const creds = e2eCreds();
const errors: string[] = [];
test.afterAll(() => {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
});

/** Put text on the system clipboard the way another app would (from a focused loopback page). */
async function userCopies(ctx: BrowserContext, text: string) {
  await clipboard(ctx); // sets up the reader page and its permission
  const reader = ctx.pages().find((pg) => pg.url().includes('?reader'))!;
  await reader.bringToFront();
  await reader.evaluate((t) => navigator.clipboard.writeText(t), text);
}

/** Fire the clear now instead of in 30 seconds, and wait until the worker has handled it. */
async function clearNow(sw: () => Promise<Worker>) {
  const w = await sw();
  await w.evaluate(() => chrome.alarms.create('clipclear', { when: Date.now() + 500 }));
  // Chrome may hold a short alarm back (it rounds toward its 30 s minimum), so allow a full 30 s plus slack.
  await expect.poll(async () => (await w.evaluate(() => chrome.alarms.get('clipclear'))) ?? null, { timeout: 60_000 }).toBeNull();
  // A clear that could not be confirmed would re-arm the alarm after 5 s; wait past that.
  await new Promise((r) => setTimeout(r, 6000));
  expect((await w.evaluate(() => chrome.alarms.get('clipclear'))) ?? null).toBeNull();
}

async function copyStub(p: Page, what: 'Password' | 'Username') {
  // Retry the click: right after the clipboard reader tab had the focus, the first click can land while the popup
  // tab is still coming forward (writeText refuses an unfocused page).
  await expect(async () => {
    await p.bringToFront();
    await p.locator('.card', { hasText: 'Corpus · Alice' }).locator('.stub', { hasText: what === 'Username' ? 'User' : what }).click();
    await expect(p.locator('#toast')).toContainText(`${what} copied`, { timeout: 4000 });
  }).toPass({ timeout: 30_000 });
}

test('clear removes our copy but never a newer one', async ({ popup, corpus, ctx, sw }) => {
  test.setTimeout(240_000);
  const page = await corpus('stacked.html');
  const p = await popup(page);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.waitForSelector('.card');

  // 1. Nothing newer: the password is still there at clear time, so it is cleared.
  await copyStub(p, 'Password');
  await expect.poll(() => clipboard(ctx)).toBe('alice-Pa55-word');
  await clearNow(sw);
  expect(await clipboard(ctx)).toBe('');

  // 2. You copied something else after Litewarden did: it survives the clear.
  await copyStub(p, 'Password');
  await expect.poll(() => clipboard(ctx)).toBe('alice-Pa55-word');
  await userCopies(ctx, 'my newer copy');
  await clearNow(sw);
  expect(await clipboard(ctx)).toBe('my newer copy');

  // 3. Litewarden's own username copy after the password also counts as newer.
  await copyStub(p, 'Password');
  await copyStub(p, 'Username');
  await expect.poll(() => clipboard(ctx)).toBe('alice@corpus.test');
  await clearNow(sw);
  expect(await clipboard(ctx)).toBe('alice@corpus.test');

  // 4. A fresh copy after all that is still cleared (the remembered hash moved on).
  await copyStub(p, 'Password');
  await expect.poll(() => clipboard(ctx)).toBe('alice-Pa55-word');
  await clearNow(sw);
  expect(await clipboard(ctx)).toBe('');
  await p.close();
  await page.close();
});
