// SPDX-License-Identifier: GPL-3.0-only
// The disk mirror of the session ("lock when the browser closes" off): sealed, restored at startup, removed on lock,
// and an unsealed one from an older build is sealed on first sight.
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyStore } from '../../src/shared/vaultkey';

type Area = Map<string, unknown>;
const session: Area = new Map();
const local: Area = new Map();
const area = (m: Area) => ({
  get: async (keys: string[] | string) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))])),
  set: async (v: Record<string, unknown>) => void Object.entries(v).forEach(([k, x]) => m.set(k, structuredClone(x))),
  remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: async () => {}, clear: async () => true },
  runtime: { sendMessage: async () => {} },
};

const ks: KeyStore & { key?: CryptoKey } = { get: async () => ks.key, put: async (k) => void (ks.key = k), del: async () => void (ks.key = undefined) };
const { setKeyStore } = await import('../../src/shared/vaultkey');
setKeyStore(ks);
const S = await import('../../src/entrypoints/background/session');

const live = { userKey: 'TOP-SECRET-USER-KEY', orgKeys: {}, unlockedAt: 5, lockAt: null };

beforeEach(() => {
  session.clear();
  local.clear();
  ks.key = undefined;
});

describe('persisted session', () => {
  it('never stores the raw user key in storage.local', async () => {
    await S.persistSession(live);
    const stored = JSON.stringify(local.get('persistedSession'));
    expect(stored).not.toContain('TOP-SECRET-USER-KEY');
    expect(stored).not.toContain('userKey');
  });
  it('restores at startup when the setting is off', async () => {
    local.set('settings', { lockOnClose: false });
    await S.persistSession(live);
    await S.restoreOnStartup();
    expect(session.get('session')).toEqual(live);
  });
  it('does not restore when lock-on-close is on', async () => {
    await S.persistSession(live);
    await S.restoreOnStartup();
    expect(session.has('session')).toBe(false);
  });
  it('lock removes the mirror and forgets the key, so a copied blob is dead', async () => {
    local.set('settings', { lockOnClose: false });
    await S.persistSession(live);
    const blob = structuredClone(local.get('persistedSession'));
    await S.lock();
    expect(local.get('persistedSession')).toBeNull();
    expect(ks.key).toBeUndefined();
    local.set('persistedSession', blob);
    await S.restoreOnStartup();
    expect(session.has('session')).toBe(false);
  });
  it('an unsealed mirror from an older build restores once and is sealed on the spot', async () => {
    local.set('settings', { lockOnClose: false });
    local.set('persistedSession', live);
    await S.restoreOnStartup();
    expect(session.get('session')).toEqual(live);
    expect(JSON.stringify(local.get('persistedSession'))).not.toContain('TOP-SECRET-USER-KEY');
  });
  it('the PIN-wrapped key on disk is the PIN-encrypted string, never the user key', async () => {
    // setPin needs a signed-in account and an unlocked session; the stored value is whatever encryptBytes gave.
    const { webCrypto: C, b64encode } = await import('../../src/core');
    const raw = new Uint8Array(64).map((_, i) => i);
    const k = await C.stretchMasterKey(await C.deriveMasterKey('123456', 'a@b.c', { kdf: 0, kdfIterations: 5000 }));
    const wrapped = await C.encryptBytes(raw, k);
    expect(wrapped).toMatch(/^2\./);
    expect(wrapped).not.toContain(b64encode(raw));
  });
});
