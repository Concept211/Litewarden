// SPDX-License-Identifier: GPL-3.0-only
// What lands in chrome.storage.local for "lock when the browser closes: off" is sealed under a key that is not in
// storage.local, so reading storage alone is useless.
import { describe, expect, it } from 'vitest';
import { dropKey, seal, unseal, type KeyStore } from '../../src/shared/vaultkey';
import type { Session } from '../../src/shared/store';

function memStore(): KeyStore & { key?: CryptoKey } {
  const s: KeyStore & { key?: CryptoKey } = {
    get: async () => s.key,
    put: async (k) => void (s.key = k),
    del: async () => void (s.key = undefined),
  };
  return s;
}
const session: Session = { userKey: 'c2VjcmV0LXVzZXIta2V5', orgKeys: { org1: 'b3JnLWtleQ==' }, unlockedAt: 1, lockAt: null };

describe('sealed session', () => {
  it('round trips', async () => {
    const ks = memStore();
    expect(await unseal(await seal(session, ks), ks)).toEqual(session);
  });
  it('the sealed form holds no key material in the clear', async () => {
    const ks = memStore();
    const text = JSON.stringify(await seal(session, ks));
    expect(text).not.toContain(session.userKey);
    expect(text).not.toContain('userKey');
    expect(text).not.toContain('org1');
  });
  it('the wrapping key is not extractable', async () => {
    const ks = memStore();
    await seal(session, ks);
    expect(ks.key!.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', ks.key!)).rejects.toThrow();
  });
  it('without the key (storage.local read alone, or after a lock) it cannot be opened', async () => {
    const ks = memStore();
    const sealed = await seal(session, ks);
    expect(await unseal(sealed, memStore())).toBeNull();
    await dropKey(ks);
    expect(await unseal(sealed, ks)).toBeNull();
  });
  it('changed data is rejected', async () => {
    const ks = memStore();
    const sealed = await seal(session, ks);
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0] = ct[0]! ^ 1;
    expect(await unseal({ ...sealed, ct: ct.toString('base64') }, ks)).toBeNull();
  });
  it('two seals of the same session differ (fresh IV)', async () => {
    const ks = memStore();
    expect((await seal(session, ks)).ct).not.toBe((await seal(session, ks)).ct);
  });
  it('garbage and missing values give null, not an exception', async () => {
    expect(await unseal(null, memStore())).toBeNull();
    expect(await unseal({ v: 1, iv: '!!', ct: '!!' }, memStore())).toBeNull();
  });
});
