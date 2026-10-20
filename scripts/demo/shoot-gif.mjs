// SPDX-License-Identifier: GPL-3.0-only
// Frames for docs/img/demo.gif: focus the email field, click the Litewarden icon, pick a login, it fills, sign in.
// Writes numbered PNG frames and frames.json (durations in ms) into _testserver/demo-shots/gif; make-gif.py joins them.
// Usage: npx tsx scripts/demo/shoot-gif.mjs
import path from 'node:path';
import fs from 'node:fs';
import { launch, signIn, OUT, ORIGIN, clickFieldIcon, fieldIcons, surface } from './lib.mjs';

const dir = path.join(OUT, 'gif');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const CLIP = { x: 490, y: 100, width: 790, height: 430 };
const CLIP_DASH = { x: 232, y: 24, width: 790, height: 430 };
const SCALE = 2;

const env = await launch({ scale: SCALE, width: 1280, height: 800 });
const { ctx } = env;
const site = await ctx.newPage();
await site.goto(ORIGIN + '/login');
(await signIn(env, site)).close();
for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
await site.goto(ORIGIN + '/login');
for (let i = 0; i < 50 && (await fieldIcons(site)).length < 2; i++) await site.waitForTimeout(100);

// The pointer is drawn onto the frames afterwards (make-gif.py): an element in the page would count as covering the
// menu, and Litewarden ignores clicks on a covered menu.
let shown = false;
const frames = [];
let cur = { x: 1150, y: 560 };
async function snap(ms, clip = CLIP) {
  const n = String(frames.length).padStart(3, '0');
  await site.screenshot({ path: path.join(dir, `${n}.png`), clip });
  frames.push({ ms, pos: shown ? { x: cur.x - clip.x, y: cur.y - clip.y } : null });
}
async function pointer(x, y) {
  shown = true;
  cur = { x, y };
}
async function moveTo(x, y, steps = 4, ms = 70) {
  const a = cur;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t * t * (3 - 2 * t);
    const px = a.x + (x - a.x) * e, py = a.y + (y - a.y) * e;
    await site.mouse.move(px, py);
    await pointer(px, py);
    await snap(ms);
  }
}

await snap(800);
// 1. into the email field, then the Litewarden icon inside it
const email = await site.locator('#email').boundingBox();
await moveTo(email.x + 120, email.y + email.height / 2, 5);
await site.mouse.click(email.x + 120, email.y + email.height / 2);
await snap(450);
const ic = (await fieldIcons(site))[0];
await moveTo(ic.x + ic.w / 2, ic.y + ic.h / 2, 4);
await snap(220);
await site.mouse.click(ic.x + ic.w / 2, ic.y + ic.h / 2);
await surface(site, 'menu');
await site.waitForTimeout(500);
await snap(1500);
// 2. pick the first login
const { frame } = await surface(site, 'menu');
const fb = await (await frame.frameElement()).boundingBox();
const inner = await frame.locator('.m-row').first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
//console.log('fb', JSON.stringify(fb), 'inner', JSON.stringify(inner));
const row = { x: fb.x + inner.x, y: fb.y + inner.y, width: inner.width, height: inner.height };
await moveTo(row.x + 150, row.y + row.height / 2, 4);
await snap(500);
//console.log('sel before click', await frame.evaluate(() => document.querySelector('.is-sel .nm')?.textContent));
await frame.locator('.m-row').first().click({ position: { x: 150, y: row.height / 2 } });
await site.waitForTimeout(500);
//console.log('menu text', await frame.evaluate(() => document.body.innerText.slice(0,200)).catch(e=>String(e)));
//console.log('email after', JSON.stringify(await site.inputValue('#email')), 'frames', site.frames().length);
await snap(1400);
// 3. sign in
const go = await site.locator('button.go').boundingBox();
await moveTo(go.x + go.width / 2, go.y + go.height / 2, 4);
await snap(350);
shown = false;
await site.click('button.go');
await site.waitForURL(/dashboard/);
await site.waitForTimeout(500);
await snap(2200, CLIP_DASH);
fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
await ctx.close();
console.log('frames', frames.length, 'total ms', frames.reduce((a, b) => a + b.ms, 0));
