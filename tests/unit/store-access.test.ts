// SPDX-License-Identifier: GPL-3.0-only
// Content scripts must not read our storage, and the code must never open it up.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const calls: Array<[string, unknown]> = [];
const area = (name: string) => ({ setAccessLevel: async (o: unknown) => void calls.push([name, o]) });
(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: area('local'), session: area('session'), sync: area('sync') } };
const { fenceStorage } = await import('../../src/shared/store');

describe('storage access level', () => {
  it('fences local, session and sync to trusted contexts', async () => {
    await fenceStorage();
    expect(calls.map((c) => c[0]).sort()).toEqual(['local', 'session', 'sync']);
    for (const [, o] of calls) expect(o).toEqual({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
  it('survives a browser without setAccessLevel', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {}, session: {} } };
    await expect(fenceStorage()).resolves.toBeUndefined();
  });
  it('no source file ever sets UNTRUSTED_AND_TRUSTED_CONTEXTS', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const bad = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && fs.readFileSync(f, 'utf8').includes('UNTRUSTED_AND_TRUSTED_CONTEXTS'));
    expect(bad).toEqual([]);
  });
  it('content scripts never touch chrome.storage', () => {
    for (const f of ['src/entrypoints/lw.content.ts', 'src/entrypoints/fill.content.ts']) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/chrome\.storage|browser\.storage/);
  });
});
