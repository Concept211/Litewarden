// SPDX-License-Identifier: GPL-3.0-only
// Card numbers: the brand from the leading digits, spacing as printed, the Luhn check, and the expiry. Brand names are
// the ones the Bitwarden clients store, so a card saved here reads the same in the web vault.

export type BrandKey = 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'maestro' | 'other';

const BRANDS: Array<{ key: BrandKey; name: string; re: RegExp }> = [
  { key: 'amex', name: 'Amex', re: /^3[47]/ },
  { key: 'diners', name: 'Diners Club', re: /^3(?:0[0-5]|[689])/ },
  { key: 'jcb', name: 'JCB', re: /^35(?:2[89]|[3-8])/ },
  { key: 'visa', name: 'Visa', re: /^4/ },
  { key: 'mastercard', name: 'Mastercard', re: /^(?:5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/ },
  { key: 'discover', name: 'Discover', re: /^(?:6011|65|64[4-9]|622)/ },
  { key: 'unionpay', name: 'UnionPay', re: /^62/ },
  { key: 'maestro', name: 'Maestro', re: /^(?:5[06-9]|6)/ },
];

export const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** The brand name the Bitwarden clients use for this number, or null when the digits don't say. */
export function brandOf(number: string | null | undefined): string | null {
  const d = digits(number);
  if (d.length < 2) return d === '4' ? 'Visa' : null;
  return BRANDS.find((b) => b.re.test(d))?.name ?? null;
}

/** The logo to show for a stored brand name (any spelling the clients have used), else "other". */
export function brandKey(brand: string | null | undefined): BrandKey {
  const b = (brand ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!b) return 'other';
  if (b === 'americanexpress') return 'amex';
  if (b === 'dinersclub') return 'diners';
  return BRANDS.find((x) => x.key === b || x.name.toLowerCase().replace(/[^a-z]/g, '') === b)?.key ?? 'other';
}

/** Spaced as printed: Amex 4 6 5, Diners 4 6 4, everything else in fours. */
export function formatNumber(number: string): string {
  const d = digits(number).slice(0, 19);
  const k = brandKey(brandOf(d));
  const groups = k === 'amex' ? [4, 6, 5] : k === 'diners' && d.length <= 14 ? [4, 6, 4] : null;
  if (!groups) return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= d.length) break;
    out.push(d.slice(i, i + g));
    i += g;
  }
  return out.join(' ');
}

/** The card checksum. Only meaningful at 12 digits or more. */
export function luhn(number: string): boolean {
  const d = digits(number);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/** "08 / 28", "8/2028", "0828" -> month "8" and year "2028" (stored the way the web vault stores them). */
export function parseExpiry(s: string): { month: string | null; year: string | null } {
  const t = s.trim();
  const [mm, yy] = t.includes('/') ? t.split('/').map(digits) : [digits(t).slice(0, 2), digits(t).slice(2)];
  const mo = Number(mm);
  return {
    month: mm && mo >= 1 && mo <= 12 ? String(mo) : null,
    year: /^\d{4}$/.test(yy ?? '') ? yy! : /^\d{2}$/.test(yy ?? '') ? `20${yy}` : null,
  };
}

/** What goes in the MM / YY box for a stored month and year. */
export function showExpiry(month: string | null | undefined, year: string | null | undefined): string {
  const m = month && /^\d{1,2}$/.test(month) ? month.padStart(2, '0') : '';
  const y = year ? year.slice(-2) : '';
  return m || y ? `${m || '··'}/${y || '··'}` : '';
}

/** The box's text as the user types: "08 / 28". A lone 2 to 9 is a month: "0" goes in front. */
export function typeExpiry(raw: string, prev: string): string {
  let d = digits(raw).slice(0, 6);
  if (d.length === 1 && Number(d) > 1) d = `0${d}`;
  // Backspace over the " / " takes the month's last digit with it.
  if (raw.length < prev.length && prev.endsWith(' / ') && d.length === 2) d = d.slice(0, 1);
  return d.length < 2 ? d : `${d.slice(0, 2)} / ${d.slice(2)}`;
}

/** Past the end of its month. */
export function expired(month: string | null | undefined, year: string | null | undefined, now = new Date()): boolean {
  const m = Number(month);
  const y = Number(year && year.length === 2 ? `20${year}` : year);
  if (!m || !y) return false;
  return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
}

/** expired() for the list's "08/28". */
export function expiredMMYY(mmyy: string, now = new Date()): boolean {
  const [m, y] = mmyy.split('/');
  return expired(m, y && /^\d{2}$/.test(y) ? `20${y}` : y, now);
}

/** "Visa •4242" for a card's default name and list subtitle. */
export function cardLabel(brand: string | null | undefined, number: string | null | undefined): string {
  const last = digits(number).slice(-4);
  return [brand || (last ? 'Card' : ''), last ? `•${last}` : ''].filter(Boolean).join(' ');
}
