// SPDX-License-Identifier: GPL-3.0-only
// A fixed-row-height virtual list inside an existing scroll container. Only the rows near the viewport are in
// the DOM (a few dozen out of thousands), so favicons load only for what's visible.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const OVERSCAN = 8;

/** Row height in px for the current density (matches .row in slip.css). */
export const rowHeight = () => (document.documentElement.dataset.density === 'compact' ? 36 : 42);

export function VList({
  count,
  offset,
  sel,
  moved,
  scroller,
  render,
}: {
  count: number;
  /** Index of the first row in the popup's keyboard order (rows above this list come first). */
  offset: number;
  sel: number;
  moved: boolean;
  /** id of the scrolling element */
  scroller: string;
  render: (i: number, style: Record<string, string>) => ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState<[number, number]>([0, 30]);
  const h = rowHeight();

  const measure = () => {
    const sc = document.getElementById(scroller);
    const el = box.current;
    if (!sc || !el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const first = Math.max(0, Math.floor((sc.scrollTop - top) / h) - OVERSCAN);
    const last = Math.min(count, Math.ceil((sc.scrollTop + sc.clientHeight - top) / h) + OVERSCAN);
    setWin((w) => (w[0] === first && w[1] === last ? w : [first, Math.max(first, last)]));
  };

  useLayoutEffect(measure, [count, h]);
  useEffect(() => {
    const sc = document.getElementById(scroller);
    if (!sc) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    sc.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      sc.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, [count, h]);

  // Arrow keys moved the selection into this list: scroll it into view (it may not be rendered yet).
  useEffect(() => {
    const k = sel - offset;
    if (!moved || k < 0 || k >= count) return;
    const sc = document.getElementById(scroller);
    const el = box.current;
    if (!sc || !el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + k * h;
    if (top < sc.scrollTop) sc.scrollTop = top - 4;
    else if (top + h > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + h - sc.clientHeight + 4;
  }, [sel, moved]);

  const rows: ComponentChildren[] = [];
  for (let i = win[0]; i < Math.min(win[1], count); i++) rows.push(render(i, { position: 'absolute', top: `${i * h + 3}px`, left: '3px', right: '3px' }));
  return (
    <div class="list vlist" ref={box} style={{ height: `${count * h + 6}px` }}>
      {rows}
    </div>
  );
}
