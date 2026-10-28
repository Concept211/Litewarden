// SPDX-License-Identifier: GPL-3.0-only
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addrPart, cardPart, countryWants, expiryFor, matchOption, monthWants, stateWants, yearWants, type FormField } from '../../src/shared/forms';

const g = globalThis as Record<string, unknown>;
const KEYS = ['HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Event', 'InputEvent'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, g[k]]));
let doc: Document;
beforeAll(() => {
  const w = parseHTML('<!doctype html><html><body></body></html>') as unknown as Record<string, unknown> & { document: Document };
  for (const k of KEYS) if (w[k]) g[k] = w[k];
  doc = w.document;
});
afterAll(() => Object.assign(g, saved));

const el = (html: string) => {
  doc.body.innerHTML = html;
  return doc.body.firstElementChild as unknown as FormField;
};

describe('card fields', () => {
  it('reads the autocomplete tokens, with a section in front', () => {
    expect(cardPart(el('<input autocomplete="cc-number">'))).toBe('number');
    expect(cardPart(el('<input autocomplete="billing cc-exp">'))).toBe('exp');
    expect(cardPart(el('<input autocomplete="section-pay cc-csc">'))).toBe('code');
    expect(cardPart(el('<select autocomplete="cc-exp-month"></select>'))).toBe('month');
    expect(cardPart(el('<input autocomplete="cc-name">'))).toBe('name');
  });

  it('knows unmarked fields by their names', () => {
    expect(cardPart(el('<input name="cardnumber">'))).toBe('number');
    expect(cardPart(el('<input name="name_on_card">'))).toBe('name');
    expect(cardPart(el('<input name="cvv">'))).toBe('code');
    expect(cardPart(el('<input id="card-cvc">'))).toBe('code');
    expect(cardPart(el('<select name="exp_month"></select>'))).toBe('month');
    expect(cardPart(el('<select name="exp_year"></select>'))).toBe('year');
    expect(cardPart(el('<input placeholder="MM / YY">'))).toBe('exp');
  });

  it('leaves gift cards, coupons, birthdays and logins alone', () => {
    expect(cardPart(el('<input name="gift_card_number">'))).toBeNull();
    expect(cardPart(el('<input name="coupon_code">'))).toBeNull();
    expect(cardPart(el('<input name="birth_year" placeholder="Year of birth">'))).toBeNull();
    expect(cardPart(el('<input autocomplete="username" name="card_user">'))).toBeNull();
    expect(cardPart(el('<input name="full_name">'))).toBeNull();
  });
});

describe('address fields', () => {
  it('reads the autocomplete tokens', () => {
    expect(addrPart(el('<input autocomplete="shipping address-line1">'))).toBe('address1');
    expect(addrPart(el('<input autocomplete="postal-code">'))).toBe('postalCode');
    expect(addrPart(el('<select autocomplete="country"></select>'))).toBe('country');
    expect(addrPart(el('<input autocomplete="tel-national">'))).toBe('phone');
  });

  it('knows unmarked fields by their names, specific ones first', () => {
    expect(addrPart(el('<input name="ship_full_name">'))).toBe('fullName');
    expect(addrPart(el('<input name="ship_address1">'))).toBe('address1');
    expect(addrPart(el('<input name="ship_address2">'))).toBe('address2');
    expect(addrPart(el('<input name="ship_city">'))).toBe('city');
    expect(addrPart(el('<select name="ship_state"></select>'))).toBe('state');
    expect(addrPart(el('<input name="ship_zip">'))).toBe('postalCode');
    expect(addrPart(el('<input name="email" type="email">'))).toBe('email');
    expect(addrPart(el('<input placeholder="Email address">'))).toBe('email');
    expect(addrPart(el('<input name="first_name">'))).toBe('firstName');
    expect(addrPart(el('<input name="lastName">'))).toBe('lastName');
  });

  it('a card field is never an address field, and search boxes are neither', () => {
    expect(addrPart(el('<input name="name_on_card">'))).toBeNull();
    expect(addrPart(el('<input name="search" placeholder="Search by city">'))).toBeNull();
    expect(addrPart(el('<input autocomplete="current-password" name="address">'))).toBeNull();
  });
});

describe('values in the shape the form wants', () => {
  const box = (html: string) => el(html) as HTMLInputElement;
  it('a single expiry box follows its placeholder or length', () => {
    expect(expiryFor(box('<input placeholder="MM / YY">'), '8', '2031')).toBe('08 / 31');
    expect(expiryFor(box('<input placeholder="MM/YY">'), '8', '2031')).toBe('08/31');
    expect(expiryFor(box('<input placeholder="MM/YYYY">'), '8', '2031')).toBe('08/2031');
    expect(expiryFor(box('<input placeholder="MMYY">'), '8', '2031')).toBe('0831');
    expect(expiryFor(box('<input maxlength="4">'), '12', '31')).toBe('1231');
    expect(expiryFor(box('<input placeholder="MM-YY">'), '1', '2030')).toBe('01-30');
    expect(expiryFor(box('<input>'), '8', '2031')).toBe('08/31');
  });

  it('months, years, states and countries in every common spelling', () => {
    expect(monthWants('8')).toEqual(expect.arrayContaining(['8', '08', 'August', 'Aug']));
    expect(monthWants('13')).toEqual([]);
    expect(yearWants('2031')).toEqual(['2031', '31']);
    expect(yearWants('31')).toEqual(['2031', '31']);
    expect(stateWants('fl')).toEqual(expect.arrayContaining(['FL', 'Florida']));
    expect(stateWants('New York')).toEqual(expect.arrayContaining(['NY', 'New York']));
    expect(stateWants('Bavaria')).toEqual(['Bavaria']);
    expect(countryWants('US')).toEqual(expect.arrayContaining(['US', 'United States', 'USA']));
    expect(countryWants('United States')).toEqual(expect.arrayContaining(['US']));
    expect(countryWants('Germany')).toEqual(expect.arrayContaining(['DE', 'Germany']));
  });

  it('a select takes the option whose value or text matches', () => {
    const states = [{ value: '', text: 'Choose' }, { value: 'CA', text: 'California' }, { value: 'FL', text: 'Florida' }];
    expect(matchOption(states, stateWants('Florida'))).toBe('FL');
    expect(matchOption([{ value: 'Florida', text: 'Florida' }], stateWants('FL'))).toBe('Florida');
    const months = [{ value: '', text: 'Month' }, { value: '1', text: '01 - January' }, { value: '8', text: '08 - August' }];
    expect(matchOption(months, monthWants('8'))).toBe('8');
    expect(matchOption([{ value: 'aug', text: 'August' }], monthWants('8'))).toBe('aug');
    expect(matchOption([{ value: 'DE', text: 'Deutschland' }], countryWants('Germany'))).toBe('DE');
    expect(matchOption([{ value: 'x', text: 'Other' }], ['FL'])).toBeNull();
  });
});
