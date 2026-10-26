// SPDX-License-Identifier: GPL-3.0-only
// "Scan the QR code on the page": a site's 2FA setup shows a QR code; read it from a screenshot of the visible
// tab, here in the popup. The image never leaves the browser. The decoder loads only when asked.
import type { Tab } from './boot';

export type ScanResult = { ok: true; uri: string; label: string } | { ok: false; message: string };

export async function scanTab(tab: Tab | null): Promise<ScanResult> {
  if (!tab || !/^https?:/i.test(tab.url)) return { ok: false, message: 'Open the page with the QR code first.' };
  const t = await chrome.tabs.get(tab.id).catch(() => null);
  if (!t?.active) return { ok: false, message: 'Switch to the tab with the QR code, then scan again.' };
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  } catch {
    return { ok: false, message: "Litewarden can't see this page." };
  }
  const [{ default: jsQR }, px] = await Promise.all([import('jsqr'), pixels(shot)]);
  const code = jsQR(px.data, px.width, px.height, { inversionAttempts: 'attemptBoth' })?.data.trim() ?? '';
  return read(code);
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

async function pixels(dataUrl: string): Promise<ImageData> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}
