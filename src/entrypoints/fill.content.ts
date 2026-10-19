// SPDX-License-Identifier: GPL-3.0-only
// Fill engine v1. Injected on demand into every frame of the tab when the user asks to fill; it never runs on
// page load and never reads or sends anything by itself. Fields are found at fill time, so pages that re-render
// their form (SPAs) still work. Order of evidence: autocomplete attributes, then input types, then names/labels.

type Filled = Array<'username' | 'password'>;

const USERISH = /user|e-?mail|login|account|ident|phone|mobile|member|customer|handle/i;
const NOT_USER = /search|query|otp|one.?time|2fa|totp|captcha|code|token|zip|postal|amount|coupon|promo/i;
const TEXTY = new Set(['', 'text', 'email', 'tel', 'username']);

const ac = (el: HTMLInputElement) => (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);

/** Every <input> in document order, descending into open shadow roots. */
function inputs(root: Document | ShadowRoot = document, out: HTMLInputElement[] = []): HTMLInputElement[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode as Element | null; n; n = walker.nextNode() as Element | null) {
    if (n instanceof HTMLInputElement) out.push(n);
    if ((n as Element).shadowRoot) inputs((n as Element).shadowRoot!, out);
  }
  return out;
}

function visible(el: HTMLInputElement): boolean {
  if (!el.isConnected || el.disabled || el.readOnly || el.type === 'hidden') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

function isPassword(el: HTMLInputElement): boolean {
  if (el.type === 'password') return true;
  // A page's own "show password" toggle turns the field into type=text; autocomplete still says what it is.
  const a = ac(el);
  return TEXTY.has(el.type) && (a.includes('current-password') || a.includes('new-password'));
}

function describe(el: HTMLInputElement): string {
  const label = el.labels?.[0]?.textContent ?? '';
  return [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? '', label].join(' ');
}

function isUsernameCandidate(el: HTMLInputElement): boolean {
  if (!TEXTY.has(el.type) || isPassword(el)) return false;
  const a = ac(el);
  if (a.includes('one-time-code') || a.includes('off') && NOT_USER.test(describe(el))) return false;
  return !NOT_USER.test(describe(el)) || a.includes('username') || a.includes('email');
}

const strongUser = (el: HTMLInputElement) => {
  const a = ac(el);
  return a.includes('username') || a.includes('email') || el.type === 'email';
};

interface Plan {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
}

function plan(): Plan {
  const all = inputs().filter(visible);
  const pws = all.filter(isPassword);
  const current = pws.find((p) => ac(p).includes('current-password'));
  // Never put the saved password into a "new password" field (signup and change-password forms).
  const password = current ?? pws.find((p) => !ac(p).includes('new-password')) ?? null;
  const users = all.filter(isUsernameCandidate);
  let username: HTMLInputElement | null = null;
  if (password) {
    // The username sits before the password, in the same form when there is one.
    const before = users.filter((u) => u.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING || u.getRootNode() !== password.getRootNode());
    const sameForm = before.filter((u) => u.form && u.form === password.form);
    const pool = sameForm.length ? sameForm : before;
    username = pool.filter(strongUser).pop() ?? pool.filter((u) => USERISH.test(describe(u))).pop() ?? pool.pop() ?? null;
  } else {
    // Two-step login: a page with only the username step. Only fill a field that clearly asks for it.
    username = users.find(strongUser) ?? users.find((u) => USERISH.test(describe(u))) ?? null;
    // A form full of new-password fields with an email box is a signup form: the email box is still fine to fill.
  }
  return { username, password };
}

function setValue(el: HTMLInputElement, value: string) {
  el.focus({ preventScroll: true });
  // Use the prototype setter so frameworks that track the value (React) notice the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  const opts = { bubbles: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', { ...opts, key: 'Unidentified' }));
  el.dispatchEvent(new InputEvent('input', { ...opts, inputType: 'insertReplacementText', data: value }));
  el.dispatchEvent(new KeyboardEvent('keyup', { ...opts, key: 'Unidentified' }));
  el.dispatchEvent(new Event('change', opts));
}

function probe() {
  const p = plan();
  return { score: p.password ? 2 : p.username ? 1 : 0, origin: location.origin, top: window === window.top };
}

function fill(username: string | null, password: string | null): Filled {
  const p = plan();
  const done: Filled = [];
  if (p.username && username) {
    setValue(p.username, username);
    done.push('username');
  }
  if (p.password && password) {
    setValue(p.password, password);
    done.push('password');
  }
  // Leave focus where the user would press Enter next.
  (p.password ?? p.username)?.focus({ preventScroll: true });
  return done;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    (window as unknown as { __lwProbe: typeof probe }).__lwProbe = probe;
    (window as unknown as { __lwFill: typeof fill }).__lwFill = fill;
  },
});
