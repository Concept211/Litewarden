// SPDX-License-Identifier: GPL-3.0-only
// Login-field detection, shared by the fill script (injected when the user asks to fill) and the in-page content
// script (field icons, menu, save prompt, teach this site). Plain DOM, no imports, so both bundles stay small.
// Order of evidence: autocomplete attributes, then input types, then names and labels.

const USERISH = /user|e-?mail|login|account|ident|phone|mobile|member|customer|handle/i;
const NOT_USER = /search|query|otp|one.?time|2fa|totp|captcha|code|token|zip|postal|amount|coupon|promo/i;
const TEXTY = new Set(['', 'text', 'email', 'tel', 'username']);
const SIGN_IN = /sign.?in|log.?in|log.?on|auth/i;

export const ac = (el: HTMLInputElement) => (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);

/** Every <input> in document order, descending into open shadow roots. */
export function inputs(root: Document | ShadowRoot | Element = document, out: HTMLInputElement[] = []): HTMLInputElement[] {
  const doc = root instanceof Document ? root : root.ownerDocument!;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode as Element | null; n; n = walker.nextNode() as Element | null) {
    if (n instanceof HTMLInputElement) out.push(n);
    if ((n as Element).shadowRoot) inputs((n as Element).shadowRoot!, out);
  }
  return out;
}

export function visible(el: HTMLInputElement): boolean {
  if (!el.isConnected || el.disabled || el.readOnly || el.type === 'hidden') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

export function isPassword(el: HTMLInputElement): boolean {
  if (el.type === 'password') return true;
  // A page's own "show password" toggle turns the field into type=text; autocomplete still says what it is.
  const a = ac(el);
  return TEXTY.has(el.type) && (a.includes('current-password') || a.includes('new-password'));
}

export const isNewPassword = (el: HTMLInputElement) => ac(el).includes('new-password');

export function describe(el: HTMLInputElement): string {
  const label = el.labels?.[0]?.textContent ?? '';
  return [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? '', label].join(' ');
}

export function isUsernameCandidate(el: HTMLInputElement): boolean {
  if (!TEXTY.has(el.type) || isPassword(el)) return false;
  const a = ac(el);
  if (a.includes('one-time-code') || (a.includes('off') && NOT_USER.test(describe(el)))) return false;
  return !NOT_USER.test(describe(el)) || a.includes('username') || a.includes('email');
}

export const strongUser = (el: HTMLInputElement) => {
  const a = ac(el);
  return a.includes('username') || a.includes('email') || el.type === 'email';
};

/**
 * The username step of a two-step sign-in that doesn't mark its field (T-Mobile: type=text, autocomplete=on, "Email or
 * phone number"). Only when the field asks for a username, email or phone, it is the one text field in its form, and
 * the page or the form says sign-in, so a newsletter or contact form doesn't get the icon.
 */
function loneStepUser(el: HTMLInputElement, all: HTMLInputElement[]): boolean {
  if (!USERISH.test(describe(el))) return false;
  if (all.filter((i) => TEXTY.has(i.type) && i.form === el.form).length !== 1) return false;
  const doc = el.ownerDocument;
  return SIGN_IN.test(`${doc.location.pathname} ${doc.title} ${el.form?.getAttribute('action') ?? ''}`);
}

const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) || a.getRootNode() !== b.getRootNode();

/** The username field that goes with `password`: before it, in the same form when there is one. */
export function partnerOf(password: HTMLInputElement, users: HTMLInputElement[]): HTMLInputElement | null {
  const prior = users.filter((u) => before(u, password));
  const sameForm = prior.filter((u) => u.form && u.form === password.form);
  const pool = sameForm.length ? sameForm : prior;
  return pool.filter(strongUser).pop() ?? pool.filter((u) => USERISH.test(describe(u))).pop() ?? pool.pop() ?? null;
}

export interface Plan {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
}

/** The fields a fill would use on this page (or under `root`). */
export function plan(root: Document | ShadowRoot | Element = document): Plan {
  const all = inputs(root).filter(visible);
  const pws = all.filter(isPassword);
  const current = pws.find((p) => ac(p).includes('current-password'));
  // Never put the saved password into a "new password" field (signup and change-password forms).
  const password = current ?? pws.find((p) => !isNewPassword(p)) ?? null;
  const users = all.filter(isUsernameCandidate);
  if (password) return { username: partnerOf(password, users), password };
  // Two-step login: a page with only the username step. Only a field that clearly asks for it.
  return { username: users.find(strongUser) ?? users.find((u) => USERISH.test(describe(u))) ?? null, password: null };
}

export type Role = 'username' | 'password';

/** Every field that gets the Litewarden icon: current-password fields, their usernames, and two-step username pages. */
export function loginFields(root: Document | ShadowRoot = document): Array<{ el: HTMLInputElement; role: Role }> {
  const all = inputs(root).filter(visible);
  const users = all.filter(isUsernameCandidate);
  const out: Array<{ el: HTMLInputElement; role: Role }> = [];
  const seen = new Set<HTMLInputElement>();
  const add = (el: HTMLInputElement | null, role: Role) => {
    if (el && !seen.has(el) && el.getBoundingClientRect().width >= 60) {
      seen.add(el);
      out.push({ el, role });
    }
  };
  const pws = all.filter((p) => isPassword(p) && !isNewPassword(p));
  for (const p of pws) {
    add(partnerOf(p, users), 'username');
    add(p, 'password');
  }
  if (!pws.length && !all.some(isPassword)) add(users.find(strongUser) ?? users.find((u) => loneStepUser(u, all)) ?? null, 'username');
  return out;
}

/** Cheap first check for the lazy content script: anything that looks like a login field in the light DOM. */
export function looksLikeLogin(doc: Document): boolean {
  if (doc.querySelector('input[type=password], input[autocomplete~=username i], input[autocomplete~=current-password i], input[type=email]')) return true;
  // An unmarked username step (see loneStepUser): only on pages that say sign-in.
  return SIGN_IN.test(`${doc.location.pathname} ${doc.title}`) && !!doc.querySelector('input:not([type]), input[type=text], input[type=tel]');
}

export interface Captured {
  username: string;
  password: string;
  /** For change-password forms: the old password the form asked for. */
  current: string | null;
  /** The password came from a "new password" field (signup or change-password). */
  isNew: boolean;
  /** No username field: the one email address the page shows by the password field, if any. */
  shown?: string;
}

/**
 * What the user just submitted from the form around `from` (a form, a field or a button): the username and the
 * password worth saving. Null when there is no non-empty password.
 */
export function capture(from: Element): Captured | null {
  const form = (from as HTMLInputElement).form ?? from.closest('form');
  const scope: Element | Document = form ?? scopeOf(from);
  const all = inputs(scope).filter((i) => i.isConnected && !i.disabled);
  const vis = all.filter(visible);
  const pws = vis.filter((i) => isPassword(i) && i.value);
  if (!pws.length) return null;
  const news = pws.filter(isNewPassword);
  const cur = pws.find((p) => ac(p).includes('current-password')) ?? pws.find((p) => !isNewPassword(p)) ?? null;
  // Change password: current + new (+ repeat). Signup: new (+ repeat). Login: one password.
  const password = news[0]?.value ?? cur?.value ?? '';
  if (!password) return null;
  const pwEl = news[0] ?? cur!;
  const users = vis.filter(isUsernameCandidate);
  let user = partnerOf(pwEl, users)?.value ?? '';
  if (!user) {
    // Two-step page 2 and change-password forms often carry the username in a hidden field.
    const hidden = all.find((i) => (i.type === 'hidden' || !visible(i)) && (ac(i).includes('username') || ac(i).includes('email')) && i.value);
    user = hidden?.value ?? '';
  }
  const shown = user ? '' : shownEmail(pwEl);
  return { username: user.trim(), password, current: news.length && cur && cur !== news[0] ? cur.value : null, isNew: news.length > 0, ...(shown && { shown }) };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i;

/**
 * The account a password page names in text but not in a field (Google after "Choose an account": the address sits
 * above the password box). Looks outward from the field a few levels, skipping footers, menus and links; exactly one
 * distinct address counts, more than one means none.
 */
function shownEmail(pw: HTMLInputElement): string {
  const doc = pw.ownerDocument;
  const tagged = [...doc.querySelectorAll('[data-email]')].map((e) => e.getAttribute('data-email')!.trim()).filter((v) => EMAIL.test(v));
  if (new Set(tagged.map((v) => v.toLowerCase())).size === 1) return tagged[0]!;
  let n: Element | null = pw.parentElement;
  for (let i = 0; n && i < 10; i++, n = n.parentElement) {
    const found = new Set<string>();
    const w = doc.createTreeWalker(n, 4); // text nodes
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const v = t.nodeValue!.trim();
      const el = t.parentElement;
      // Not a footer's or a menu's "contact us" address, or any link.
      if (v.length < 100 && EMAIL.test(v) && el?.getClientRects().length && !el.closest('footer, nav, aside, a, [role=contentinfo]')) found.add(v.toLowerCase());
    }
    if (found.size > 1) return '';
    if (found.size === 1) return [...found][0]!;
    if (n === doc.body) break;
  }
  return '';
}

/** The element that holds a login without a <form>: the nearest ancestor with a password field and a button. */
export function scopeOf(el: Element): Element {
  let n: Element | null = el;
  for (let i = 0; n && i < 8; i++, n = n.parentElement) {
    if (n.querySelector('input[type=password]') && n.querySelector('button, input[type=submit], [role=button]')) return n;
  }
  return (el.getRootNode() as Document | ShadowRoot) instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el.ownerDocument!.body ?? el;
}

/** Set a field's value the way typing would, so frameworks that track the value (React) notice the change. */
export function setValue(el: HTMLInputElement, value: string) {
  el.focus({ preventScroll: true });
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  const opts = { bubbles: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', { ...opts, key: 'Unidentified' }));
  el.dispatchEvent(new InputEvent('input', { ...opts, inputType: 'insertReplacementText', data: value }));
  el.dispatchEvent(new KeyboardEvent('keyup', { ...opts, key: 'Unidentified' }));
  el.dispatchEvent(new Event('change', opts));
}
