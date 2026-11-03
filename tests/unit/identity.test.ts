// SPDX-License-Identifier: GPL-3.0-only
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageOf, dateProblem, datesToFix, docLine, extraPart, extrasOf, maskDate, readDate, withExtra } from '../../src/core/identity';
import { addrPart, dateFor, genderWants, type FormField } from '../../src/shared/forms';

const f = (name: string, value: string, type = 0) => ({ name, value, type, linkedId: null });
const TODAY = new Date(2026, 10, 3); // Nov 3, 2026

describe('identity details in custom fields', () => {
  it('reads the saved names and the common hand-made ones', () => {
    expect(extraPart('Date of birth')).toBe('dob');
    expect(extraPart('DOB')).toBe('dob');
    expect(extraPart('Birthday')).toBe('dob');
    expect(extraPart('Sex')).toBe('gender');
    expect(extraPart("Driver's license state")).toBe('licenseState');
    expect(extraPart('Driver’s license state')).toBe('licenseState');
    expect(extraPart('Passport expiration date')).toBe('passportExpiry');
    expect(extraPart('Date of birth', 2)).toBeNull();
    // Saved as hidden: stays a masked custom field.
    expect(extraPart('Date of birth', 1)).toBeNull();
    expect(extraPart('Member ID')).toBeNull();
  });

  it('finds them and where they are; the first of a name wins', () => {
    const x = extrasOf([f('Member ID', '7'), f('DOB', '1988-03-14'), f('Gender', 'Male'), f('Birthday', '1990-01-01')]);
    expect(x.values).toEqual({ dob: '1988-03-14', gender: 'Male' });
    expect(x.at).toEqual({ dob: 1, gender: 2 });
  });

  it('sets, changes and removes one, leaving the others in place', () => {
    const mk = (name: string, value: string) => f(name, value);
    let fields = [f('Member ID', '7')];
    fields = withExtra(fields, 'dob', '1988-03-14', mk);
    expect(fields).toEqual([f('Member ID', '7'), f('Date of birth', '1988-03-14')]);
    fields = withExtra(fields, 'dob', '1988-03-15', mk);
    expect(fields[1]!.value).toBe('1988-03-15');
    fields = withExtra(fields, 'dob', null, mk);
    expect(fields).toEqual([f('Member ID', '7')]);
    expect(withExtra(fields, 'gender', '', mk)).toBe(fields);
  });
});

describe('dates', () => {
  it('reads YYYY-MM-DD and MM/DD/YYYY, and only real dates', () => {
    expect(readDate('1988-03-14')).toEqual({ y: 1988, m: 3, d: 14 });
    expect(readDate('3/14/1988')).toEqual({ y: 1988, m: 3, d: 14 });
    expect(readDate('02/29/2024')).toEqual({ y: 2024, m: 2, d: 29 });
    expect(readDate('02/29/2023')).toBeNull();
    expect(readDate('13/01/1988')).toBeNull();
    expect(readDate('March 14, 1988')).toBeNull();
  });

  it('puts the slashes in as digits are typed, and leaves typed slashes alone', () => {
    expect(maskDate('03')).toBe('03');
    expect(maskDate('031')).toBe('03/1');
    expect(maskDate('03141988')).toBe('03/14/1988');
    expect(maskDate('03/141')).toBe('03/14/1');
    expect(maskDate('3/14/1988')).toBe('3/14/1988');
    expect(maskDate('3/')).toBe('3/');
  });

  it('says what is wrong with a typed date', () => {
    expect(dateProblem('02/30/1988', true, TODAY)).toBe('February has 29 days at most.');
    expect(dateProblem('04/31/1988', true, TODAY)).toBe('April has 30 days.');
    expect(dateProblem('13/01/1988', true, TODAY)).toBe('The month goes from 01 to 12.');
    expect(dateProblem('03/14/2031', true, TODAY)).toBe("That's in the future.");
    expect(dateProblem('03/14/2031', false, TODAY)).toBeNull();
    expect(dateProblem('03/14/19', true, TODAY)).toBe('Type it as MM/DD/YYYY.');
    expect(dateProblem('', true, TODAY)).toBeNull();
  });

  it('age, and the line under a passport or license', () => {
    expect(ageOf({ y: 1988, m: 3, d: 14 }, TODAY)).toBe(38);
    expect(ageOf({ y: 1988, m: 11, d: 4 }, TODAY)).toBe(37);
    expect(docLine('United States', '2027-08-21', 6, TODAY)).toEqual({ text: 'United States · expires Aug 21, 2027', tone: '' });
    expect(docLine('United States', '2027-03-02', 6, TODAY)).toEqual({ text: 'United States · Expires in 3 months (Mar 2, 2027)', tone: 'soon' });
    expect(docLine('FL', '2026-10-01', 1, TODAY)).toEqual({ text: 'FL · Expired Oct 1, 2026', tone: 'gone' });
    expect(docLine('FL', undefined, 1, TODAY)).toEqual({ text: 'FL', tone: '' });
    expect(docLine(undefined, undefined, 1, TODAY)).toBeNull();
  });

  it("won't save a date that can't exist, but leaves dates it didn't change alone", () => {
    expect(datesToFix([f('Date of birth', '02/30/1988')], null, TODAY)).toBe('Check the date of birth. February has 29 days at most.');
    expect(datesToFix([f('Passport expiry', '08/21/20')], null, TODAY)).toBe('Check the passport expiry. Type it as MM/DD/YYYY.');
    expect(datesToFix([f('Date of birth', '03/14/2031')], null, TODAY)).toBe("Check the date of birth. That's in the future.");
    expect(datesToFix([f('Date of birth', '1988-03-14')], null, TODAY)).toBeNull();
    expect(datesToFix([f('DOB', 'March 14, 1988')], null, TODAY)).toBeNull();
    // Saved elsewhere the European way and not touched in this edit.
    expect(datesToFix([f('Birthday', '14/03/1988')], [f('Birthday', '14/03/1988')], TODAY)).toBeNull();
    expect(datesToFix([f('Birthday', '14.03.1988')], null, TODAY)).toBe('Check the date of birth. The month goes from 01 to 12.');
  });
});

describe('birth date, gender, job title and suffix on web forms', () => {
  const g = globalThis as Record<string, unknown>;
  const KEYS = ['HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement'] as const;
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

  it('knows the fields', () => {
    expect(addrPart(el('<input autocomplete="bday">'))).toBe('bday');
    expect(addrPart(el('<select autocomplete="bday-month"></select>'))).toBe('bdayMonth');
    expect(addrPart(el('<input name="dob" placeholder="MM/DD/YYYY">'))).toBe('bday');
    expect(addrPart(el('<input id="dateOfBirth" aria-label="Date of birth (MM/DD/YYYY)">'))).toBe('bday');
    expect(addrPart(el('<select name="dob_month"></select>'))).toBe('bdayMonth');
    expect(addrPart(el('<select name="birth_day"></select>'))).toBe('bdayDay');
    expect(addrPart(el('<input name="birthYear" maxlength="4">'))).toBe('bdayYear');
    expect(addrPart(el('<select name="gender"></select>'))).toBe('sex');
    expect(addrPart(el('<input name="job_title">'))).toBe('jobTitle');
    expect(addrPart(el('<input name="title">'))).toBe('title');
    expect(addrPart(el('<select name="name_suffix"></select>'))).toBe('suffix');
  });

  it('leaves where you were born, and boxes that only mention a birthday, alone', () => {
    expect(addrPart(el('<input name="place_of_birth">'))).toBeNull();
    expect(addrPart(el('<input aria-label="Country of birth">'))).toBeNull();
    expect(addrPart(el('<input name="birthCity">'))).toBeNull();
    expect(addrPart(el('<input name="birth_certificate_no">'))).toBeNull();
    expect(addrPart(el('<input name="em" aria-label="Email (for birthday offers)">'))).toBe('email');
    expect(addrPart(el('<input name="position">'))).toBeNull();
    expect(addrPart(el('<input aria-label="Domain suffix">'))).toBeNull();
  });

  it('writes the birth date in the order the box shows', () => {
    const box = (html: string) => el(html) as HTMLInputElement;
    expect(dateFor(box('<input placeholder="MM/DD/YYYY">'), 1988, 3, 14)).toBe('03/14/1988');
    expect(dateFor(box('<input placeholder="DD.MM.YYYY">'), 1988, 3, 14)).toBe('14.03.1988');
    expect(dateFor(box('<input placeholder="YYYY-MM-DD">'), 1988, 3, 14)).toBe('1988-03-14');
    expect(dateFor(box('<input placeholder="MM/DD/YY">'), 1988, 3, 14)).toBe('03/14/88');
    expect(dateFor(box('<input type="date">'), 1988, 3, 14)).toBe('1988-03-14');
    expect(dateFor(box('<input>'), 1988, 3, 14)).toBe('03/14/1988');
  });

  it('spells the gender the way menus do', () => {
    expect(genderWants('Male')).toEqual(['Male', 'M', 'Man']);
    expect(genderWants('Prefer not to say')).toContain('Decline to answer');
  });
});
