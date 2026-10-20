// SPDX-License-Identifier: GPL-3.0-only
// In-page screenshots (field icon, menu, save prompt) on the demo sign-in page, full viewport.
// Usage: npx tsx scripts/demo/shoot-inpage.mjs [--scale 2]
import path from 'node:path';
import fs from 'node:fs';
import { launch, openPopup, signIn, OUT, ORIGIN, clickFieldIcon, fieldIcons, surface } from './lib.mjs';

const scale = Number(process.argv.includes('--scale') ? process.argv[process.argv.indexOf('--scale') + 1] : 2);
const dir = path.join(OUT, `inpage@${scale}x`);
fs.mkdirSync(dir, { recursive: true });
const save = (p, name) => p.screenshot({ path: path.join(dir, `${name}.png`) });

const env = await launch({ scale, width: 1280, height: 800 });
const { ctx } = env;
const site = await ctx.newPage();
await site.goto(ORIGIN + '/login');
(await signIn(env, site)).close();
// Extension tabs open at the same time stop clicks reaching our frames in other tabs (harness quirk): close them.
for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();

async function ready(p) {
  await p.goto(ORIGIN + '/login');
  for (let i = 0; i < 50 && (await fieldIcons(p)).length < 2; i++) await p.waitForTimeout(100);
}

for (const theme of ['light', 'dark']) {
  await site.emulateMedia({ colorScheme: theme });
  await ready(site);
  await site.mouse.move(40, 780);
  await save(site, `icons-${theme}`);
  await clickFieldIcon(site, '#email');
  const { box } = await surface(site, 'menu');
  await site.waitForTimeout(900);
  await site.mouse.move(40, 780);
  console.log(theme, 'menu', JSON.stringify(box));
  await save(site, `menu-${theme}`);
  await site.keyboard.press('Escape');
  await site.waitForTimeout(300);
}

// Save prompt: a login the vault doesn't have yet.
await site.emulateMedia({ colorScheme: 'light' });
for (const theme of ['light', 'dark']) {
  await site.emulateMedia({ colorScheme: theme });
  await ready(site);
  await site.fill('#email', 'a.morgan@studiom.example');
  await site.fill('#pw', 'Quartz-Meadow-Lantern-82');
  await site.click('button.go');
  await site.waitForURL(/dashboard/);
  const { box } = await surface(site, 'prompt', 15_000);
  await site.waitForTimeout(1000);
  await site.mouse.move(40, 780);
  console.log(theme, 'prompt', JSON.stringify(box));
  await save(site, `save-${theme}`);
  // dismiss without saving
  await site.goto(ORIGIN + '/login');
  await site.waitForTimeout(500);
}
await ctx.close();
console.log('done', dir);
