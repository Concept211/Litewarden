// SPDX-License-Identifier: GPL-3.0-only
// No-cover placement for everything Litewarden draws on a page (menu, save prompt, teach panel). A spot is
// rejected when it overlaps any protected element (other fields, buttons inside fields, checkboxes, the submit
// button) or leaves the viewport. Pure geometry, so it can be unit tested.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Spot extends Rect {
  name: string;
  /** Why the spot was rejected, or undefined when it was picked. */
  why?: string;
}

export const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export type Cand = [name: string, x: number, y: number, w?: number, h?: number];

/**
 * First candidate that fits in the viewport and covers nothing. `prot` items carry a label for the reason text.
 * Returns the pick (or null) and every rejected spot in order.
 */
export function pickSpot(cands: Cand[], size: { w: number; h: number }, prot: Array<Rect & { label?: string }>, view: { w: number; h: number }, margin = 4) {
  const tried: Spot[] = [];
  for (const [name, x, y, cw, ch] of cands) {
    const r: Spot = { name, x, y, w: cw ?? size.w, h: ch ?? size.h };
    if (x < margin || y < margin || x + r.w > view.w - margin || y + r.h > view.h - margin) r.why = 'off screen';
    else {
      const c = prot.find((p) => hit(r, p));
      if (c) r.why = `covers ${c.label ?? 'a field'}`;
    }
    if (!r.why) return { pick: r, tried };
    tried.push(r);
  }
  return { pick: null as Spot | null, tried };
}

const GAP = 6;
export const MENU_W = 300;
export const MENU_COMPACT_H = 156;

/**
 * The in-page menu next to `anchor`: below, beside right, above, beside left, then below the whole form; at the
 * menu's natural height first, then compact. Docks to the bottom-right corner when every side is blocked.
 */
export function placeMenu(anchor: Rect, h: number, prot: Array<Rect & { label?: string }>, view: { w: number; h: number }) {
  const formBottom = Math.max(anchor.y + anchor.h, ...prot.map((p) => p.y + p.h));
  const tried: Spot[] = [];
  for (const hh of [...new Set([h, Math.min(h, MENU_COMPACT_H)])]) {
    const sfx = hh === h ? '' : ' (compact)';
    const cands: Cand[] = [
      ['below' + sfx, anchor.x, anchor.y + anchor.h + GAP],
      ['beside right' + sfx, anchor.x + anchor.w + 8, anchor.y],
      ['above' + sfx, anchor.x, anchor.y - GAP - hh],
      ['beside left' + sfx, anchor.x - 8 - MENU_W, anchor.y],
      ['below the form' + sfx, anchor.x, formBottom + GAP],
    ];
    const r = pickSpot(cands, { w: MENU_W, h: hh }, prot, view);
    tried.push(...r.tried);
    if (r.pick) return { pick: r.pick, tried };
  }
  const hh = Math.min(h, MENU_COMPACT_H);
  return { pick: { name: 'docked bottom-right', x: Math.max(4, view.w - MENU_W - 12), y: Math.max(4, view.h - hh - 12), w: MENU_W, h: hh } as Spot, tried };
}

export const PROMPT_W = 320;
export const BAR_H = 56;

/**
 * Save prompt, variant C: next to the form (right, left, below), then the corners, then a slim bar at the top or
 * bottom when the card fits nowhere. `form` is null after a page change (the form is gone).
 */
export function placePrompt(form: Rect | null, h: number, prot: Array<Rect & { label?: string }>, view: { w: number; h: number }) {
  const w = PROMPT_W;
  const bw = Math.min(440, view.w - 24);
  const cands: Cand[] = [];
  if (form) cands.push(['beside the form, right', form.x + form.w + 12, form.y], ['beside the form, left', form.x - w - 12, form.y], ['below the form', form.x, form.y + form.h + 12]);
  cands.push(
    ['top right', view.w - w - 12, 12],
    ['top left', 12, 12],
    ['bottom right', view.w - w - 12, view.h - h - 12],
    ['bottom left', 12, view.h - h - 12],
    ['slim bar, top', (view.w - bw) / 2, 10, bw, BAR_H],
    ['slim bar, bottom', (view.w - bw) / 2, view.h - BAR_H - 10, bw, BAR_H],
  );
  const r = pickSpot(cands, { w, h }, prot, view);
  return { pick: r.pick ?? ({ name: 'slim bar, top (last resort)', x: (view.w - bw) / 2, y: 10, w: bw, h: BAR_H } as Spot), tried: r.tried };
}

export const PANEL_W = 300;
export const TEACH_BAR_H = 58;

/** Teach panel, variant B: docked right, then left; a slim bar when neither side has room. */
export function placePanel(prot: Array<Rect & { label?: string }>, view: { w: number; h: number }) {
  const h = Math.min(view.h - 20, 420);
  const bw = Math.min(480, view.w - 24);
  const cands: Cand[] = [
    ['docked right', view.w - PANEL_W - 10, 10],
    ['docked left', 10, 10],
    ['slim bar, top', (view.w - bw) / 2, 10, bw, TEACH_BAR_H],
    ['slim bar, bottom', (view.w - bw) / 2, view.h - TEACH_BAR_H - 12, bw, TEACH_BAR_H],
  ];
  const r = pickSpot(cands, { w: PANEL_W, h }, prot, view);
  return { pick: r.pick ?? ({ name: 'slim bar, top (last resort)', x: (view.w - bw) / 2, y: 10, w: bw, h: TEACH_BAR_H } as Spot), tried: r.tried };
}
