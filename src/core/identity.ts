// SPDX-License-Identifier: GPL-3.0-only
// Identity details Bitwarden has no slot for: date of birth, gender, job title, suffix, nationality, and the
// passport's and driver's license's issuer and expiry. Saved as named custom fields on the identity (like wallets
// on notes), so the official apps show them as ordinary fields. Fields made by hand ("DOB", "Birthday") count too.
// Dates are saved as YYYY-MM-DD; the popup shows and takes them as MM/DD/YYYY.

export type Extra = 'dob' | 'gender' | 'jobTitle' | 'suffix' | 'nationality' | 'passportCountry' | 'passportExpiry' | 'licenseState' | 'licenseExpiry';

/** The names new details are saved with. */
export const EXTRA_NAMES: Record<Extra, string> = {
  dob: 'Date of birth',
  gender: 'Gender',
  jobTitle: 'Job title',
  suffix: 'Suffix',
  nationality: 'Nationality',
  passportCountry: 'Passport country',
  passportExpiry: 'Passport expiry',
  licenseState: 'License state',
  licenseExpiry: 'License expiry',
};
export const DATE_EXTRAS: Extra[] = ['dob', 'passportExpiry', 'licenseExpiry'];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES: Record<string, Extra> = {
  'date of birth': 'dob', dob: 'dob', 'd o b': 'dob', birthday: 'dob', 'birth date': 'dob', birthdate: 'dob',
  gender: 'gender', sex: 'gender',
  'job title': 'jobTitle', 'title at work': 'jobTitle', position: 'jobTitle', occupation: 'jobTitle',
  suffix: 'suffix', 'name suffix': 'suffix',
  nationality: 'nationality', citizenship: 'nationality',
  'passport country': 'passportCountry', 'passport issued by': 'passportCountry', 'passport issuing country': 'passportCountry',
  'passport expiry': 'passportExpiry', 'passport expires': 'passportExpiry', 'passport expiration': 'passportExpiry', 'passport expiration date': 'passportExpiry',
  'license state': 'licenseState', 'license issued by': 'licenseState', 'driver s license state': 'licenseState', 'drivers license state': 'licenseState',
  'license expiry': 'licenseExpiry', 'license expires': 'licenseExpiry', 'license expiration': 'licenseExpiry', 'license expiration date': 'licenseExpiry',
};

/** Which detail a custom field holds, from its name. Text fields only: one saved as hidden stays a masked custom field. */
export function extraPart(name: string | null | undefined, type = 0): Extra | null {
  if (!name || type !== 0) return null;
  return ALIASES[key(name)] ?? null;
}

type Field = { name: string | null; value: string | null; type: number };
export interface Extras {
  values: Partial<Record<Extra, string>>;
  /** Index of each detail's field in the item's fields. */
  at: Partial<Record<Extra, number>>;
}

/** The details among an identity's custom fields. The first field with a name wins; a second one stays a custom field. */
export function extrasOf(fields: readonly Field[] | null | undefined): Extras {
  const x: Extras = { values: {}, at: {} };
  (fields ?? []).forEach((f, i) => {
    const part = extraPart(f.name, f.type);
    if (!part || x.at[part] !== undefined) return;
    x.at[part] = i;
    if (f.value?.trim()) x.values[part] = f.value.trim();
  });
  return x;
}

/** Fields with one detail set (or removed, for an empty value). Other fields keep their place. */
export function withExtra<F extends { name: string; value: string; type: number }>(fields: F[], part: Extra, value: string | null, make: (name: string, value: string) => F): F[] {
  const at = extrasOf(fields).at[part];
  if (!value?.trim()) return at === undefined ? fields : fields.filter((_, i) => i !== at);
  if (at !== undefined) return fields.map((f, i) => (i === at ? { ...f, value } : f));
  return [...fields, make(EXTRA_NAMES[part], value)];
}

// ---------- dates ----------

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** A saved or typed date: YYYY-MM-DD, or MM/DD/YYYY (also with dashes or dots). Null when it isn't one of those. */
export function readDate(s: string | null | undefined): Ymd | null {
  const t = (s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const p = m ? { y: +m[1]!, m: +m[2]!, d: +m[3]! } : (m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t)) ? { y: +m[3]!, m: +m[1]!, d: +m[2]! } : null;
  if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > daysIn(p.y, p.m)) return null;
  return p;
}

export const isoDate = (p: Ymd) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
export const usDate = (p: Ymd) => `${pad(p.m)}/${pad(p.d)}/${p.y}`;
/** "March 14, 1988"; "Mar 14, 1988" short. */
export const longDate = (p: Ymd, short = false) => new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString('en-US', { month: short ? 'short' : 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Digits typed into a date box, with the slashes put in: "0314" becomes "03/14", "03141988" "03/14/1988". Slashes
 * the user typed ("3/14/1988") and anything that isn't digits and slashes are left alone. */
export function maskDate(typed: string): string {
  if (/[^\d/]/.test(typed) || /^\d{1,2}\/\d{0,2}(\/\d{0,4})?$/.test(typed)) return typed;
  const d = typed.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
}

/** What's wrong with a typed date, or null when it's fine (or empty). `past`: a birth date can't be in the future. */
export function dateProblem(typed: string, past: boolean, today = new Date()): string | null {
  const t = typed.trim();
  if (!t) return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t) ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return 'Type it as MM/DD/YYYY.';
  const iso = /^\d{4}-/.test(t);
  const [y, mo, d] = iso ? [+m[1]!, +m[2]!, +m[3]!] : [+m[3]!, +m[1]!, +m[2]!];
  if (mo < 1 || mo > 12) return 'The month goes from 01 to 12.';
  if (d < 1 || d > daysIn(y, mo)) {
    const name = new Date(Date.UTC(2000, mo - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    return `${name} has ${daysIn(y, mo) === 29 ? '29 days at most' : `${daysIn(y, mo)} days`}.`;
  }
  if (past) {
    const now = isoDate({ y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() });
    if (isoDate({ y, m: mo, d }) > now) return "That's in the future.";
    if (y < today.getFullYear() - 130) return 'Check the year.';
  }
  return null;
}

/** Whole years between a birth date and today. */
export function ageOf(p: Ymd, today = new Date()): number {
  const m = today.getMonth() + 1;
  return today.getFullYear() - p.y - (m < p.m || (m === p.m && today.getDate() < p.d) ? 1 : 0);
}

/** Whole months until a date (0 when under a month), negative once it's past. */
export function monthsUntil(p: Ymd, today = new Date()): number {
  const t = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
  if (isoDate(p) < isoDate(t)) return -1;
  return (p.y - t.y) * 12 + (p.m - t.m) - (p.d < t.d ? 1 : 0);
}

/** The line under a passport or license number: issuer and expiry, with a warning when it's close or past. */
export function docLine(issuer: string | undefined, expiry: string | undefined, warnMonths: number, today = new Date()): { text: string; tone: '' | 'soon' | 'gone' } | null {
  const p = readDate(expiry);
  if (!issuer && !expiry) return null;
  if (!p) return { text: [issuer, expiry && `expires ${expiry}`].filter(Boolean).join(' · '), tone: '' };
  const left = monthsUntil(p, today);
  if (left < 0) return { text: [issuer, `Expired ${longDate(p, true)}`].filter(Boolean).join(' · '), tone: 'gone' };
  if (left < warnMonths) {
    const when = left === 0 ? 'Expires in under a month' : `Expires in ${left} month${left === 1 ? '' : 's'}`;
    return { text: [issuer, `${when} (${longDate(p, true)})`].filter(Boolean).join(' · '), tone: 'soon' };
  }
  return { text: [issuer, `expires ${longDate(p, true)}`].filter(Boolean).join(' · '), tone: '' };
}

/**
 * Before saving: a date typed as digits that isn't a real date (or a birth date in the future). Only dates changed in
 * this edit count, so a date saved elsewhere in another format ("14/03/1988") doesn't block the save.
 */
export function datesToFix(fields: readonly Field[] | null | undefined, saved: readonly Field[] | null | undefined, today = new Date()): string | null {
  const now = extrasOf(fields).values;
  const before = extrasOf(saved).values;
  for (const [part, what] of [['dob', 'date of birth'], ['passportExpiry', 'passport expiry'], ['licenseExpiry', 'license expiry']] as const) {
    const v = now[part];
    if (!v || v === before[part] || !/^[\d/.-]+$/.test(v)) continue;
    const why = dateProblem(v, part === 'dob', today) ?? (readDate(v) ? null : 'Type it as MM/DD/YYYY.');
    if (why) return `Check the ${what}. ${why}`;
  }
  return null;
}

export const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
