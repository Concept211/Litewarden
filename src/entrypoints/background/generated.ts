// SPDX-License-Identifier: GPL-3.0-only
// Passwords generated from the in-page menu, kept until they're in a login. A page can take one without Litewarden
// seeing the submit (or the user says "Not now"), and then it exists nowhere else: the account is locked until a reset.
// The last few stay on this device, encrypted with the user key like the vault. They never go to the server.
import { matchesPage, webCrypto as C } from '../../core';
import { local, mem, type GeneratedPassword } from '../../shared/store';
import * as S from './session';

const KEEP = 10;
const KEEP_MS = 30 * 86_400_000;

const fresh = (list: GeneratedPassword[] | undefined) => (list ?? []).filter((g) => Date.now() - g.at < KEEP_MS);

/** A read-change-write of the list, in line with sign-out's wipe: signed out or locked by then, nothing is written. */
async function edit(fn: (list: GeneratedPassword[]) => GeneratedPassword[]) {
  await S.oneAtATime(async () => {
    if (!(await mem.get('session')).session) throw new S.UserError('Litewarden is locked.');
    const { generated } = await local.get('generated');
    await local.set({ generated: fn(fresh(generated)).slice(0, KEEP) });
  });
}

/** Encrypted before the page gets the password. Returns its id. */
export async function keepGenerated(origin: string, password: string): Promise<string> {
  const { userKey } = await S.sessionKeys();
  const enc = await C.encryptString(JSON.stringify({ origin, password }), userKey);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  await edit((list) => [{ id, at: Date.now(), enc }, ...list]);
  return id;
}

export async function forgetGenerated(...ids: string[]) {
  await edit((list) => list.filter((g) => !ids.includes(g.id)));
}

/** Passwords made on this origin (exactly: scheme, host and port), newest first. Another origin never sees one. */
async function mine(origin: string) {
  const { generated } = await local.get('generated');
  const { userKey } = await S.sessionKeys();
  const out: Array<{ id: string; at: number; password: string }> = [];
  for (const g of fresh(generated).sort((a, b) => b.at - a.at)) {
    const open = await C.decryptString(g.enc, userKey).catch(() => null);
    const p = open ? (JSON.parse(open) as { origin: string; password: string }) : null;
    if (p?.origin === origin) out.push({ id: g.id, at: g.at, password: p.password });
  }
  return out;
}

export async function generatedPassword(origin: string, id: string): Promise<string | null> {
  return (await mine(origin)).find((g) => g.id === id)?.password ?? null;
}

/**
 * The newest password made here that no login holds yet. When the newest is in a login, it and the older tries are done
 * with. Asked only when the site has some, so a menu without any decrypts nothing.
 */
export async function missedFor(url: string): Promise<{ id: string; at: number } | null> {
  const { generated } = await local.get('generated');
  if (!fresh(generated).length) return null;
  const list = await mine(new URL(url).origin);
  if (!list.length) return null;
  const { index } = await mem.get('index');
  const logins = (index ?? []).filter((it) => it.type === 1 && it.uris.length && matchesPage(it.uris, url));
  const saved = new Set((await Promise.all(logins.map((it) => S.fullItem(it.id).catch(() => null)))).map((f) => f?.login?.password));
  const top = list[0]!;
  if (!saved.has(top.password)) return { id: top.id, at: top.at };
  await forgetGenerated(...list.map((g) => g.id));
  return null;
}

/** At unlock: past their 30 days, they go even if the site is never visited again. */
export async function pruneGenerated() {
  const { generated } = await local.get('generated');
  if (generated?.length && fresh(generated).length !== generated.length) await edit((list) => list);
}
