// SPDX-License-Identifier: GPL-3.0-only
// Composes the marketing images from the real screenshots (shoot-popup.mjs and shoot-inpage.mjs at --scale 3):
//   docs/img/hero.png, brand/social-preview.png, brand/store/screenshot-1..5.png, brand/store/marquee-1400x560.png.
// Usage: npx tsx scripts/demo/compose.mjs [hero|social|store|marquee ...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { ROOT, } from '../testserver/env.ts';

const RAW = path.join(ROOT, '_testserver', 'demo-shots');
const TMP = path.join(RAW, 'compose');
fs.mkdirSync(TMP, { recursive: true });
const url = (p) => pathToFileURL(p).href;
const popupSrc = (n) => url(path.join(RAW, 'popup@3x', n + '.png'));
const siteSrc = (n) => url(path.join(RAW, 'inpage@3x', n + '.png'));
const font = (w) => url(path.join(ROOT, 'node_modules/@fontsource/hanken-grotesk/files', `hanken-grotesk-latin-${w}-normal.woff2`));
const brand = (f) => url(path.join(ROOT, 'brand', f));

const BLUE = '#1252A3';
const GROUND = '#F1F3F7';
const INK = '#1B2029';

const css = `
${[300, 400, 500, 600, 700, 800].map((w) => `@font-face{font-family:"Hanken Grotesk";font-weight:${w};src:url(${font(w)}) format("woff2")}`).join('\n')}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden;font-family:"Hanken Grotesk",sans-serif;color:${INK};-webkit-font-smoothing:antialiased}
body{position:relative;background:${GROUND}}
.abs{position:absolute}
.popup{position:absolute;overflow:hidden;border-radius:12px;box-shadow:0 0 0 1px rgba(20,28,42,.10),0 2px 6px rgba(20,28,42,.10),0 22px 54px rgba(20,28,42,.24)}
.popup img{position:absolute;display:block}
.popup.dark{box-shadow:0 0 0 1px rgba(255,255,255,.10),0 2px 6px rgba(20,28,42,.16),0 22px 54px rgba(20,28,42,.34)}
.win{position:absolute;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px rgba(20,28,42,.10),0 2px 6px rgba(20,28,42,.08),0 22px 54px rgba(20,28,42,.20)}
.bar{height:40px;background:#E4E8EF;display:flex;align-items:center;gap:7px;padding:0 14px;border-bottom:1px solid #D3D9E2}
.bar i{width:11px;height:11px;border-radius:50%;background:#C5CCD8}
.bar b{margin-left:14px;flex:0 1 420px;height:26px;border-radius:13px;background:#fff;color:#4A5568;font:500 13px/26px "Hanken Grotesk",sans-serif;padding:0 14px;white-space:nowrap}
.view{position:relative;overflow:hidden}
.view img{position:absolute;display:block}
.band{position:absolute;left:0;top:0;right:0;height:128px;background:${BLUE};color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 64px}
.band h1{font-weight:600;font-size:46px;letter-spacing:-.01em;line-height:1.1}
.band img{height:54px}
`;

/** A cropped piece of a screenshot: (x, y, w, h) in CSS px of the original page/popup, shown `w` css px wide. */
function cropped(src, natW, [cx, cy, cw, ch], dw) {
  const k = dw / cw;
  return { html: (img) => `<img src="${src}" style="width:${natW * k}px;left:${-cx * k}px;top:${-cy * k}px">`, h: ch * k };
}

/** A popup (380x600 CSS px natural) or a cropped part of it, `w` px wide, at (x, y). */
function popup(name, x, y, w, { crop = [0, 0, 380, 600], dark = false } = {}) {
  const c = cropped(popupSrc(name), 380, crop, w);
  return `<div class="popup${dark ? ' dark' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${c.h}px">${c.html()}</div>`;
}

/** Browser-like window around a crop of a 1280x800 page shot. Returns html and its total height. */
function windowed(name, x, y, w, crop, host = 'northwind.io/login') {
  const c = cropped(siteSrc(name), 1280, crop, w);
  return {
    html: `<div class="win" style="left:${x}px;top:${y}px;width:${w}px"><div class="bar"><i></i><i></i><i></i><b>${host}</b></div><div class="view" style="height:${c.h}px">${c.html()}</div></div>`,
    h: c.h + 40,
  };
}

const page = (w, h, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${css}${extra}</style></head><body style="width:${w}px;height:${h}px">${body}</body></html>`;

const out = {
  hero() {
    const w = windowed('menu-light', 110, 170, 1000, [0, 0, 1280, 720]);
    return { w: 1600, h: 900, scale: 2, file: 'docs/img/hero.png', html: page(1600, 900, w.html + popup('main-light', 1092, 108, 426)) };
  },
  social() {
    const body = `
<img class="abs" src="${brand('readme/logo-light.svg')}" style="left:92px;top:118px;width:560px">
<div class="abs" style="left:100px;top:300px;width:560px;font-weight:700;font-size:50px;line-height:1.1;letter-spacing:-.015em">Fast password manager for Vaultwarden</div>
<div class="abs" style="left:100px;top:452px;font-weight:500;font-size:24px;color:#4A5568">Free and open source. One key to fill.</div>
${popup('main-light', 770, 84, 380)}`;
    return { w: 1280, h: 640, scale: 1, file: 'brand/social-preview.png', html: page(1280, 640, body) };
  },
  marquee() {
    const body = `
<div class="abs" style="inset:0;background:${BLUE}"></div>
<img class="abs" src="${brand('symbol-white.svg')}" style="left:96px;top:96px;height:64px">
<img class="abs" src="${brand('wordmark.svg')}" style="left:166px;top:112px;height:34px;filter:brightness(0) invert(1)">
<div class="abs" style="left:96px;top:196px;width:600px;color:#fff;font-weight:700;font-size:48px;line-height:1.08;letter-spacing:-.015em">Fast password manager for Vaultwarden</div>
<div class="abs" style="left:96px;top:352px;width:600px;color:#CFE0F5;font-weight:500;font-size:22px;line-height:1.45">One key to fill. 2FA codes built in.<br>PIN unlock. Free and open source.</div>
${popup('main-dark', 1060, 44, 310, { dark: true })}
${popup('main-light', 725, 92, 350)}`;
    return { w: 1400, h: 560, scale: 1, file: 'brand/store/marquee-1400x560.png', html: page(1400, 560, body) };
  },
};

const band = (t) => `<div class="band"><h1>${t}</h1><img src="${brand('symbol-white.svg')}"></div>`;
const store = {
  1() {
    const w = windowed('menu-light', 60, 128 + 108, 780, [490, 100, 790, 420]);
    return [band('Your logins for the site, one key to fill'), w.html, popup('main-light', 880, 128 + 68, 340)];
  },
  2() {
    const w = windowed('save-light', 64, 128 + 62, 1152, [232, 0, 1048, 470], 'northwind.io/dashboard');
    return [band('Save new logins as you sign in'), w.html];
  },
  3() {
    return [band('Unlock with a 6-digit PIN'), popup('unlock-pin-light', 100, 128 + 126, 532, { crop: [0, 0, 380, 300] }), popup('unlock-pin-dark', 648, 128 + 126, 532, { crop: [0, 0, 380, 300], dark: true })];
  },
  4() {
    return [band('Search, then copy the 2FA code'), popup('item-cloudflare-light-search', 100, 128 + 214, 532, { crop: [0, 0, 380, 185] }), popup('item-cloudflare-light', 690, 128 + 90, 494, { crop: [0, 0, 380, 372] })];
  },
  5() {
    return [band('Light and dark, with settings for everything'), popup('main-light', 40, 128 + 40, 380), popup('main-dark', 450, 128 + 40, 380, { dark: true }), popup('settings-home-dark', 860, 128 + 40, 380, { dark: true })];
  },
};
for (const n of [1, 2, 3, 4, 5]) out[`store${n}`] = () => ({ w: 1280, h: 800, scale: 1, file: `brand/store/screenshot-${n}.png`, html: page(1280, 800, store[n]().join('\n')) });

const want = process.argv.slice(2);
const names = Object.keys(out).filter((k) => !want.length || want.includes(k) || (want.includes('store') && k.startsWith('store')));
const browser = await chromium.launch({ channel: 'chromium' });
for (const k of names) {
  const spec = out[k]();
  const file = path.join(TMP, `${k}.html`);
  fs.writeFileSync(file, spec.html);
  const p = await browser.newPage({ viewport: { width: spec.w, height: spec.h }, deviceScaleFactor: spec.scale });
  await p.goto(url(file));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const dest = path.join(ROOT, spec.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await p.screenshot({ path: dest });
  await p.close();
  console.log(k, spec.file);
}
await browser.close();
