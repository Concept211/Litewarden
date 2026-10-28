// SPDX-License-Identifier: GPL-3.0-only
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanKey, findSetup, keyOf, otpauthIn, otpLabel } from '../../src/shared/twofa';

describe('typed 2FA keys', () => {
  it('reads keys the way setup pages show them', () => {
    expect(cleanKey('JBSW Y3DP EHPK 3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(cleanKey('  jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp ')).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(cleanKey('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(cleanKey('JBSW-Y3DP-EHPK-3PXP')).toBe('JBSWY3DPEHPK3PXP');
    // A short last group (52-character keys end in one).
    expect(cleanKey('ABCDE FGHIJ KLMNO PQRST UVW')).toBe('ABCDEFGHIJKLMNOPQRSTUVW');
    expect(cleanKey('Key: JBSW Y3DP EHPK 3PXP')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('turns away text that only looks like one', () => {
    for (const s of [
      'Set up two-step sign-in', // prose
      'Type this key instead', // mixed case
      'ORDER 12345678 90123456', // 0, 1, 8, 9 aren't base32
      'AUTHENTICATIONAPPS', // one run of letters, no digits
      '2345 6723 4567 2345', // digits only
      'JBSW Y3DP', // too short
      'ABCD EFGHIJ KLMN OPQR', // uneven groups
      'JbSw Y3dP EhPk 3pXp', // mixed case
      'A'.repeat(70),
      '',
    ])
      expect(cleanKey(s), s).toBeNull();
  });
});

describe('otpauth links', () => {
  const uri = 'otpauth://totp/Acme:alex%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme';
  it('finds the link in an attribute, text, or a QR image address', () => {
    expect(otpauthIn(uri)).toBe(uri);
    expect(otpauthIn(`Or open ${uri} on this device`)).toBe(uri);
    expect(otpauthIn(`https://chart.example.com/qr?size=200&chl=${encodeURIComponent(uri)}&x=1`)).toBe(uri);
    expect(otpauthIn('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1')).toBeNull();
    expect(otpauthIn('otpauth://totp/x?issuer=X')).toBeNull();
    expect(otpauthIn('nothing here')).toBeNull();
  });
  it('compares keys however they are written', () => {
    expect(keyOf(uri)).toBe('JBSWY3DPEHPK3PXP');
    expect(keyOf('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP');
    expect(keyOf('otpauth://totp/x?secret=jbsw%20y3dp%20ehpk%203pxp')).toBe('JBSWY3DPEHPK3PXP');
  });
  it('names the issuer and the account', () => {
    expect(otpLabel(uri)).toEqual({ issuer: 'Acme', account: 'alex@example.com' });
    expect(otpLabel('otpauth://totp/Beta:bo?secret=A')).toEqual({ issuer: 'Beta', account: 'bo' });
    expect(otpLabel('otpauth://totp/bo?secret=A')).toEqual({ issuer: null, account: 'bo' });
    expect(otpLabel('JBSWY3DPEHPK3PXP')).toEqual({ issuer: null, account: null });
  });
});

describe('spotting a setup page', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, NodeFilter: g.NodeFilter, innerWidth: g.innerWidth, innerHeight: g.innerHeight };
  afterEach(() => Object.assign(g, saved));
  const page = (body: string) => {
    const { document, NodeFilter } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
    Object.assign(g, { document, NodeFilter, innerWidth: 1280, innerHeight: 800 });
    return document as unknown as Document;
  };

  it('finds a typed key on a setup page, even split over spans', () => {
    const doc = page(`<h1>Set up two-step sign-in</h1><p>Scan this code with your authenticator app.</p>
      <p>Can't scan it? Type this key instead</p><div class="key"><span>NKUT</span> <span>D4NP</span> <span>EE6O</span> <span>K237</span></div>
      <script>var x = "ABCD EFGH IJKL MNOP"</script>`);
    expect(findSetup(doc)).toMatchObject({ uri: null, key: 'NKUTD4NPEE6OK237' });
  });

  it('finds an otpauth link', () => {
    const doc = page(`<p>Two-factor authentication</p><a href="otpauth://totp/Acme:bo?secret=JBSWY3DPEHPK3PXP&amp;issuer=Acme">Open in your app</a>`);
    expect(findSetup(doc)?.uri).toBe('otpauth://totp/Acme:bo?secret=JBSWY3DPEHPK3PXP&issuer=Acme');
  });

  it('ignores pages that never talk about 2FA, and keys in scripts', () => {
    expect(findSetup(page(`<p>Your license: JBSW Y3DP EHPK 3PXP</p>`))).toBeNull();
    expect(findSetup(page(`<p>Turn on two-factor authentication</p><script>k="JBSW Y3DP EHPK 3PXP"</script>`))).toMatchObject({ uri: null, key: null });
  });
});
