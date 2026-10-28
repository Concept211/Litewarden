// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../src/core/bytes';
import { webCrypto as C } from '../../src/core/crypto';
import { brandKey, brandOf, cardLabel, expired, expiredMMYY, formatNumber, luhn, parseExpiry, showExpiry, typeExpiry } from '../../src/core/cards';
import { autoName, encryptDraft, type Draft } from '../../src/core/edit';
import { decryptItem, decryptListItem, type Keys } from '../../src/core/vault';
import type { Cipher } from '../../src/core/api';

describe('card numbers', () => {
  it('reads the brand from the leading digits, with the names the web vault uses', () => {
    expect(brandOf('4242 4242 4242 4242')).toBe('Visa');
    expect(brandOf('5555555555554444')).toBe('Mastercard');
    expect(brandOf('2221000000000009')).toBe('Mastercard');
    expect(brandOf('378282246310005')).toBe('Amex');
    expect(brandOf('6011111111111117')).toBe('Discover');
    expect(brandOf('36227206271667')).toBe('Diners Club');
    expect(brandOf('3530111333300000')).toBe('JCB');
    expect(brandOf('6200000000000005')).toBe('UnionPay');
    expect(brandOf('1')).toBeNull();
    expect(brandOf('')).toBeNull();
  });
  it('maps any stored brand spelling to its mark', () => {
    expect(brandKey('Visa')).toBe('visa');
    expect(brandKey('American Express')).toBe('amex');
    expect(brandKey('Diners Club')).toBe('diners');
    expect(brandKey('Mastercard')).toBe('mastercard');
    expect(brandKey('Other')).toBe('other');
    expect(brandKey(null)).toBe('other');
  });
  it('spaces numbers as printed', () => {
    expect(formatNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatNumber('42424')).toBe('4242 4');
    expect(formatNumber('378282246310005')).toBe('3782 822463 10005');
    expect(formatNumber('36227206271667')).toBe('3622 720627 1667');
    expect(formatNumber('4242-4242 4242x4242')).toBe('4242 4242 4242 4242');
  });
  it('checks the Luhn sum (12 digits or more)', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
    expect(luhn('378282246310005')).toBe(true);
    expect(luhn('4242')).toBe(false);
  });
});

describe('card expiry', () => {
  it('parses what people type into month and four-digit year', () => {
    expect(parseExpiry('08 / 28')).toEqual({ month: '8', year: '2028' });
    expect(parseExpiry('8/2028')).toEqual({ month: '8', year: '2028' });
    expect(parseExpiry('0828')).toEqual({ month: '8', year: '2028' });
    expect(parseExpiry('13/28')).toEqual({ month: null, year: '2028' });
    expect(parseExpiry('08 / 2')).toEqual({ month: '8', year: null });
  });
  it('formats as you type, and backspace over the slash takes a digit', () => {
    expect(typeExpiry('8', '')).toBe('08 / ');
    expect(typeExpiry('1', '')).toBe('1');
    expect(typeExpiry('12', '1')).toBe('12 / ');
    expect(typeExpiry('082', '08')).toBe('08 / 2');
    expect(typeExpiry('08 / 28', '08 / 2')).toBe('08 / 28');
    expect(typeExpiry('08 /', '08 / ')).toBe('0');
  });
  it('shows MM/YY and knows when a card has expired', () => {
    expect(showExpiry('8', '2028')).toBe('08/28');
    expect(showExpiry(null, null)).toBe('');
    const now = new Date(2026, 9, 28);
    expect(expired('10', '2026', now)).toBe(false);
    expect(expired('9', '2026', now)).toBe(true);
    expect(expired('1', '26', now)).toBe(true);
    expect(expired(null, '2020', now)).toBe(false);
    expect(expiredMMYY('03/25', now)).toBe(true);
    expect(expiredMMYY('11/27', now)).toBe(false);
  });
  it('names a card from its brand and last four', () => {
    expect(cardLabel('Visa', '4242424242424242')).toBe('Visa •4242');
    expect(cardLabel(null, '1234567890123')).toBe('Card •0123');
    expect(cardLabel(null, null)).toBe('');
  });
});

describe('saving cards, identities and custom fields', () => {
  const userKey = C.symKey(randomBytes(64));
  const keys: Keys = { userKey, privateKeys: null, orgKeys: new Map(), orgKeyErrors: new Map() };
  const roundTrip = async (d: Draft, original: Cipher | null = null) => {
    const body = await encryptDraft(C, d, keys, { original, encryptedFor: 'u1' });
    const c = { ...body, id: original?.id ?? 'x1', revisionDate: '2026-10-28T00:00:00Z' } as unknown as Cipher;
    return { body, c, item: await decryptItem(C, c, keys), list: await decryptListItem(C, c, keys) };
  };

  it('a new card: every card key written, empty ones null; the list shows brand, last four and expiry', async () => {
    const d: Draft = { type: 3, name: '', notes: null, folderId: null, card: { cardholderName: 'Alex Rivera', brand: 'Visa', number: '4242424242424242', expMonth: '8', expYear: '2028', code: '' }, fields: [] };
    const named = { ...d, name: autoName(d) };
    expect(named.name).toBe('Visa •4242');
    const { body, item, list } = await roundTrip(named);
    expect(body.login).toBeNull();
    expect(item.card).toEqual({ cardholderName: 'Alex Rivera', brand: 'Visa', number: '4242424242424242', expMonth: '8', expYear: '2028', code: null });
    expect(list).toMatchObject({ subtitle: 'Visa •4242', brand: 'Visa', exp: '08/28' });
  });

  it('editing keeps what the draft leaves out, and custom fields keep linked ones', async () => {
    const first = await roundTrip({ type: 3, name: 'Card', notes: null, folderId: null, card: { cardholderName: 'A', brand: 'Visa', number: '4111111111111111', expMonth: '1', expYear: '2030', code: '999' }, fields: [{ name: 'PIN', value: '1234', type: 1 }, { name: 'L', value: '', type: 3, linkedId: 305 }] });
    // A caller that only changes the name (no card, no fields in the draft): the card and fields stay.
    const second = await roundTrip({ type: 3, name: 'Renamed', notes: null, folderId: null }, first.c);
    expect(second.item.card?.code).toBe('999');
    expect(second.item.fields).toEqual([{ name: 'PIN', value: '1234', type: 1, linkedId: null }, { name: 'L', value: null, type: 3, linkedId: 305 }]);
    // Empty custom field rows are dropped.
    const third = await roundTrip({ type: 3, name: 'Renamed', notes: null, folderId: null, fields: [{ name: '', value: '', type: 0 }, { name: 'Member', value: '7', type: 0 }] }, first.c);
    expect(third.item.fields).toEqual([{ name: 'Member', value: '7', type: 0, linkedId: null }]);
  });

  it('a new identity: the name comes from first and last; the list shows who and where', async () => {
    const d: Draft = { type: 4, name: '', notes: null, folderId: null, identity: { firstName: 'Alex', lastName: 'Rivera', city: 'Miami', state: 'FL', email: 'alex@example.com' }, fields: [] };
    const { item, list } = await roundTrip({ ...d, name: autoName(d) });
    expect(item.name).toBe('Alex Rivera');
    expect(item.identity).toMatchObject({ firstName: 'Alex', city: 'Miami', ssn: null, passportNumber: null });
    expect(list.subtitle).toBe('Alex Rivera · Miami, FL');
  });

  it('a new secure note is a type 2 note with nothing else', async () => {
    const { body } = await roundTrip({ type: 2, name: 'Wi-Fi', notes: 'Harbor-5G', folderId: null, fields: [] });
    expect(body).toMatchObject({ type: 2, secureNote: { type: 0 }, login: null, card: null, identity: null });
  });
});
