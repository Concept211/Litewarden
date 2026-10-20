// SPDX-License-Identifier: GPL-3.0-only
// Popup screenshots for the README and the Web Store, at the real popup size (380x600), from the demo vault.
// Usage: npx tsx scripts/demo/shoot-popup.mjs [--scale 2]
import path from 'node:path';
import fs from 'node:fs';
import { launch, openPopup, signIn, OUT, ORIGIN } from './lib.mjs';
import { demoCreds } from './seed-demo.mjs';

const scale = Number(process.argv.includes('--scale') ? process.argv[process.argv.indexOf('--scale') + 1] : 2);
const dir = path.join(OUT, `popup@${scale}x`);
fs.mkdirSync(dir, { recursive: true });
const save = (p, name) => p.screenshot({ path: path.join(dir, `${name}.png`) });
const settle = (p, ms = 900) => p.waitForTimeout(ms);

const env = await launch({ scale, width: 1280, height: 800 });
const { ctx } = env;
const creds = demoCreds();
const site = await ctx.newPage();
await site.goto(ORIGIN + '/login');
(await signIn(env, site)).close();

// PIN on (6 digits), so the lock screen is the PIN screen.
{
  const p = await openPopup(env, site);
  await p.click('button[aria-label="Settings"]');
  await p.click('[data-cat=security]');
  await p.locator('.set', { hasText: 'Unlock with a PIN' }).locator('.sw').click();
  await p.waitForSelector('input[aria-label="New PIN digit 1"]:focus');
  await p.keyboard.type(creds.pin);
  await p.waitForSelector('input[aria-label="Repeat PIN digit 1"]:focus');
  await p.keyboard.type(creds.pin);
  await p.click('button:has-text("Turn on PIN")');
  await p.locator('#toast').waitFor();
  await p.close();
}

// Warm the icon cache for the current-site cards: a fresh popup paints them before it has loaded its icon map
// (src/ui/bits.tsx initIcons), so they would show letter tiles. Rows in the search list load and persist theirs.
{
  const p = await openPopup(env, null);
  await p.waitForSelector('#q');
  await p.keyboard.type('northwind');
  await settle(p, 2500);
  await p.close();
}

async function main(theme, name) {
  const p = await openPopup(env, site, { theme });
  await p.waitForSelector('.card');
  await settle(p, 1800);
  await save(p, name);
  await p.close();
}
await main('light', 'main-light');
await main('dark', 'main-dark');

// Item view with the live 2FA code: GitHub, found by search.
async function itemView(theme, name, q = 'github') {
  const p = await openPopup(env, null, { theme });
  await p.waitForSelector('#q');
  await p.keyboard.type(q);
  await settle(p, 1500);
  await save(p, name + '-search');
  await p.locator('.row button[aria-label^="Open"], .card button[aria-label^="Open"]').first().click().catch(async () => {
    await p.keyboard.press('Enter');
  });
  await p.waitForSelector('.code-big');
  await settle(p, 800);
  await save(p, name);
  return p;
}
(await itemView('dark', 'item-view-dark')).close();
(await itemView('light', 'item-view-light')).close();
// Store shot 4: a search with a couple of matches, then the item with its 2FA code.
(await itemView('light', 'item-cloudflare-light', 'cloud')).close();
(await itemView('dark', 'item-cloudflare-dark', 'cloud')).close();

// Settings home, dark.
{
  const p = await openPopup(env, site, { theme: 'dark' });
  await p.waitForSelector('#q');
  await p.click('button[aria-label="Settings"]');
  await p.waitForSelector('.cat');
  await settle(p);
  await save(p, 'settings-home-dark');
  await p.keyboard.press('Escape');
  await p.close();
  const l = await openPopup(env, site, { theme: 'light' });
  await l.waitForSelector('#q');
  await l.click('button[aria-label="Settings"]');
  await l.waitForSelector('.cat');
  await settle(l);
  await save(l, 'settings-home-light');
  await l.close();
}

// Edit with the password generator open.
{
  const p = await openPopup(env, site, { theme: 'light' });
  await p.waitForSelector('.card');
  await p.locator('.card', { hasText: 'Northwind' }).first().locator('button[aria-label^="Open"]').click();
  await p.waitForSelector('.code-big');
  await p.click('button:has-text("Edit")');
  await p.waitForSelector('#f-user');
  await settle(p);
  await save(p, 'edit-light-plain');
  await p.click('button[aria-label="Generate a password"]');
  await settle(p);
  await save(p, 'edit-light');
  await p.close();
}

// PIN unlock, light and dark.
for (const theme of ['light', 'dark']) {
  const p = await openPopup(env, site, { theme });
  await p.waitForSelector('#q');
  await p.click('button[aria-label="Lock"]');
  await p.locator('input[aria-label="PIN digit 1"]').waitFor();
  await settle(p);
  await save(p, `unlock-pin-${theme}`);
  await p.keyboard.type(creds.pin);
  await p.waitForSelector('#q', { timeout: 20_000 });
  await p.close();
}
await ctx.close();
console.log('done', dir);
