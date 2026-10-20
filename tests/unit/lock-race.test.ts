// SPDX-License-Identifier: GPL-3.0-only
// Lock always wins: a read-modify-write that started before lock() must not put the session back.
// Regression for a CI failure (1.36.0): the popup's start-up "touch" read the session, awaited the settings, and
// wrote the session back after the user had clicked Lock.
import { beforeEach, describe, expect, it } from 'vitest';

type Area = Map<string, unknown>;
const session: Area = new Map();
const local: Area = new Map();
let gate: Promise<void> | null = null;

function area(m: Area, gated = false) {
  return {
    get: async (keys: string[] | string) => {
      const ks = Array.isArray(keys) ? keys : [keys];
      // The settings read is where touch() waits; hold it open to force the interleaving.
      if (gated && gate && ks.includes('settings')) await gate;
      return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
    },
    set: async (v: Record<string, unknown>) => void Object.entries(v).forEach(([k, x]) => m.set(k, structuredClone(x))),
    remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
  };
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { session: area(session), local: area(local, true) },
  alarms: { create: async () => {}, clear: async () => true },
  runtime: { sendMessage: async () => {} },
};

const S = await import('../../src/entrypoints/background/session');

beforeEach(() => {
  session.clear();
  local.clear();
  gate = null;
  session.set('session', { userKey: 'k', orgKeys: {}, unlockedAt: 1, lockAt: null });
  session.set('index', [{ id: 'a' }]);
});

describe('lock wins over writes already in flight', () => {
  it('touch() that read the session before lock() does not write it back', async () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const t = S.touch();
    await new Promise((r) => setTimeout(r, 10)); // touch has read the session and now waits on the settings
    await S.lock();
    expect(session.has('session')).toBe(false);
    open();
    await t;
    expect(session.has('session'), 'session written back after lock').toBe(false);
    expect(session.has('index')).toBe(false);
  });

  it('writeIfUnlocked refuses a write captured before lock() and allows one after a new unlock epoch', async () => {
    const before = S.epoch();
    await S.lock();
    expect(await S.writeIfUnlocked(before, { index: [] })).toBe(false);
    expect(session.has('index')).toBe(false);
    const now = S.epoch();
    expect(await S.writeIfUnlocked(now, { index: [] })).toBe(true);
  });

  it('touch() with no lock in between still extends the session', async () => {
    local.set('settings', { lockMinutes: 15 });
    await S.touch();
    const s = session.get('session') as { lockAt: number | null };
    expect(s.lockAt).toBeGreaterThan(Date.now());
  });
});
