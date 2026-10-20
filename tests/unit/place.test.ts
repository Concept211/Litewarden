// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { hit, MENU_COMPACT_H, MENU_W, pickSpot, placeMenu, placePanel, placePrompt, type Rect } from '../../src/shared/place';

// The r3 mockup's stacked bank form: username, password with an eye, a checkbox, the submit button.
const form = (x: number) => {
  const u = { x, y: 180, w: 306, h: 40, label: 'Username field' };
  const p = { x, y: 250, w: 306, h: 40, label: 'Password field' }; // the eye sits inside the field
  const eye = { x: x + 266, y: 250, w: 40, h: 40, label: 'Show-password eye' };
  const cb = { x, y: 304, w: 160, h: 20, label: 'Checkbox' };
  const submit = { x, y: 340, w: 306, h: 42, label: 'Sign in button' };
  return { u, p, eye, cb, submit, all: [u, p, eye, cb, submit] };
};
const coversNothing = (r: Rect, prot: Rect[]) => prot.every((p) => !hit(r, p));
const inside = (r: Rect, v: { w: number; h: number }) => r.x >= 4 && r.y >= 4 && r.x + r.w <= v.w - 4 && r.y + r.h <= v.h - 4;

describe('pickSpot', () => {
  it('rejects spots off screen or over a protected element, with the reason', () => {
    const r = pickSpot(
      [
        ['off', -10, 10],
        ['over', 10, 10],
        ['clear', 200, 10],
      ],
      { w: 50, h: 50 },
      [{ x: 0, y: 0, w: 100, h: 100, label: 'Password field' }],
      { w: 400, h: 400 },
    );
    expect(r.pick?.name).toBe('clear');
    expect(r.tried.map((t) => t.why)).toEqual(['off screen', 'covers Password field']);
  });
});

describe('placeMenu', () => {
  it('wide window, from the username field: below covers the password field, so beside right', () => {
    const f = form(397);
    const { pick, tried } = placeMenu(f.u, 236, f.all, { w: 1100, h: 620 });
    expect(tried[0]).toMatchObject({ name: 'below', why: 'covers Password field' });
    expect(pick.name).toBe('beside right');
    expect(coversNothing(pick, f.all)).toBe(true);
  });

  it('from the password field: below covers the checkbox, so beside right', () => {
    const f = form(397);
    const { pick, tried } = placeMenu(f.p, 236, f.all, { w: 1100, h: 620 });
    expect(tried[0]!.why).toBe('covers Checkbox');
    expect(pick.name).toBe('beside right');
  });

  it('narrow window: falls back through above and the compact size, never covering anything', () => {
    for (const anchor of ['u', 'p'] as const) {
      const f = form(30);
      const v = { w: 420, h: 620 };
      const { pick } = placeMenu(f[anchor], 236, f.all, v);
      expect(inside(pick, v)).toBe(true);
      expect(coversNothing(pick, f.all)).toBe(true);
    }
  });

  it('uses the compact height when the full menu fits nowhere', () => {
    const f = form(30);
    const { pick } = placeMenu(f.p, 236, f.all, { w: 420, h: 560 });
    expect(pick.h).toBe(MENU_COMPACT_H);
    expect(pick.name).toContain('(compact)');
  });

  it('docks to the corner only when every side is blocked', () => {
    const full = [{ x: 0, y: 0, w: 400, h: 400, label: 'everything' }];
    const { pick } = placeMenu({ x: 10, y: 10, w: 100, h: 30 }, 236, full, { w: 400, h: 400 });
    expect(pick.name).toBe('docked bottom-right');
    expect(pick.w).toBe(MENU_W);
  });
});

describe('placePrompt (variant C)', () => {
  it('goes next to the form when there is room', () => {
    const f = form(397);
    const { pick } = placePrompt({ x: 370, y: 90, w: 360, h: 320 }, 250, f.all, { w: 1100, h: 700 });
    expect(pick.name).toBe('beside the form, right');
    expect(coversNothing(pick, f.all)).toBe(true);
  });

  it('after the page changed (no form): a corner', () => {
    expect(placePrompt(null, 250, [], { w: 1100, h: 700 }).pick.name).toBe('top right');
  });

  it('becomes the slim bar when the card fits nowhere', () => {
    const { pick } = placePrompt(null, 250, [], { w: 400, h: 240 });
    expect(pick.name).toMatch(/^slim bar/);
    expect(pick.h).toBeLessThan(70);
  });
});

describe('placePanel (teach, variant B)', () => {
  it('docks right, then left, then the slim bar', () => {
    const f = form(397);
    expect(placePanel(f.all, { w: 1100, h: 700 }).pick.name).toBe('docked right');
    const narrow = form(30);
    const r = placePanel(narrow.all, { w: 420, h: 700 });
    expect(r.pick.name).toMatch(/slim bar/);
    expect(coversNothing(r.pick, narrow.all)).toBe(true);
  });
});
