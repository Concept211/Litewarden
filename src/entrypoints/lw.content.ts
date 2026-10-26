// SPDX-License-Identifier: GPL-3.0-only
// The in-page part of Litewarden: field icons, the in-page menu, the save / update prompt and "teach this site".
// Lazy by design: until a page shows a login field this script only runs one cheap query (plus a throttled one
// when the page changes). It never reads the vault. The menu, prompt and panel are extension pages in iframes
// (the page can't read or script them); this script only places them so they cover nothing, and tells the
// worker what the user submitted. Everything Litewarden draws lives in one closed shadow root.
import { capture, inputs, isPassword, isUsernameCandidate, loginFields, looksLikeLogin, scopeOf, strongUser, visible, type Role } from '../shared/fields';
import type { CsApi, CsHello, ToCs } from '../shared/messages';
import { placeMenu, placePanel, placePrompt, type Rect } from '../shared/place';
import { refFor, resolve, type SiteRule } from '../shared/rules';
import type { TeachState } from '../shared/store';

const KEEP =
  'M65 10L79.667 10A2 2 0 0 1 81.667 12L81.667 24A2 2 0 0 0 83.667 26L88.667 26A2 2 0 0 0 90.667 24L90.667 12A2 2 0 0 1 92.667 10L107.333 10A2 2 0 0 1 109.333 12L109.333 24A2 2 0 0 0 111.333 26L116.333 26A2 2 0 0 0 118.333 24L118.333 12A2 2 0 0 1 120.333 10L135 10A2 2 0 0 1 137 12L137 53.172A2 2 0 0 1 136.414 54.586L114.101 76.899A14 14 0 0 0 110 86.799L110 99.431A14 14 0 0 0 117 111.555A34 34 0 1 1 83 111.555A14 14 0 0 0 90 99.431L90 86.799A14 14 0 0 0 85.899 76.899L63.586 54.586A2 2 0 0 1 63 53.172L63 12A2 2 0 0 1 65 10ZM81 141A19 19 0 1 0 119 141A19 19 0 1 0 81 141Z';

const CSS = `
.ic{position:fixed;width:22px;height:22px;border-radius:3px;border:0;box-shadow:0 0 0 1.5px #fff,0 1px 3px rgb(0 0 0/.35);padding:0;margin:0;display:grid;place-items:center;background:#1252a3;color:#fff;cursor:pointer;pointer-events:auto;box-sizing:border-box;z-index:1}
.ic:hover{background:#0d3c77}.ic.locked{background:#5b6474}.ic.locked:hover{background:#454d5b}
.ic:focus-visible{outline:2px solid #1252a3;outline-offset:2px}
.ic svg{height:64%;width:auto;display:block}
iframe{position:fixed;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;border-radius:14px;box-shadow:0 12px 32px rgb(16 24 40/.18),0 3px 8px rgb(16 24 40/.1);pointer-events:auto;z-index:3;display:block;max-width:none;max-height:none;opacity:1;visibility:visible}
.hl{position:fixed;pointer-events:none;border-radius:5px;outline:2px dashed #1252a3;outline-offset:3px;background:rgb(18 82 163/.07);z-index:2}
.hl.set{outline-style:solid;background:none}
.hl span{position:absolute;right:-3px;top:-25px;background:#1252a3;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:4px 6px;border-radius:5px;white-space:nowrap}
.hl:not(.set) span{background:#fff;color:#1252a3;border:1px solid #1252a3}
`;

type Ref<K extends keyof CsApi> = CsApi[K];

async function cs<K extends keyof CsApi>(type: K, data: Ref<K>[0]): Promise<Ref<K>[1]> {
  const res = (await chrome.runtime.sendMessage({ cs: type, data })) as { ok: boolean; data: Ref<K>[1]; error?: { message: string } } | undefined;
  if (!res?.ok) throw new Error(res?.error?.message ?? 'Litewarden did not answer');
  return res.data;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const viewport = () => ({ w: document.documentElement.clientWidth || innerWidth, h: document.documentElement.clientHeight || innerHeight });

function deepActive(): Element | null {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function labelFor(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return 'Checkbox';
    if (el.type === 'submit' || el.type === 'button') return `${el.value || 'Submit'} button`;
    if (isPassword(el)) return 'Password field';
    return `${el.labels?.[0]?.textContent?.trim().slice(0, 24) || el.name || el.type || 'Text'} field`;
  }
  if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button') {
    const t = (el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label') || '';
    return t ? `${t} button` : 'Button';
  }
  if (el instanceof HTMLLabelElement) return 'Checkbox';
  return el.localName;
}

/** What a surface must never cover: every control around the field, plus buttons inside fields (eye toggles). */
function protectedRects(near: Element | null): Array<Rect & { label: string }> {
  const scope: Element | Document = near ? ((near as HTMLInputElement).form ?? near.closest('form') ?? scopeOf(near)) : document;
  const wide = !near || scope === document || scope === document.body;
  const roots: Array<Element | Document | ShadowRoot> = [scope];
  for (const i of inputs(scope instanceof Document ? scope : scope)) {
    const r = i.getRootNode();
    if (r instanceof ShadowRoot && !roots.includes(r)) roots.push(r);
  }
  const out: Array<Rect & { label: string }> = [];
  const seen = new Set<Element>();
  const a = near ? rectOf(near) : null;
  const v = viewport();
  for (const root of roots) {
    for (const el of root.querySelectorAll('input:not([type=hidden]), select, textarea, button, [role=button], label')) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el instanceof HTMLLabelElement && !el.querySelector('input[type=checkbox], input[type=radio]')) continue;
      const r = rectOf(el);
      if (r.w < 2 || r.h < 2 || r.x > v.w || r.y > v.h || r.x + r.w < 0 || r.y + r.h < 0) continue;
      // Without a form, only what's near the field (a whole page of buttons would leave nowhere to go).
      if (wide && a && (Math.abs(r.y - a.y) > 500 || Math.abs(r.x - a.x) > 700)) continue;
      out.push({ ...r, label: el === near ? 'this field' : labelFor(el) });
    }
  }
  if (near && !seen.has(near) && a) out.push({ ...a, label: 'this field' });
  return out;
}

function start(ctx: { onInvalidated: (cb: () => void) => void; isInvalid: boolean }) {
  const t0 = performance.now();
  let conf: CsHello | null = null;
  let activating: Promise<void> | null = null;
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  const icons = new Map<HTMLInputElement, { btn: HTMLButtonElement; role: Role; off: number }>();
  let menu: { token: string; fr: HTMLIFrameElement; anchor: HTMLInputElement; h: number } | null = null;
  let prompt: { token: string; fr: HTMLIFrameElement; form: Element | null; h: number; bar: boolean } | null = null;
  let teach: { token: string; fr: HTMLIFrameElement; step: TeachState['step']; map: Record<'username' | 'password' | 'totp', HTMLInputElement | null>; hover: HTMLDivElement | null; marks: HTMLDivElement[]; bar: boolean } | null = null;
  /** A sign-in's save card waiting for the login form to go away. */
  let held: { token: string; timer: number } | null = null;
  let lastSubmit = { key: '', at: 0 };
  let lastForm: Element | null = null;

  // ---------- the shadow root everything is drawn in ----------
  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('litewarden-ui');
    host.style.cssText =
      'all:initial !important;position:fixed !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;pointer-events:none !important;display:block !important;';
    shadow = host.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
    document.documentElement.appendChild(host);
  }

  function frame(page: string, token: string, title: string): HTMLIFrameElement {
    mount();
    const fr = document.createElement('iframe');
    fr.title = title;
    fr.setAttribute('allow', 'clipboard-write');
    fr.setAttribute('referrerpolicy', 'no-referrer');
    fr.src = `${chrome.runtime.getURL(`/${page}`)}#${token}`;
    fr.style.cssText = 'left:-9999px;top:0;width:300px;height:200px';
    shadow!.appendChild(fr);
    return fr;
  }
  /**
   * Remove one of our frames. If it has the keyboard focus (Esc pressed inside it), give the focus back to the page
   * first: to `back` (the field the menu belongs to) or the page itself, so the user's cursor isn't left nowhere.
   * The frame is hidden and moved off screen at once but removed a moment later: the frame runs in its own process
   * and the browser moves focus out of it asynchronously, so the release of the key that closed it can still be on
   * its way there. Destroying the frame under that event can strand it (seen as a key press that never finished
   * on slow CI machines).
   */
  function drop(fr: HTMLIFrameElement, back: HTMLElement | null) {
    if (host && document.activeElement === host) {
      if (back?.isConnected) focusBack(back);
      else window.focus();
    }
    Object.assign(fr.style, { visibility: 'hidden', pointerEvents: 'none', left: '-9999px' });
    setTimeout(() => fr.remove(), 300);
  }
  /** Focus we hand back after closing a surface; "open the menu on focus" must not take it for the user's own. */
  let handedBack: Element | null = null;
  function focusBack(el: HTMLElement) {
    handedBack = el;
    el.focus({ preventScroll: true });
    setTimeout(() => handedBack === el && (handedBack = null), 100);
  }
  const put = (el: HTMLElement, r: Rect) => Object.assign(el.style, { left: `${Math.round(r.x)}px`, top: `${Math.round(r.y)}px`, width: `${Math.ceil(r.w)}px`, height: `${Math.ceil(r.h)}px` });

  // ---------- activation (first login field seen) ----------
  let submitHooked = false;
  function activate(): Promise<void> {
    activating ??= (async () => {
      // Submit capture first: it doesn't need the worker's answer below, and a login submitted during that round
      // trip (fast hands, a browser-filled form) would otherwise get no save prompt.
      if (!submitHooked) {
        submitHooked = true;
        document.addEventListener('submit', (e) => onSubmit(e.target as Element), true);
        document.addEventListener('click', onClick, true);
      }
      conf = await cs('cs:hello', { top: window === window.top });
      mount();
      sync();
      addEventListener('scroll', onScroll, { capture: true, passive: true });
      addEventListener('resize', onResize, { passive: true });
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('focusin', onFocus, true);
      document.addEventListener('pointerdown', onPointer, true);
      addEventListener('popstate', () => closeMenu());
      addEventListener('hashchange', () => closeMenu());
      if (conf.prompt) void showPrompt(conf.prompt);
    })().catch(() => {
      activating = null;
    });
    return activating;
  }

  async function refresh() {
    if (!activating) return;
    conf = await cs('cs:hello', { top: window === window.top }).catch(() => conf);
    sync();
  }

  // ---------- field icons ----------
  function fieldsNow(): Array<{ el: HTMLInputElement; role: Role }> {
    const found = loginFields();
    const r: SiteRule | null = conf?.rule ?? null;
    if (r) {
      for (const [ref, role] of [
        [r.username, 'username'],
        [r.password, 'password'],
      ] as const) {
        const el = resolve(ref);
        if (el && !found.some((f) => f.el === el)) found.push({ el, role });
      }
    }
    return found;
  }

  /** Room taken by the page's own buttons inside the field's right edge (eye toggles, clear buttons). */
  function controlsOffset(f: HTMLInputElement): number {
    const r = f.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const v = viewport();
    if (cy < 0 || cy > v.h || r.right < 0 || r.left > v.w) return 0;
    const root = f.getRootNode() as Document | ShadowRoot;
    let left = r.right;
    for (let x = r.right - 3; x > r.right - Math.min(130, r.width / 2); x -= 5) {
      const top = (root.elementsFromPoint?.(x, cy) ?? []).find((e) => e !== host);
      if (top && top !== f && !top.contains(f) && !f.contains(top)) left = Math.min(left, top.getBoundingClientRect().left);
    }
    return Math.max(0, r.right - left);
  }

  function sync() {
    if (!conf) return;
    const want = conf.icon ? fieldsNow() : [];
    const keep = new Set(want.map((w) => w.el));
    for (const [el, ic] of icons) {
      if (!keep.has(el)) {
        ic.btn.remove();
        icons.delete(el);
      }
    }
    for (const { el, role } of want) {
      let ic = icons.get(el);
      if (!ic) {
        const btn = document.createElement('button');
        btn.className = 'ic';
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.title = 'Litewarden (Alt+Shift+L)';
        btn.setAttribute('aria-label', 'Open Litewarden');
        btn.innerHTML = `<svg viewBox="56.4 3.4 87.2 178.2" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${KEEP}"/></svg>`;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (menu?.anchor === el) return closeMenu();
          void openMenu(el, true);
        });
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        shadow!.appendChild(btn);
        ic = { btn, role, off: 0 };
        icons.set(el, ic);
      }
      ic.off = controlsOffset(el);
      ic.btn.classList.toggle('locked', !!conf.locked);
    }
    layout();
  }

  function layout() {
    const v = viewport();
    for (const [el, ic] of icons) {
      const r = el.getBoundingClientRect();
      const s = Math.round(Math.min(22, Math.max(16, r.height - 10)));
      const show = el.isConnected && r.width > 0 && r.bottom > 0 && r.top < v.h && r.right > 0 && r.left < v.w;
      ic.btn.style.display = show ? 'grid' : 'none';
      if (!show) continue;
      Object.assign(ic.btn.style, { width: `${s}px`, height: `${s}px`, left: `${Math.round(r.right - ic.off - s - 6)}px`, top: `${Math.round(r.top + (r.height - s) / 2)}px` });
    }
    placeMenuFrame();
    placePromptFrame();
    placeTeach();
  }

  let rafPending = false;
  const onScroll = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      layout();
    });
  };
  const onResize = () => {
    for (const [el, ic] of icons) ic.off = controlsOffset(el);
    onScroll();
  };

  // ---------- in-page menu ----------
  let menuSeq = 0;
  async function openMenu(anchor: HTMLInputElement, focus: boolean) {
    if (teach) return;
    // Focus and a click on the icon can both open a menu at once: only the latest one shows.
    const mine = ++menuSeq;
    await activate();
    closeMenu();
    let token: string;
    try {
      token = (await cs('cs:open', { kind: 'menu' })).token;
    } catch {
      return;
    }
    if (mine !== menuSeq) return void cs('cs:closed', { token }).catch(() => {});
    closeMenu();
    const fr = frame('menu.html', token, 'Litewarden');
    menu = { token, fr, anchor, h: 236 };
    placeMenuFrame();
    if (focus) fr.addEventListener('load', () => fr.focus(), { once: true });
  }

  function placeMenuFrame() {
    if (!menu) return;
    if (!menu.anchor.isConnected || !visible(menu.anchor)) return closeMenu();
    const { pick } = placeMenu(rectOf(menu.anchor), menu.h, protectedRects(menu.anchor), viewport());
    put(menu.fr, pick);
  }

  function closeMenu(tell = true) {
    if (!menu) return;
    const m = menu;
    menu = null;
    drop(m.fr, m.anchor);
    if (tell) void cs('cs:closed', { token: m.token }).catch(() => {});
  }

  // ---------- save / update prompt ----------
  function onClick(e: MouseEvent) {
    const t = e.composedPath()[0] as Element | undefined;
    if (!(t instanceof Element) || teach) return;
    const b = t.closest('button, input[type=submit], input[type=button], input[type=image], [role=button]');
    if (b && !(b instanceof HTMLButtonElement && b.type === 'button' && b.closest('form') && !/sign|log|next|continue|submit|save|create|register|change|update/i.test(b.textContent ?? ''))) onSubmit(b);
  }

  function onSubmit(from: Element) {
    if (teach) return;
    const c = capture(from);
    if (!c) {
      // Two-step login, page 1: remember the username for the password page.
      const scope = (from as HTMLInputElement).form ?? from.closest('form') ?? scopeOf(from);
      const user = inputs(scope).filter(visible).find((i) => isUsernameCandidate(i) && strongUser(i) && i.value);
      if (user && !inputs(scope).some(isPassword)) void cs('cs:userStep', { username: user.value.trim() }).catch(() => {});
      return;
    }
    const key = `${c.username}\u0000${c.password}`;
    if (key === lastSubmit.key && Date.now() - lastSubmit.at < 4000) return;
    lastSubmit = { key, at: Date.now() };
    lastForm = (from as HTMLInputElement).form ?? from.closest('form') ?? scopeOf(from);
    void cs('cs:submitted', c)
      .then((r) => r && showPrompt(r.token))
      .catch(() => {});
  }

  let opening: string | null = null;
  async function showPrompt(token: string) {
    // The same prompt can be announced twice (the submit's answer and the next page's load); show it once.
    if (window !== window.top || prompt?.token === token || opening === token || held?.token === token) return;
    opening = token;
    let signIn = false;
    try {
      if (!activating) await activate();
      signIn = !!(await cs('cs:open', { kind: 'prompt', token })).signIn;
    } catch {
      return;
    } finally {
      opening = null;
    }
    unhold();
    // A sign-in's card waits until the login form has gone (the next page, or the app's signed-in view). A form
    // still there after the submit, or a fresh one on the next page, usually means the password was wrong.
    if (signIn && loginShown()) {
      const until = Date.now() + 10 * 60_000;
      let gone = 0;
      const tick = () => {
        if (loginShown()) return void ((gone = 0), Date.now() > until && unhold());
        // Gone twice in a row: an app that re-renders its form doesn't count.
        if (++gone < 2) return;
        unhold();
        openPrompt(token);
      };
      held = { token, timer: window.setInterval(tick, 400) };
      return;
    }
    openPrompt(token);
  }

  function unhold() {
    if (held) clearInterval(held.timer);
    held = null;
  }
  /** A password field is on screen. Disabled counts: pages disable the form while the sign-in is checked. */
  const loginShown = () =>
    inputs(document).some((i) => {
      if (!isPassword(i) || !i.isConnected) return false;
      const r = i.getBoundingClientRect();
      const st = getComputedStyle(i);
      return r.width >= 2 && r.height >= 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
    });

  function openPrompt(token: string) {
    closePrompt(false);
    const fr = frame('prompt.html', token, 'Litewarden: save login');
    prompt = { token, fr, form: lastForm, h: 250, bar: false };
    placePromptFrame();
  }

  function placePromptFrame() {
    if (!prompt) return;
    const form = prompt.form?.isConnected && visibleBox(prompt.form) ? prompt.form : null;
    const { pick } = placePrompt(form ? rectOf(form) : null, prompt.h, protectedRects(form ? (inputs(form).find(visible) ?? form) : null), viewport());
    const bar = pick.name.startsWith('slim bar');
    if (bar !== prompt.bar) {
      prompt.bar = bar;
      prompt.fr.src = prompt.fr.src.replace(/#.*$/, `#${prompt.token}${bar ? ':bar' : ''}`);
    }
    put(prompt.fr, pick);
  }

  const visibleBox = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function closePrompt(tell = true) {
    if (!prompt) return;
    const p = prompt;
    prompt = null;
    drop(p.fr, null);
    if (tell) void cs('cs:closed', { token: p.token }).catch(() => {});
  }

  // ---------- teach this site ----------
  const ROLE_NAME = { username: 'Username', password: 'Password', totp: '2FA code' } as const;
  const roleOf = (step: number) => (['username', 'password', 'totp'] as const)[step - 1]!;

  async function startTeach() {
    await activate();
    closeMenu();
    endTeach(true);
    let token: string;
    try {
      token = (await cs('cs:open', { kind: 'teach' })).token;
    } catch {
      return;
    }
    teach = { token, fr: frame('teach.html', token, 'Litewarden: teach this site'), step: 1, map: { username: null, password: null, totp: null }, hover: null, marks: [], bar: false };
    document.addEventListener('mouseover', teachHover, true);
    placeTeach();
    report();
  }

  function report() {
    if (!teach) return;
    const d = (el: HTMLInputElement | null) => (el ? refFor(el).label : null);
    void cs('cs:teachState', { token: teach.token, state: { step: teach.step, username: d(teach.map.username), password: d(teach.map.password), totp: d(teach.map.totp) } }).catch(() => {});
  }

  function placeTeach() {
    if (!teach) return;
    const prot = protectedRects(null);
    const { pick } = placePanel(prot, viewport());
    const bar = pick.name.startsWith('slim bar');
    if (bar !== teach.bar) {
      teach.bar = bar;
      teach.fr.src = teach.fr.src.replace(/#.*$/, `#${teach.token}${bar ? ':bar' : ''}`);
    }
    put(teach.fr, pick);
    marks();
  }

  function marks() {
    if (!teach) return;
    teach.marks.forEach((m) => m.remove());
    teach.marks = [];
    for (const role of ['username', 'password', 'totp'] as const) {
      const el = teach.map[role];
      if (!el?.isConnected) continue;
      const d = document.createElement('div');
      d.className = 'hl set';
      d.innerHTML = `<span>${ROLE_NAME[role]}</span>`;
      put(d, rectOf(el));
      shadow!.appendChild(d);
      teach.marks.push(d);
    }
    if (teach.hover) teach.hover.style.display = 'none';
  }

  const teachable = (t: unknown): t is HTMLInputElement => t instanceof HTMLInputElement && !['checkbox', 'radio', 'hidden', 'submit', 'button', 'image', 'file', 'range', 'color'].includes(t.type);

  function teachHover(e: MouseEvent) {
    if (!teach || teach.step > 3) return;
    const t = e.composedPath()[0];
    if (!teachable(t)) {
      if (teach.hover) teach.hover.style.display = 'none';
      return;
    }
    if (!teach.hover) {
      teach.hover = document.createElement('div');
      teach.hover.className = 'hl';
      shadow!.appendChild(teach.hover);
    }
    teach.hover.innerHTML = `<span>Use as ${ROLE_NAME[roleOf(teach.step)]}</span>`;
    teach.hover.style.display = 'block';
    put(teach.hover, rectOf(t));
  }

  /** A click on a field while teaching: assign it, keep the page from reacting. */
  function teachPick(e: Event): boolean {
    if (!teach || teach.step > 3) return false;
    const t = e.composedPath()[0];
    if (!teachable(t)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'pointerdown') return true;
    (t as HTMLInputElement).blur();
    teach.map[roleOf(teach.step)] = t;
    teach.step = (teach.step + 1) as TeachState['step'];
    if (teach.step === 4) void saveRule();
    marks();
    report();
    return true;
  }

  async function saveRule() {
    if (!teach) return;
    const m = teach.map;
    const rule: SiteRule = { username: m.username ? refFor(m.username) : null, password: m.password ? refFor(m.password) : null, totp: m.totp ? refFor(m.totp) : null, url: location.href, created: Date.now() };
    teach.step = 4;
    await cs('cs:saveRule', { rule }).catch(() => {});
    if (conf) conf = { ...conf, rule };
    report();
    sync();
  }

  function teachAct(act: 'back' | 'save' | 'cancel' | 'undo' | 'done') {
    if (!teach) return;
    if (act === 'cancel' || act === 'done') return endTeach();
    if (act === 'back' && teach.step > 1 && teach.step < 4) {
      teach.step = (teach.step - 1) as TeachState['step'];
      teach.map[roleOf(teach.step)] = null;
    }
    if (act === 'save' && teach.step === 3) void saveRule();
    if (act === 'undo' && teach.step === 4) {
      void cs('cs:removeRule', undefined).catch(() => {});
      if (conf) conf = { ...conf, rule: null };
      teach.step = 1;
      teach.map = { username: null, password: null, totp: null };
      sync();
    }
    marks();
    report();
  }

  function endTeach(silent = false) {
    if (!teach) return;
    const t = teach;
    teach = null;
    document.removeEventListener('mouseover', teachHover, true);
    drop(t.fr, null);
    t.hover?.remove();
    t.marks.forEach((m) => m.remove());
    if (!silent) void cs('cs:closed', { token: t.token }).catch(() => {});
  }

  // ---------- page events ----------
  function onPointer(e: PointerEvent) {
    if (teachPick(e)) return;
    if (!menu) return;
    const path = e.composedPath();
    if ((host && path.includes(host)) || path.includes(menu.anchor)) return;
    closeMenu();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (teach) {
        e.stopPropagation();
        return endTeach();
      }
      if (menu) {
        e.stopPropagation();
        const a = menu.anchor;
        closeMenu();
        focusBack(a);
        return;
      }
    }
    if (e.key === 'Enter' && !teach) {
      const t = e.composedPath()[0];
      if (t instanceof HTMLInputElement && t.form?.querySelector('input[type=password]')) onSubmit(t);
      else if (t instanceof HTMLInputElement && isPassword(t)) onSubmit(t);
    }
  }

  function onFocus(e: FocusEvent) {
    // Not while the save card is up: two of our surfaces at once crowd the form. The field icon still opens it.
    if (!conf?.menuOnFocus || teach || prompt) return;
    const t = e.composedPath()[0];
    if (t === handedBack) return void (handedBack = null);
    if (t instanceof HTMLInputElement && icons.has(t) && menu?.anchor !== t) void openMenu(t, false);
  }

  // Clicks on fields while teaching never reach the page.
  document.addEventListener('click', (e) => teachPick(e), true);
  document.addEventListener('mousedown', (e) => teachPick(e), true);

  // The field a right-click menu was opened on, for "Fill with Litewarden" there.
  let rightClicked: EventTarget | undefined;
  document.addEventListener('contextmenu', (e) => (rightClicked = e.composedPath()[0]), true);

  // ---------- messages from the worker ----------
  chrome.runtime.onMessage.addListener((m: ToCs, sender) => {
    if (sender.id !== chrome.runtime.id || !m || typeof m !== 'object' || !('lw' in m)) return;
    switch (m.lw) {
      case 'size':
        if (menu?.token === m.token) {
          menu.h = Math.max(120, Math.min(236, m.h));
          placeMenuFrame();
        } else if (prompt?.token === m.token && !prompt.bar) {
          // Placement works with the card's height; the slim bar's own height doesn't count (it would flip the
          // prompt back to the card, which doesn't fit, and back again).
          prompt.h = Math.max(60, Math.min(420, m.h));
          placePromptFrame();
        }
        break;
      case 'close':
        if (menu?.token === m.token) closeMenu(false);
        if (prompt?.token === m.token) closePrompt(false);
        if (teach?.token === m.token) endTeach(true);
        break;
      case 'open-menu': {
        const a = m.ctx ? rightClicked : document.hasFocus() ? deepActive() : null;
        if (a instanceof HTMLInputElement && (isPassword(a) || isUsernameCandidate(a))) void openMenu(a, true);
        break;
      }
      case 'teach':
        void startTeach();
        break;
      case 'teach-act':
        if (teach?.token === m.token) teachAct(m.act);
        break;
      case 'refresh':
        void refresh();
        break;
      case 'prompt':
        void showPrompt(m.token);
        break;
    }
  });

  // ---------- laziness: wait for a login field ----------
  let scanTimer = 0;
  function scan() {
    scanTimer = 0;
    if (ctx.isInvalid) return;
    if (activating) return sync();
    if (looksLikeLogin(document)) return void activate();
    // Web components hide their fields in shadow roots, which the cheap query can't see. That walk is the costly
    // part, so it waits for an idle moment and never runs more than once every few seconds.
    if (Date.now() - lastShadowWalk > 3000) {
      lastShadowWalk = Date.now();
      const idle = (globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1))) as (cb: () => void, o?: { timeout: number }) => void;
      idle(
        () => {
          const t = performance.now();
          if (!activating && hasShadowLogin()) void activate();
          cost.idle = performance.now() - t;
        },
        { timeout: 2000 },
      );
    }
  }
  let lastShadowWalk = 0;
  const cost = { init: 0, scan: 0, idle: 0 };
  /** Login forms inside open shadow roots (web components). Bounded so a huge page stays cheap. */
  function hasShadowLogin(): boolean {
    // Open shadow roots live on custom elements (names with a hyphen) in practice. XPath finds those natively,
    // so a big page without web components costs one query instead of a JavaScript loop over every element.
    const hosts = document.evaluate("//*[contains(local-name(), '-')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0, n = Math.min(hosts.snapshotLength, 2000); i < n; i++) {
      const sr = (hosts.snapshotItem(i) as Element).shadowRoot;
      // inputs() walks nested shadow roots too.
      if (sr && inputs(sr).some((x) => isPassword(x) || (isUsernameCandidate(x) && strongUser(x)))) return true;
    }
    return false;
  }
  const schedule = (ms = 300) => {
    if (!scanTimer) scanTimer = window.setTimeout(scan, ms);
  };
  const mo = new MutationObserver(() => schedule(activating ? 250 : 400));
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const scanStart = performance.now();
  scan();
  cost.scan = performance.now() - scanStart;
  cost.init = performance.now() - t0;
  // Read by the e2e cost test from this isolated world (the page can't see it).
  (globalThis as unknown as { __lwCost?: typeof cost }).__lwCost = cost;

  addEventListener('pagehide', () => {
    closeMenu();
    endTeach(true);
    if (prompt) closePrompt(false);
  });
  ctx.onInvalidated(() => {
    mo.disconnect();
    host?.remove();
  });
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    start(ctx);
  },
});
