// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { read } from '../../src/entrypoints/popup/scanqr';

describe('reading a scanned 2FA QR code', () => {
  it('takes a TOTP setup link and names it from the issuer and account', () => {
    const uri = 'otpauth://totp/GitHub:alex%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
    expect(read(uri)).toEqual({ ok: true, uri, label: 'GitHub, alex@example.com' });
    expect(read('otpauth://totp/alex?secret=ABC')).toEqual({ ok: true, uri: 'otpauth://totp/alex?secret=ABC', label: 'alex' });
    expect(read('otpauth://totp/Acme:bo?secret=ABC&issuer=Acme')).toMatchObject({ label: 'Acme, bo' });
  });
  it('turns away everything else with a reason', () => {
    expect(read('')).toMatchObject({ ok: false, message: expect.stringContaining('No QR code') });
    expect(read('otpauth-migration://offline?data=abc')).toMatchObject({ ok: false, message: expect.stringContaining('Google Authenticator export') });
    expect(read('otpauth://hotp/x?secret=ABC&counter=1')).toMatchObject({ ok: false, message: expect.stringContaining('HOTP') });
    expect(read('otpauth://totp/x?issuer=X')).toMatchObject({ ok: false, message: expect.stringContaining('no key') });
    expect(read('https://example.com')).toMatchObject({ ok: false, message: expect.stringContaining("isn't a 2FA") });
  });
});
