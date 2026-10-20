// SPDX-License-Identifier: GPL-3.0-only
// Shared plumbing for the extension pages Litewarden frames into sites (menu, save prompt, teach panel).
import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../shared/messages';
import type { Settings } from '../shared/store';

/** "#<token>" or "#<token>:bar" (the content script switches to the slim bar when the card fits nowhere). */
export function useHash(): { token: string; bar: boolean } {
  const read = () => {
    const [token = '', mode] = location.hash.slice(1).split(':');
    return { token, bar: mode === 'bar' };
  };
  const [h, setH] = useState(read);
  useEffect(() => {
    const on = () => setH(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return h;
}

export function applyFrameTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.classList.add('is-menu');
}

/** Height the content needs, so the frame on the page hugs it (sum of the root's children). */
export function naturalHeight(el: Element | null): number {
  if (!el) return 0;
  let h = 0;
  for (const c of Array.from(el.children) as HTMLElement[]) {
    const cs = getComputedStyle(c);
    // Sub-pixel heights count: a frame 0.4px short leaves the content "not fully visible" to the click guard.
    const own = c.dataset.scroll != null ? c.scrollHeight : c.getBoundingClientRect().height;
    h += own + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }
  const cs = getComputedStyle(el);
  return Math.ceil(h + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
}

export function reportSize(token: string, h: number, w?: number) {
  if (!token || h < 20) return;
  void send('surfaceAct', { token, act: 'size', h, ...(w ? { w } : {}) }).catch(() => {});
}

/**
 * Clickjacking guard. A site can't read or script this frame, but it could try to hide it (opacity, an overlay)
 * and trick a click. Clicks only count while Chrome reports the frame as fully visible and unobstructed
 * (IntersectionObserver v2), and only after it has been visible for a moment. Where v2 isn't available, the
 * click must be a real one with this page focused.
 */
export function useGuard(ref: { current: Element | null }) {
  const st = useRef({ ok: false, since: 0, v2: false });
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        const e = es[es.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
        st.current.v2 = typeof e.isVisible === 'boolean';
        const ok = st.current.v2 ? !!e.isVisible : e.isIntersecting;
        if (ok && !st.current.ok) st.current.since = performance.now();
        st.current.ok = ok;
        if (ok) setBlocked(false);
      },
      // Threshold 0: a frame that's briefly shorter than its content while it resizes is not "hidden"; what
      // counts is isVisible (nothing on top, no opacity or transform tricks), which Chrome re-reports on change.
      { threshold: [0], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref.current]);
  /**
   * True when an action may run. Keys only reach this frame when Litewarden focused it after the user's own click
   * or shortcut, so a trusted key event is enough. A pointer action also needs the frame to have been fully
   * visible for a moment (a click that lands right as the frame appears is ignored).
   */
  const can = (e: { isTrusted: boolean; type: string }) => {
    if (!e.isTrusted) return false;
    if (e.type.startsWith('key')) return true;
    const s = st.current;
    if (!s.ok || !(s.v2 || document.hasFocus())) {
      setBlocked(true);
      return false;
    }
    return performance.now() - s.since > 250;
  };
  return { can, blocked };
}

/** Keep the frame on the page exactly as tall as the content (fonts load, states change, errors appear). */
export function useAutoSize(token: string, on: boolean) {
  useEffect(() => {
    const app = document.getElementById('app');
    if (!on || !app) return;
    let last = 0;
    const send = () => {
      const h = naturalHeight(app);
      if (Math.abs(h - last) < 1) return;
      last = h;
      reportSize(token, h);
    };
    const ro = new ResizeObserver(send);
    ro.observe(app);
    for (const c of Array.from(app.children)) ro.observe(c);
    void document.fonts?.ready.then(send);
    send();
    return () => ro.disconnect();
  }, [token, on]);
}
