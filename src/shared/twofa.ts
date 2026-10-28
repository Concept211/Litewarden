// SPDX-License-Identifier: GPL-3.0-only
// Spotting a site's 2FA setup page ("scan this code with your authenticator app", a QR code, a typed key) so
// Litewarden can offer to add the key to the login. The finder runs in the page's content script and only reports
// what it saw to the worker; it never reads the vault. A QR code alone is just a square image here: the worker
// decides whether it really is a 2FA code by reading a screenshot.
import { qrSpots, type Box } from './qr';

/** Words a setup page uses. Needed before anything else is looked at. */
export const SETUP_WORDS = /authenticator|two[-\s]?(step|factor)|2-?step|2fa|\bmfa\b|multi[-\s]?factor|one[-\s]?time (pass|code)|\btotp\b|verification app|security app/i;
/** A QR code also needs one of these nearby: setup pages ask you to scan. */
const SCAN_WORDS = /scan|qr|authenticator/i;

/** The base32 key in a string such as "NKUT D4NP EE6O K237" or "jbsw y3dp ehpk 3pxp", uppercased with the spaces
 * removed, or null. Strict on purpose: a typed key is the only proof besides a QR code. */
export function cleanKey(text: string | null | undefined): string | null {
  if (!text) return null;
  let s = text.trim().replace(/^[^:：]{0,24}[:：]\s*/, '');
  if (s.length > 96) return null;
  // One case only: real keys are shown all upper or all lower case, prose is mixed.
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return null;
  s = s.toUpperCase();
  if (!/^[A-Z2-7]+(?:[ -][A-Z2-7]+)*$/.test(s)) return null;
  const groups = s.split(/[ -]/);
  const key = groups.join('');
  if (key.length < 16 || key.length > 64 || !/[A-Z]/.test(key)) return null;
  if (groups.length === 1) {
    // One long run: needs letters and digits mixed in (not a word, not a number).
    if (!/[2-7]/.test(key) || !/[A-Z]/.test(key)) return null;
  } else {
    // Groups of the same size (the last may be shorter).
    const n = groups[0]!.length;
    if (n < 3 || n > 8 || groups.slice(0, -1).some((g) => g.length !== n) || groups.at(-1)!.length > n) return null;
  }
  return key;
}

/** An otpauth://totp/ link inside an attribute or text (also the URL-encoded form in a QR image's address). */
export function otpauthIn(s: string | null | undefined): string | null {
  if (!s || !/otpauth/i.test(s)) return null;
  let t = s;
  if (/otpauth%3A/i.test(t)) {
    const m = /otpauth%3A[^&"'\s]+/i.exec(t);
    try {
      t = m ? decodeURIComponent(m[0]) : t;
    } catch {
      return null;
    }
  }
  const m = /otpauth:\/\/totp\/[^\s"'<>]+/i.exec(t);
  if (!m) return null;
  try {
    return new URL(m[0]).searchParams.get('secret') ? m[0] : null;
  } catch {
    return null;
  }
}

/** The key inside a secret (an otpauth:// URI or a bare key), normalized for comparing. */
export function keyOf(secret: string): string {
  const s = secret.trim();
  if (/^otpauth:/i.test(s)) {
    try {
      return (new URL(s).searchParams.get('secret') ?? '').toUpperCase().replace(/[\s=-]/g, '');
    } catch {
      return '';
    }
  }
  return s.toUpperCase().replace(/[\s=-]/g, '');
}

/** Issuer and account from an otpauth:// URI ("otpauth://totp/Issuer:account?issuer=Issuer"). */
export function otpLabel(secret: string): { issuer: string | null; account: string | null } {
  if (!/^otpauth:/i.test(secret.trim())) return { issuer: null, account: null };
  try {
    const u = new URL(secret.trim());
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    const [a, ...b] = path.split(':');
    const account = (b.length ? b.join(':') : a)?.trim() || null;
    const issuer = u.searchParams.get('issuer')?.trim() || (b.length ? a!.trim() : '') || null;
    return { issuer, account };
  } catch {
    return { issuer: null, account: null };
  }
}

export interface SetupSeen {
  /** otpauth:// URI found in the page (a link, an image address, text). */
  uri: string | null;
  /** A typed key (uppercased, no spaces). */
  key: string | null;
  /** Squarish images, canvases and SVGs in view that could be the QR code (CSS px). */
  boxes: Box[];
  /** Viewport width in CSS px (the worker scales boxes to the screenshot). */
  vw: number;
  /** Where the key is shown, so the card doesn't cover it (CSS px). */
  keyBox: Box | null;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SVG', 'CODE-MIRROR']);
const MAX_TEXT = 300_000;

/** Runs in the page. What this page shows of a 2FA setup, or null when it doesn't talk about 2FA at all. With
 * the words but nothing to read yet (the QR code scrolled out of view), every field is empty. */
export function findSetup(doc: Document = document): SetupSeen | null {
  const body = doc.body;
  if (!body) return null;
  // Cheap gate first: the words, anywhere (one native read).
  const all = body.textContent ?? '';
  if (!SETUP_WORDS.test(all.length > MAX_TEXT ? all.slice(0, MAX_TEXT) : all)) return null;

  let uri: string | null = null;
  for (const el of doc.querySelectorAll('a[href*="otpauth" i], img[src*="otpauth" i], input[value*="otpauth" i], [data-uri*="otpauth" i], [data-url*="otpauth" i], [data-value*="otpauth" i], [title*="otpauth" i]')) {
    for (const a of ['href', 'src', 'value', 'data-uri', 'data-url', 'data-value', 'title']) {
      uri = otpauthIn(el.getAttribute(a));
      if (uri) break;
    }
    if (uri) break;
  }

  // The page's own text (not scripts), to check the words again and find a typed key.
  let text = '';
  let key: string | null = null;
  let keyEl: Element | null = null;
  // 4 = NodeFilter.SHOW_TEXT; 1 / 2 = FILTER_ACCEPT / FILTER_REJECT (numbers, so this also runs outside a browser).
  const tw = doc.createTreeWalker(body, 4, {
    acceptNode: (n) => (SKIP.has((n.parentElement?.tagName ?? '').toUpperCase()) ? 2 : 1),
  });
  for (let n = tw.nextNode(), seen = 0; n && seen < 20_000 && text.length < MAX_TEXT; n = tw.nextNode(), seen++) {
    const t = n.nodeValue ?? '';
    text += t + ' ';
    if (!uri && /otpauth:/i.test(t)) uri = otpauthIn(t);
    if (key || !/[A-Za-z2-7]{3}/.test(t)) continue;
    // The key may be split over several spans (one per group): grow to the parent while it is still short.
    for (let el = n.parentElement, up = 0; el && up < 3; el = el.parentElement, up++) {
      const s = el.textContent ?? '';
      if (s.length > 100) break;
      const k = cleanKey(s);
      if (k) {
        key = k;
        keyEl = el;
      }
    }
  }
  // Keys shown in read-only fields.
  if (!key)
    for (const i of doc.querySelectorAll<HTMLInputElement>('input[readonly], input[disabled]')) {
      const k = cleanKey(i.value);
      if (k) {
        key = k;
        keyEl = i;
        break;
      }
    }
  if (!SETUP_WORDS.test(text) && !uri) return null;

  const spots = qrSpots();
  const boxes = SCAN_WORDS.test(text) || uri ? spots.boxes.filter((b) => b.w >= 80) : [];
  const r = keyEl?.getBoundingClientRect();
  return { uri, key, boxes, vw: spots.vw, keyBox: r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
}

/** Runs in the page. The field where the site wants the 6-digit code, or the row of one-digit boxes. */
export function codeFields(doc: Document = document): HTMLInputElement[] {
  const shown = (i: HTMLInputElement) => {
    const r = i.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(i);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const ok = Array.from(doc.querySelectorAll<HTMLInputElement>('input')).filter(
    (i) => !i.disabled && !i.readOnly && ['text', 'tel', 'number', ''].includes(i.type) && i.getAttribute('type') !== 'password' && shown(i),
  );
  // Six (or so) one-character boxes next to each other.
  const singles = ok.filter((i) => i.maxLength === 1);
  if (singles.length >= 6) {
    const p = singles[0]!.parentElement?.parentElement;
    const run = singles.filter((i) => p?.contains(i));
    if (run.length >= 6 && run.length <= 8) return run;
  }
  const HINT = /one.?time|otp|totp|2fa|mfa|code|token|verif|digits|authenticat/i;
  let best: HTMLInputElement | null = null;
  let top = 1;
  for (const i of ok) {
    if (i.maxLength === 1) continue;
    const words = [i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.labels?.[0]?.textContent].join(' ');
    let s = 0;
    if (i.autocomplete === 'one-time-code') s += 4;
    if (HINT.test(words)) s += 2;
    if (/^[\s0-9•·_-]{6,}$/.test(i.placeholder) && /\d/.test(i.placeholder)) s += 2;
    if (i.inputMode === 'numeric' || i.type === 'tel' || i.type === 'number') s += 1;
    if (i.maxLength >= 6 && i.maxLength <= 8) s += 1;
    if (/user|email|name|search|phone|address/i.test(`${i.name} ${i.id} ${i.autocomplete}`)) s -= 3;
    if (s > top) {
      top = s;
      best = i;
    }
  }
  return best ? [best] : [];
}
