// SPDX-License-Identifier: GPL-3.0-only
// Card and address fields on checkout and shipping forms, shared by the in-page script (icons, which menu to open)
// and the fill script (where each part of a card or an identity goes). Plain DOM like fields.ts. Evidence in order:
// the autocomplete attribute (the standard tokens, with "shipping" / "billing" / section-* in front), then the
// field's name, id, placeholder, aria-label and label text.
import { ac, describe } from './fields';

export type CardPart = 'number' | 'name' | 'given' | 'family' | 'exp' | 'month' | 'year' | 'code' | 'brand';
export type AddrPart =
  | 'fullName'
  | 'title'
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'company'
  | 'street'
  | 'address1'
  | 'address2'
  | 'address3'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'email'
  | 'phone';

export type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const CARD_AC: Record<string, CardPart> = {
  'cc-number': 'number',
  'cc-name': 'name',
  'cc-given-name': 'given',
  'cc-family-name': 'family',
  'cc-exp': 'exp',
  'cc-exp-month': 'month',
  'cc-exp-year': 'year',
  'cc-csc': 'code',
  'cc-type': 'brand',
};

const ADDR_AC: Record<string, AddrPart> = {
  name: 'fullName',
  'honorific-prefix': 'title',
  'given-name': 'firstName',
  'additional-name': 'middleName',
  'family-name': 'lastName',
  organization: 'company',
  'street-address': 'street',
  'address-line1': 'address1',
  'address-line2': 'address2',
  'address-line3': 'address3',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
};

// Names, ids and labels. Checked in this order: the first match wins, so the specific ones come first.
const CARD_WORDS: Array<[CardPart, RegExp]> = [
  ['code', /\b(cvc|cvv|cvn|csc|cid)\d?\b|cvc|cvv|security.?code|card.?code|card.?verif|verification.?(code|number|value)/i],
  ['month', /exp\w*.?(month|mm\b|mo\b)|(month|mm|mo)\W*exp|card.?month|cc.?month/i],
  ['year', /exp\w*.?(year|yy|yr)|(year|yy|yr)\W*exp|card.?year|cc.?year/i],
  ['exp', /expir|exp.?date|\bexp\b|valid.?(thru|through|until)|mm\s*\/\s*yy|cc.?exp|card.?exp/i],
  ['name', /name.?on.?card|card.?holder|cardholder|holder.?name|cc.?name|card.?name|nameoncard/i],
  ['number', /card.?(number|num|no\b|#)|cc.?(number|num|no\b)|cardnumber|ccnum|credit.?card|debit.?card|\bpan\b|acct.?num/i],
];

const ADDR_WORDS: Array<[AddrPart, RegExp]> = [
  ['email', /e.?mail/i],
  ['phone', /phone|\btel\b|telephone|mobile|cell/i],
  ['postalCode', /zip|postal|post.?code|postcode|\bpin.?code/i],
  ['country', /country/i],
  ['state', /\bstate\b|province|region|county|prefecture|\bstate.?code|address.?level.?1/i],
  ['city', /city|town|locality|suburb|address.?level.?2/i],
  ['address3', /address.?(line)?.?3|addr.?3|street.?3/i],
  ['address2', /address.?(line)?.?2|addr.?2|street.?2|\bapt\b|apartment|suite|\bunit\b|building|floor/i],
  ['address1', /address.?(line)?.?1|addr.?1|street|^address$|\baddress\b|\baddr\b|house.?(number|no)/i],
  ['company', /company|organi[sz]ation|business.?name|\bfirm\b/i],
  ['firstName', /first.?name|fname|given.?name|forename|\bfirst\b/i],
  ['middleName', /middle.?name|mname|middle.?initial/i],
  ['lastName', /last.?name|lname|surname|family.?name|\blast\b/i],
  ['title', /\btitle\b|salutation|honorific|prefix/i],
  ['fullName', /full.?name|your.?name|^name$|\bname\b|recipient|contact.?name/i],
];

/** Not a card or address field, whatever its name says: search boxes, coupons, gift cards, quantities. */
const NOT_FORM = /search|query|coupon|promo|voucher|gift.?card|discount|quantity|\bqty\b|captcha|otp|one.?time|password|username|login|newsletter|comment|message|note/i;

const TEXTISH = new Set(['', 'text', 'email', 'tel', 'number', 'search', 'url']);

function fillable(el: Element): el is FormField {
  if (el instanceof HTMLInputElement) return TEXTISH.has(el.type) || el.type === 'month';
  return el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}

function shown(el: FormField): boolean {
  if (!el.isConnected || el.disabled || (el as HTMLInputElement).readOnly) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

const acOf = (el: FormField) => (el instanceof HTMLInputElement ? ac(el) : (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/));

/** The field's names and labels as words: "ship_state", "shipState" and "ship-state" all read "ship state". */
function text(el: FormField): string {
  const label = el.labels?.[0]?.textContent ?? '';
  const raw = el instanceof HTMLInputElement ? describe(el) : [el.getAttribute('name') ?? '', el.id, el.getAttribute('placeholder') ?? '', el.getAttribute('aria-label') ?? '', label].join(' ');
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]]+/g, ' ');
}

export function cardPart(el: FormField): CardPart | null {
  const a = acOf(el);
  for (const t of a) if (CARD_AC[t]) return CARD_AC[t]!;
  if (a.some((t) => ADDR_AC[t] || t === 'username' || t.endsWith('password') || t === 'one-time-code')) return null;
  const d = text(el);
  if (!d.trim() || /gift.?card|coupon|promo|voucher|search/i.test(d)) return null;
  // Card words only count with a hint of a card around them, so a "Name" or "Year of birth" box isn't one.
  for (const [part, re] of CARD_WORDS) {
    if (!re.test(d)) continue;
    if ((part === 'month' || part === 'year' || part === 'exp') && /birth|dob\b|graduat/i.test(d)) return null;
    return part;
  }
  return null;
}

export function addrPart(el: FormField): AddrPart | null {
  const a = acOf(el);
  for (const t of a) if (ADDR_AC[t]) return ADDR_AC[t]!;
  if (a.some((t) => CARD_AC[t] || t === 'username' || t.endsWith('password') || t === 'one-time-code')) return null;
  const d = text(el);
  if (!d.trim() || NOT_FORM.test(d) || cardPart(el)) return null;
  for (const [part, re] of ADDR_WORDS) if (re.test(d)) return part;
  return null;
}

export interface FormMap {
  card: Array<{ el: FormField; part: CardPart }>;
  addr: Array<{ el: FormField; part: AddrPart }>;
}

/** Address parts that make a form an address form (with at least two others): not just a name and an email. */
const PLACE: AddrPart[] = ['street', 'address1', 'city', 'postalCode', 'state'];

/**
 * The visible card and address fields under `root`. `strict` (for icons): a card form needs its number box and an
 * address form a real address. The fill takes every part it finds, since a payment company puts each card box in a
 * frame of its own (the number in one, the expiry in the next).
 */
export function formFields(root: Document | ShadowRoot | Element = document, strict = true): FormMap {
  const card: FormMap['card'] = [];
  const addr: FormMap['addr'] = [];
  for (const el of allFields(root)) {
    // The names first (cheap), the computed style only for the fields that matter.
    const c = cardPart(el);
    const p = c ? null : addrPart(el);
    if (!(c || p) || !shown(el)) continue;
    if (c) card.push({ el, part: c });
    else addr.push({ el, part: p! });
  }
  // A card form has a number box; the rest alone (a "Name" or "Expiry" somewhere) isn't one.
  const hasNumber = card.some((c) => c.part === 'number');
  const parts = new Set(addr.map((a) => a.part));
  const isAddress = parts.size >= 3 && PLACE.some((p) => parts.has(p));
  if (!strict) return { card, addr };
  return { card: hasNumber ? card : [], addr: isAddress ? addr : [] };
}

/** Inputs, selects and text areas in document order, through open shadow roots. */
export function allFields(root: Document | ShadowRoot | Element = document): FormField[] {
  const out: FormField[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument!;
  const walk = (r: Document | ShadowRoot | Element) => {
    const w = doc.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
    for (let n = w.currentNode as Element | null; n; n = w.nextNode() as Element | null) {
      if (fillable(n)) out.push(n);
      if (n.shadowRoot) walk(n.shadowRoot);
    }
  };
  walk(root);
  return out;
}

/** Cheap first check for the lazy content script: anything that looks like a card or address field. */
export function looksLikeForm(doc: Document): boolean {
  return !!doc.querySelector(
    'input[autocomplete*=cc-number i], input[autocomplete*=postal-code i], input[autocomplete*=address-line1 i], input[autocomplete*=street-address i], input[name*=card i], input[id*=card i], input[name*=zip i], input[name*=postal i], input[id*=zip i], input[name*=address i], input[id*=address i]',
  );
}

// ---------- filling ----------

/** The value of the option that matches one of `wants` (value or text, any case, else a text that starts with it). */
export function matchOption(opts: Array<{ value: string; text: string }>, wants: string[]): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const w = wants.filter(Boolean).map(norm);
  const hit = opts.find((o) => w.includes(norm(o.value)) || w.includes(norm(o.text))) ?? opts.find((o) => w.some((x) => x.length > 2 && norm(o.text).startsWith(x)));
  return hit ? hit.value : null;
}

/** Set a select to the option that matches one of `wants`. True when one did. */
export function pickOption(sel: HTMLSelectElement, wants: string[]): boolean {
  const value = matchOption(Array.from(sel.options, (o) => ({ value: o.value, text: o.text })), wants);
  if (value == null) return false;
  sel.focus({ preventScroll: true });
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(sel, value);
  else sel.value = value;
  const o = { bubbles: true, composed: true };
  sel.dispatchEvent(new Event('input', o));
  sel.dispatchEvent(new Event('change', o));
  return true;
}

export interface CardData {
  cardholderName: string | null;
  number: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
  brand: string | null;
}

/** Month and year as the field wants them: "8", "08", "Aug", "August"; "28" or "2028". */
export function monthWants(m: string): string[] {
  const n = Number(m);
  if (!(n >= 1 && n <= 12)) return [];
  const long = new Date(2000, n - 1, 1).toLocaleString('en-US', { month: 'long' });
  return [String(n), String(n).padStart(2, '0'), long, long.slice(0, 3), `${String(n).padStart(2, '0')} - ${long}`];
}
export function yearWants(y: string): string[] {
  const full = y.length === 2 ? `20${y}` : y;
  return [full, full.slice(-2)];
}

/** The expiry for a single box, in the shape its placeholder, pattern or length asks for. */
export function expiryFor(el: HTMLInputElement, m: string, y: string): string {
  const mm = m.padStart(2, '0');
  const full = y.length === 2 ? `20${y}` : y;
  if (el.type === 'month') return `${full}-${mm}`;
  const hint = `${el.placeholder} ${el.getAttribute('aria-label') ?? ''} ${el.labels?.[0]?.textContent ?? ''} ${el.getAttribute('pattern') ?? ''}`;
  const max = Number(el.getAttribute('maxlength') ?? 0);
  const long = /yyyy|aaaa|jjjj/i.test(hint) || max === 9;
  const yr = long ? full : full.slice(-2);
  if (max === 4 || /mm\s*yy/i.test(hint.replace(/[\/-]/g, '#'))) return `${mm}${yr}`;
  if (/mm\s+[/-]\s+yy/i.test(hint) || (max === 7 && !long)) return `${mm} / ${yr}`;
  if (/mm\s*-\s*yy/i.test(hint)) return `${mm}-${yr}`;
  return `${mm}/${yr}`;
}

export interface IdentityData {
  title: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** "FL" or "Florida": both, so a select of either kind finds it. */
export function stateWants(s: string): string[] {
  const t = s.trim();
  const code = Object.keys(US_STATES).find((k) => k === t.toUpperCase() || US_STATES[k]!.toLowerCase() === t.toLowerCase());
  return code ? [code, US_STATES[code]!, `US-${code}`] : [t];
}

/** "US", "USA", "United States": the code and the English name, so a select of either kind finds it. */
export function countryWants(c: string): string[] {
  const t = c.trim();
  const out = [t];
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const alias: Record<string, string> = { usa: 'US', 'united states of america': 'US', america: 'US', uk: 'GB', 'great britain': 'GB', england: 'GB' };
  const codes = /^[a-z]{2}$/i.test(t) ? [t.toUpperCase()] : alias[t.toLowerCase()] ? [alias[t.toLowerCase()]!] : [];
  if (!codes.length) {
    // A name: every two-letter code with that English name (old codes share some, like DD and DE for Germany).
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const k = String.fromCharCode(a, b);
        try {
          if (names.of(k)?.toLowerCase() === t.toLowerCase()) codes.push(k);
        } catch {
          // not a region code
        }
      }
  }
  for (const code of codes) {
    out.push(code);
    try {
      const n = names.of(code);
      if (n && n !== code) out.push(n);
    } catch {
      // ignore
    }
    if (code === 'US') out.push('USA', 'United States of America');
    if (code === 'GB') out.push('United Kingdom', 'UK');
  }
  return out;
}
