// SPDX-License-Identifier: GPL-3.0-only
// "Scan the QR code on the page": a site's 2FA setup shows a QR code; read it from a screenshot of the visible
// tab, here in the popup. The image never leaves the browser. The decoder loads only when asked.
import { findCode, pixels, qrSpots, read, type ScanResult } from '../../shared/qr';
import type { Tab } from './boot';

export { findCode, patches, read, type Box, type ScanResult } from '../../shared/qr';

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
  const spots = chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: qrSpots })
    .then((r) => r[0]?.result ?? null)
    .catch(() => null);
  const [{ default: jsQR }, px, s] = await Promise.all([import('jsqr'), pixels(shot), spots]);
  // The screenshot is in device pixels; the page measures in CSS pixels.
  const k = s?.vw ? px.width / s.vw : 1;
  const boxes = (s?.boxes ?? []).map((b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }));
  return read(findCode(jsQR, px, boxes, k));
}
