// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { findCode, patches, read } from '../../src/entrypoints/popup/scanqr';

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

describe('finding the QR code in a screenshot', () => {
  // A real setup page's layout (Cloudflare's, cut down to what matters, with a made-up code). Decoding the whole
  // shot misses the code: the bug this guards against.
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'qr-setup-page.png')));
  const page = { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  const want = 'otpauth://totp/Cloudflare:alex.morgan%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Clou';
  const qrBox = { x: 258, y: 22, w: 220, h: 220 };

  it('whole-shot decoding misses it on this page', () => {
    expect(jsQR(page.data, page.width, page.height, { inversionAttempts: 'attemptBoth' })).toBeNull();
  });
  it('reads it where the page drew a square, ignoring the squares that are icons', () => {
    expect(findCode(jsQR, page, [{ x: 70, y: 360, w: 40, h: 40 }, qrBox])).toBe(want);
  });
  it('reads it from the screenshot alone (a code the page gives no element for)', () => {
    expect(patches(page)).toContainEqual(expect.objectContaining({ x: expect.closeTo(270, -1.5), y: expect.closeTo(40, -1.5) }));
    expect(findCode(jsQR, page, [])).toBe(want);
  });
  it('reads a small code at twice the device pixels, and finds nothing on a blank page', () => {
    const m = QRCode.create('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', { errorCorrectionLevel: 'M' }).modules;
    const k = 2;
    const W = 900, H = 600, d = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let j = 0; j < m.size * 2 * k; j++)
      for (let i = 0; i < m.size * 2 * k; i++)
        if (m.data[((j / (2 * k)) | 0) * m.size + ((i / (2 * k)) | 0)]) d.fill(0, ((300 + j) * W + 500 + i) * 4, ((300 + j) * W + 500 + i) * 4 + 3);
    const img = { data: d, width: W, height: H };
    expect(findCode(jsQR, img, [{ x: 500, y: 300, w: m.size * 2 * k, h: m.size * 2 * k }], k)).toBe('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP');
    expect(findCode(jsQR, { data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H }, [], k)).toBe('');
  });
});
