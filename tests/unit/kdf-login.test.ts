// SPDX-License-Identifier: GPL-3.0-only
// Login against a server that reports PBKDF2 under Bitwarden's floor: refused before the password is used, and no
// request carries the password or its hash.
import { describe, expect, it } from 'vitest';

type Area = Map<string, unknown>;
const local: Area = new Map();
const session: Area = new Map();
const area = (m: Area) => ({
  get: async (keys: string[] | string) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))])),
  set: async (v: Record<string, unknown>) => void Object.entries(v).forEach(([k, x]) => m.set(k, structuredClone(x))),
  remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
});
(globalThis as unknown as { chrome: unknown }).chrome = { storage: { session: area(session), local: area(local) }, alarms: { create: async () => {}, clear: async () => true }, runtime: { sendMessage: async () => {} } };

const seen: Array<{ url: string; body: string }> = [];
let iterations = 1000;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  seen.push({ url: u, body: String(init?.body ?? '') });
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/config')) return json({ version: '2026.6.0', server: { name: 'Vaultwarden' } });
  if (u.endsWith('/api/version')) return json('1.37.4');
  if (u.includes('prelogin')) return json({ kdf: 0, kdfIterations: iterations });
  return new Response('{}', { status: 400 });
}) as typeof fetch;

const S = await import('../../src/entrypoints/background/session');

describe('login with a weak server KDF', () => {
  it('refuses PBKDF2 under 5,000 with a clear error and sends no password or hash', async () => {
    const err = await S.login({ server: 'http://stub.test', email: 'a@b.c', password: 'correct horse battery' }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('WeakKdf');
    expect((err as Error).message).toContain('1,000 rounds');
    expect((err as Error).message).not.toMatch(/—/);
    expect(seen.some((r) => r.url.includes('/connect/token'))).toBe(false);
    expect(seen.map((r) => r.body).join('')).not.toContain('correct horse');
    expect(local.has('account')).toBe(false);
  });
  it('stops at 4,999 and does not stop at 5,000 (it goes on to ask for the token)', async () => {
    seen.length = 0;
    iterations = 4999;
    expect(await S.login({ server: 'http://stub.test', email: 'a@b.c', password: 'x' }).catch((e) => (e as Error).name)).toBe('WeakKdf');
    expect(seen.some((r) => r.url.includes('/connect/token'))).toBe(false);
    iterations = 5000;
    await S.login({ server: 'http://stub.test', email: 'a@b.c', password: 'x' }).catch(() => {});
    expect(seen.some((r) => r.url.includes('/connect/token'))).toBe(true);
  });
});
