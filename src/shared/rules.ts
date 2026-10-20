// SPDX-License-Identifier: GPL-3.0-only
// "Teach this site" rules: which fields a site uses, recorded once by the user and stored only on this device.
// A field is remembered by a CSS selector plus its stable attributes, so a rule survives small page changes.
import { inputs, visible } from './fields';

export interface FieldRef {
  /** CSS selector from the field's document or shadow root. */
  sel: string;
  id: string | null;
  name: string | null;
  type: string;
  autocomplete: string | null;
  placeholder: string | null;
  /** Readable form for Settings and the panel: "#username", "input[name=login]". */
  label: string;
}

export interface SiteRule {
  username: FieldRef | null;
  password: FieldRef | null;
  totp: FieldRef | null;
  /** Page the rule was taught on (shown in Settings). */
  url: string;
  created: number;
}

const cssId = (s: string) => (typeof globalThis.CSS === 'undefined' ? s.replace(/[^\w-]/g, (c) => `\\${c}`) : CSS.escape(s));
const attr = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

function unique(sel: string, el: Element): boolean {
  try {
    const root = el.getRootNode() as Document | ShadowRoot;
    const hits = root.querySelectorAll(sel);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
}

/** Shortest selector that finds exactly this element, preferring ids and names over positions. */
export function selectorFor(el: HTMLInputElement): string {
  // Ids that look generated (react-123, :r4:) change between visits; skip them.
  if (el.id && !/\d{3,}|^:|^[a-f0-9-]{16,}$/i.test(el.id) && unique(`#${cssId(el.id)}`, el)) return `#${cssId(el.id)}`;
  if (el.name) {
    const s = `input[name=${attr(el.name)}]`;
    if (unique(s, el)) return s;
    const f = el.form?.id ? `#${cssId(el.form.id)} ${s}` : null;
    if (f && unique(f, el)) return f;
  }
  const ac = el.getAttribute('autocomplete');
  if (ac && unique(`input[autocomplete=${attr(ac)}]`, el)) return `input[autocomplete=${attr(ac)}]`;
  // Fall back to a path of :nth-of-type steps up to the root.
  const parts: string[] = [];
  for (let n: Element | null = el; n && n.parentElement; n = n.parentElement) {
    const tag = n.localName;
    const sibs = Array.from(n.parentElement.children).filter((c) => c.localName === tag);
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
    if (n.parentElement.id) {
      parts.unshift(`#${cssId(n.parentElement.id)}`);
      break;
    }
  }
  return parts.join(' > ');
}

export function refFor(el: HTMLInputElement): FieldRef {
  const sel = selectorFor(el);
  return {
    sel,
    id: el.id || null,
    name: el.name || null,
    type: el.type,
    autocomplete: el.getAttribute('autocomplete'),
    placeholder: el.placeholder || null,
    label: el.id ? `#${el.id}` : el.name ? `input[name=${el.name}]` : sel,
  };
}

/** Find the field a rule points at on the current page; falls back to matching its attributes. */
export function resolve(ref: FieldRef | null, root: Document = document): HTMLInputElement | null {
  if (!ref) return null;
  const all = inputs(root);
  for (const scope of new Set(all.map((i) => i.getRootNode() as Document | ShadowRoot))) {
    try {
      const hit = scope.querySelector(ref.sel);
      if (hit instanceof HTMLInputElement && visible(hit)) return hit;
    } catch {
      // a selector that no longer parses: use the attributes below
    }
  }
  const vis = all.filter(visible);
  const score = (i: HTMLInputElement) =>
    (ref.id && i.id === ref.id ? 4 : 0) + (ref.name && i.name === ref.name ? 3 : 0) + (ref.autocomplete && i.getAttribute('autocomplete') === ref.autocomplete ? 2 : 0) + (ref.placeholder && i.placeholder === ref.placeholder ? 1 : 0) + (i.type === ref.type ? 1 : 0);
  const best = vis.map((i) => [score(i), i] as const).sort((a, b) => b[0] - a[0])[0];
  return best && best[0] >= 3 ? best[1] : null;
}
