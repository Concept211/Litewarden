// SPDX-License-Identifier: GPL-3.0-only
// Finding and reading a 2FA setup QR code in a screenshot of the visible tab. Pure: the caller captures the tab and
// passes the decoder (jsQR), so the popup can load it only when asked and the worker can bundle it.

export type ScanResult = { ok: true; uri: string; label: string } | { ok: false; message: string };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export type Decoder = (data: Uint8ClampedArray, width: number, height: number, o?: { inversionAttempts?: 'dontInvert' | 'attemptBoth' }) => { data: string } | null;

/** Runs in the page: the squarish images, canvases and SVGs in view, where a QR code would be drawn. */
export function qrSpots(): { vw: number; boxes: Box[] } {
  const vw = innerWidth;
  const vh = innerHeight;
  const boxes: Box[] = [];
  for (const el of document.querySelectorAll('img, canvas, svg, object, [style*="background"]')) {
    if (el.parentElement?.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    const ratio = r.width / r.height;
    if (r.width < 64 || r.height < 64 || ratio < 0.75 || ratio > 1.33) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  // Big squares first: a page's icons are small, its setup QR code isn't.
  boxes.sort((a, b) => b.w * b.h - a.w * a.h);
  return { vw, boxes: boxes.slice(0, 24) };
}

/** The text of a QR code in the screenshot, or ''. The decoder loses its way in a whole busy page, so it looks
 * where the page drew squares first, then at square patches dense with black and white (a code inside a frame, or
 * drawn some other way), then at the whole shot. `k` is device pixels per CSS pixel. */
export function findCode(jsQR: Decoder, img: Img, boxes: Box[], k = 1): string {
  const at = (b: Box) => {
    // Room for the white border around the code, which the element may not include.
    const pad = Math.max(8 * k, 0.12 * Math.max(b.w, b.h));
    const c = crop(img, b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
    if (!c) return '';
    const hit = jsQR(c.data, c.width, c.height, { inversionAttempts: 'attemptBoth' }) ?? (Math.max(c.width, c.height) < 400 ? decodeBig(jsQR, c) : null);
    return hit?.data.trim() ?? '';
  };
  for (const b of boxes) {
    const s = at(b);
    if (s) return s;
  }
  for (const b of patches(img, k)) {
    const s = at(b);
    if (s) return s;
  }
  return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data.trim() ?? '';
}

/** Square patches of the shot full of sharp light/dark edges both ways, as a QR code is. Text is too, but a line
 * of it is wide, not square. */
export function patches(img: Img, k = 1): Box[] {
  const { width: w, height: h, data: d } = img;
  const cell = Math.max(8, Math.round(10 * k));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (d[i * 4]! * 77 + d[i * 4 + 1]! * 150 + d[i * 4 + 2]! * 29) >> 8;
  const across = new Uint16Array(cw * ch);
  const down = new Uint16Array(cw * ch);
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const c = ((y / cell) | 0) * cw + ((x / cell) | 0);
      if (Math.abs(g[i]! - g[i + 1]!) > 80) across[c]!++;
      if (Math.abs(g[i]! - g[i + w]!) > 80) down[c]!++;
    }
  const min = (cell * cell) / 20;
  const busy = new Uint8Array(cw * ch);
  for (let c = 0; c < cw * ch; c++) busy[c] = across[c]! >= min && down[c]! >= min ? 1 : 0;
  // Close the small gaps (a finder pattern's solid middle has no edges).
  const grown = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      for (let j = Math.max(0, y - 1); j <= Math.min(ch - 1, y + 1) && !grown[y * cw + x]; j++)
        for (let i = Math.max(0, x - 1); i <= Math.min(cw - 1, x + 1); i++) if (busy[j * cw + i]) grown[y * cw + x] = 1;
  const out: Array<Box & { fill: number }> = [];
  const seen = new Uint8Array(cw * ch);
  for (let s = 0; s < cw * ch; s++) {
    if (!grown[s] || seen[s]) continue;
    let [x0, y0, x1, y1, n, hot] = [cw, ch, 0, 0, 0, 0];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % cw;
      const y = (c / cw) | 0;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      n++;
      hot += busy[c]!;
      for (const o of [x > 0 ? c - 1 : -1, x < cw - 1 ? c + 1 : -1, c - cw, c + cw])
        if (o >= 0 && o < cw * ch && grown[o] && !seen[o]) {
          seen[o] = 1;
          stack.push(o);
        }
    }
    const bw = (x1 - x0 + 1) * cell;
    const bh = (y1 - y0 + 1) * cell;
    const ratio = bw / bh;
    if (bw < 48 * k || bh < 48 * k || ratio < 0.6 || ratio > 1.6) continue;
    out.push({ x: x0 * cell, y: y0 * cell, w: bw, h: bh, fill: hot / ((x1 - x0 + 1) * (y1 - y0 + 1)) });
  }
  return out
    .filter((b) => b.fill > 0.4)
    .sort((a, b) => b.fill - a.fill)
    .slice(0, 12);
}

/** A small code with thin modules decodes better twice the size. */
function decodeBig(jsQR: Decoder, c: Img) {
  const w = c.width * 2;
  const h = c.height * 2;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = new Uint32Array(c.data.buffer, c.data.byteOffset, c.width * c.height);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dst[y * w + x] = src[(y >> 1) * c.width + (x >> 1)]!;
  return jsQR(out, w, h, { inversionAttempts: 'attemptBoth' });
}

function crop(img: Img, x: number, y: number, w: number, h: number): Img | null {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  if (x1 - x0 < 32 || y1 - y0 < 32) return null;
  const cw = x1 - x0;
  const out = new Uint8ClampedArray(cw * (y1 - y0) * 4);
  for (let j = y0; j < y1; j++) out.set(img.data.subarray((j * img.width + x0) * 4, (j * img.width + x1) * 4), (j - y0) * cw * 4);
  return { data: out, width: cw, height: y1 - y0 };
}

/** What a scanned QR code means for the 2FA field. */
export function read(code: string): ScanResult {
  if (!code) return { ok: false, message: 'No QR code found on the page. Scroll it into view, then scan again.' };
  if (/^otpauth-migration:/i.test(code)) return { ok: false, message: "That's a Google Authenticator export, which holds many keys. Use the site's own QR code." };
  if (/^otpauth:\/\/hotp\//i.test(code)) return { ok: false, message: "That code is counter based (HOTP), which Litewarden doesn't do. Ask the site for an authenticator app (TOTP) code." };
  if (!/^otpauth:\/\/totp\//i.test(code)) return { ok: false, message: "That QR code isn't a 2FA setup code." };
  let u: URL;
  try {
    u = new URL(code);
  } catch {
    return { ok: false, message: "That QR code isn't a 2FA setup code." };
  }
  if (!u.searchParams.get('secret')) return { ok: false, message: 'That 2FA code has no key in it.' };
  // otpauth://totp/Issuer:account?secret=...&issuer=Issuer
  const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const label = [u.searchParams.get('issuer') ?? (path.includes(':') ? path.split(':')[0] : ''), path.includes(':') ? path.split(':').slice(1).join(':') : path]
    .map((x) => x?.trim())
    .filter((x, i, a) => x && a.indexOf(x) === i)
    .join(', ');
  return { ok: true, uri: code, label };
}

export async function pixels(dataUrl: string): Promise<ImageData> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}
