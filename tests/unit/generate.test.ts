// SPDX-License-Identifier: GPL-3.0-only
// Generating a password from the page: which boxes want a new password, and the encrypted list kept until it's saved.
import { beforeEach, describe, expect, it } from 'vitest';
import { wantsNew, type PwBox } from '../../src/shared/fields';

const box = (text: string, ...auto: string[]): PwBox => ({ text, auto });
const says = (...b: PwBox[]) => wantsNew(b);

describe('which password boxes want a new password', () => {
  it('a sign-in box does not', () => {
    expect(says(box('password Password'))).toEqual([false]);
    expect(says(box('pass'))).toEqual([false]);
    expect(says(box('Passwd', 'current-password'))).toEqual([false]);
  });
  it('alone, "confirm your password" is asking for the one you have', () => {
    expect(says(box('Confirm your password'))).toEqual([false]);
    expect(says(box('Password again'))).toEqual([false]);
  });
  it('marked boxes count, and a current-password mark beats any wording', () => {
    expect(says(box('x', 'new-password'))).toEqual([true]);
    expect(says(box('New password', 'current-password'))).toEqual([false]);
  });
  it('unmarked create and confirm, the way Google words them', () => {
    expect(says(box('a1 Create password'), box('a2 Confirm password'))).toEqual([true, true]);
    expect(says(box('Passwd'), box('ConfirmPasswd'))).toEqual([true, true]);
    expect(says(box('Password'), box('Password again'))).toEqual([true, true]);
    expect(says(box('password'), box('password2'))).toEqual([true, true]);
  });
  it('old, new and confirm: the old one stays out', () => {
    expect(says(box('Current password'), box('New password'), box('Confirm new password'))).toEqual([false, true, true]);
    expect(says(box('old_pass'), box('pass1'), box('pass2'))).toEqual([false, true, true]);
    expect(says(box('oldPassword'), box('newPassword'))).toEqual([false, true]);
    expect(says(box('pwdOld'), box('pwdNew'))).toEqual([false, true]);
  });
  it('other wordings of new', () => {
    for (const t of ['Choose a password', 'Set password', 'Reset your password', 'signup_password', 'new_pwd', 'password_new']) expect(says(box(t)), t).toEqual([true]);
  });
  it('a second masked box that is not a repeat leaves the sign-in alone', () => {
    expect(says(box('password'), box('security_code'))).toEqual([false, false]);
    expect(says(box('Password'), box('Verification code'))).toEqual([false, false]);
    expect(says(box('Password'), box('Confirm PIN'))).toEqual([false, false]);
    expect(says(box('Password'), box('Memorable word'))).toEqual([false, false]);
  });
  it('words that only look like these', () => {
    expect(says(box('Threshold'))).toEqual([false]);
    expect(says(box('Password for the newsletter archive'))).toEqual([false]);
  });
});

type Area = Map<string, unknown>;
const session: Area = new Map();
const local: Area = new Map();
const area = (m: Area) => ({
  get: async (keys: string[] | string) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
  },
  set: async (v: Record<string, unknown>) => void Object.entries(v).forEach(([k, x]) => m.set(k, structuredClone(x))),
  remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: async () => {}, clear: async () => true },
  runtime: { sendMessage: async () => {} },
};
const S = await import('../../src/entrypoints/background/session');
const G = await import('../../src/entrypoints/background/generated');

const SITE = 'https://shop.example';
const list = () => (local.get('generated') ?? []) as Array<{ id: string; at: number; enc: string }>;

describe('generated passwords kept until saved', () => {
  beforeEach(() => {
    session.clear();
    local.clear();
    session.set('session', { userKey: Buffer.alloc(64, 7).toString('base64'), orgKeys: {}, unlockedAt: 1, lockAt: null });
    session.set('index', []);
  });

  it('only ciphertext reaches the disk, password and site both', async () => {
    const id = await G.keepGenerated(SITE, 'Secret-Pa55-word');
    const disk = JSON.stringify([...local.entries()]);
    expect(disk).not.toContain('Secret-Pa55-word');
    expect(disk).not.toContain('shop.example');
    expect(await G.generatedPassword(SITE, id)).toBe('Secret-Pa55-word');
  });

  it('another origin gets nothing: other host, other scheme, other port', async () => {
    const id = await G.keepGenerated(SITE, 'pw');
    for (const o of ['https://evil.example', 'http://shop.example', 'https://shop.example:8443', 'https://sub.shop.example']) {
      expect(await G.generatedPassword(o, id), o).toBeNull();
      expect(await G.missedFor(`${o}/signup`), o).toBeNull();
    }
    expect((await G.missedFor(`${SITE}/signup`))?.id).toBe(id);
  });

  it('keeps the newest 10', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await G.keepGenerated(SITE, `pw${i}`));
    expect(list().map((g) => g.id)).toEqual(ids.reverse().slice(0, 10));
  });

  it('past 30 days they go at the next unlock', async () => {
    await G.keepGenerated(SITE, 'old');
    await G.keepGenerated(SITE, 'new');
    const [a, b] = list();
    local.set('generated', [a, { ...b!, at: Date.now() - 31 * 86_400_000 }]);
    await G.pruneGenerated();
    expect(list().map((g) => g.id)).toEqual([a!.id]);
  });

  it('locked, nothing is written', async () => {
    await S.lock();
    await expect(G.keepGenerated(SITE, 'pw')).rejects.toThrow();
    expect(local.has('generated')).toBe(false);
  });

  it('a write already on its way when the user signs out does not survive it', async () => {
    local.set('account', { server: 'http://test.invalid', email: 'a@b.c', deviceId: 'd', userId: 'u', kdf: {}, encUserKey: 'k' });
    const keeping = G.keepGenerated(SITE, 'pw').catch(() => null);
    await S.logout();
    await keeping;
    expect(local.has('generated'), 'list written back after sign-out').toBe(false);
  });

  it('sign-out removes the list', async () => {
    await G.keepGenerated(SITE, 'pw');
    await S.logout();
    expect(local.has('generated')).toBe(false);
  });
});
