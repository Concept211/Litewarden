// SPDX-License-Identifier: GPL-3.0-only
// Fill engine. Injected on demand into the tab's frames when the user asks to fill (popup, in-page menu,
// shortcut); it never runs on page load and never reads or sends anything by itself. Fields are found at fill
// time, so pages that re-render their form (SPAs) still work. A "teach this site" rule wins over detection.
import { plan, setValue, type Plan } from '../shared/fields';
import { countryWants, expiryFor, formFields, monthWants, pickOption, stateWants, yearWants, type CardData, type FormField, type IdentityData } from '../shared/forms';
import { resolve, type SiteRule } from '../shared/rules';

type Filled = Array<'username' | 'password' | 'totp'>;

type Rules = Record<string, SiteRule> | null;

function fields(rules: Rules): Plan & { totp: HTMLInputElement | null } {
  const rule = rules?.[location.hostname];
  if (rule) {
    const u = resolve(rule.username);
    const p = resolve(rule.password);
    if (u || p) return { username: u, password: p, totp: resolve(rule.totp) };
  }
  return { ...plan(), totp: null };
}

function probe(rules: Rules = null) {
  const p = fields(rules);
  return { score: p.password ? 2 : p.username ? 1 : 0, origin: location.origin, top: window === window.top };
}

function fill(username: string | null, password: string | null, rules: Rules = null, code: string | null = null): Filled {
  const p = fields(rules);
  const done: Filled = [];
  if (p.username && username) {
    setValue(p.username, username);
    done.push('username');
  }
  if (p.password && password) {
    setValue(p.password, password);
    done.push('password');
  }
  if (p.totp && code) {
    setValue(p.totp, code);
    done.push('totp');
  }
  // Leave focus where the user would press Enter next.
  (p.password ?? p.username)?.focus({ preventScroll: true });
  return done;
}

// ---------- cards and addresses ----------

/** How many card (or address) parts this frame has, and whether one is the card number. */
function probeForm(kind: 'card' | 'identity') {
  const f = formFields(document, false);
  const list = kind === 'card' ? f.card : f.addr;
  return { count: list.length, number: f.card.some((c) => c.part === 'number'), origin: location.origin, top: window === window.top };
}

function put(el: FormField, value: string | null | undefined, wants?: string[]): boolean {
  if (!value) return false;
  if (el instanceof HTMLSelectElement) return pickOption(el, wants ?? [value]);
  if (el instanceof HTMLTextAreaElement) {
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }
  if (el.maxLength > 0 && value.length > el.maxLength && !/\s/.test(value)) value = value.slice(0, el.maxLength);
  setValue(el, value);
  return true;
}

function fillCard(c: CardData): string[] {
  const done: string[] = [];
  const name = (c.cardholderName ?? '').trim();
  const [given, ...rest] = name.split(/\s+/);
  for (const { el, part } of formFields(document, false).card) {
    let ok = false;
    if (part === 'number') ok = put(el, c.number?.replace(/\D/g, ''));
    else if (part === 'name') ok = put(el, name);
    else if (part === 'given') ok = put(el, given);
    else if (part === 'family') ok = put(el, rest.join(' '));
    else if (part === 'code') ok = put(el, c.code);
    else if (part === 'brand') ok = put(el, c.brand, c.brand ? [c.brand, c.brand.replace(/\s+/g, ''), c.brand === 'Amex' ? 'American Express' : c.brand] : []);
    else if (c.expMonth && c.expYear && part === 'exp') ok = el instanceof HTMLInputElement ? put(el, expiryFor(el, c.expMonth, c.expYear)) : false;
    else if (part === 'month') ok = put(el, el instanceof HTMLSelectElement ? c.expMonth : c.expMonth?.padStart(2, '0'), c.expMonth ? monthWants(c.expMonth) : []);
    else if (part === 'year' && c.expYear) {
      const two = el instanceof HTMLInputElement && (el.maxLength === 2 || /\byy\b/i.test(el.placeholder));
      ok = put(el, two ? c.expYear.slice(-2) : c.expYear.length === 2 ? `20${c.expYear}` : c.expYear, yearWants(c.expYear));
    }
    if (ok) done.push(part);
  }
  return done;
}

function fillIdentity(d: IdentityData): string[] {
  const done: string[] = [];
  const full = [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ');
  const lines = [d.address1, d.address2, d.address3].filter(Boolean) as string[];
  const f = formFields(document, false).addr;
  const has = new Set(f.map((x) => x.part));
  for (const { el, part } of f) {
    let v: string | null = null;
    let wants: string[] | undefined;
    if (part === 'fullName') v = full;
    else if (part === 'street') v = el instanceof HTMLTextAreaElement ? lines.join('\n') : has.has('address2') ? d.address1 : lines.join(', ');
    else if (part === 'address1') v = has.has('address2') ? d.address1 : lines.join(', ');
    else if (part === 'state') {
      v = d.state;
      wants = d.state ? stateWants(d.state) : [];
    } else if (part === 'country') {
      v = d.country;
      wants = d.country ? countryWants(d.country) : [];
    } else v = d[part as keyof IdentityData] ?? null;
    if (put(el, v, wants)) done.push(part);
  }
  return done;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    (window as unknown as { __lwProbe: typeof probe }).__lwProbe = probe;
    (window as unknown as { __lwFill: typeof fill }).__lwFill = fill;
    (window as unknown as { __lwProbeForm: typeof probeForm }).__lwProbeForm = probeForm;
    (window as unknown as { __lwFillCard: typeof fillCard }).__lwFillCard = fillCard;
    (window as unknown as { __lwFillIdentity: typeof fillIdentity }).__lwFillIdentity = fillIdentity;
  },
});
