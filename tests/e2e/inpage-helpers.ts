// SPDX-License-Identifier: GPL-3.0-only
// Helpers for the in-page surfaces. Litewarden draws in a closed shadow root (so pages can't reach it), which
// Playwright selectors can't enter either; the test reaches it through CDP (DOM.getDocument with pierce) and finds
// our framed pages through page.frames().
import type { Frame, Page } from '@playwright/test';
import { webCrypto as C } from '../../src/core/crypto';
import { decryptItem } from '../../src/core/vault';
import { serverUrl } from '../../scripts/testserver/env';
import { buildCipher, loginAccount } from '../../scripts/testserver/seed';
import { e2eCreds } from './accounts';
import { VERSION } from './helpers';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

interface CdpNode {
  nodeId: number;
  localName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

const attr = (n: CdpNode, k: string) => {
  const a = n.attributes ?? [];
  const i = a.indexOf(k);
  return i >= 0 ? a[i + 1] : undefined;
};

/** The Litewarden field icons drawn in the top document (closed shadow root), with their boxes. */
export async function icons(p: Page, frame?: Frame): Promise<Array<Box & { locked: boolean }>> {
  // A frame from another site runs in a process of its own (OOPIF): its icons are reached through its own session,
  // and their boxes are in its viewport, so they're moved by where the frame sits on the page.
  const off = frame ? await (await frame.frameElement()).evaluate((n) => {
    const el = n as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.left + el.clientLeft, y: r.top + el.clientTop };
  }) : { x: 0, y: 0 };
  const cdp = await p.context().newCDPSession(frame ?? p);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    const found: CdpNode[] = [];
    const walk = (n: CdpNode, inside: boolean) => {
      const here = inside || n.localName === 'litewarden-ui';
      if (here && n.localName === 'button' && (attr(n, 'class') ?? '').split(' ').includes('ic')) found.push(n);
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c, here);
    };
    walk(root, false);
    const out: Array<Box & { locked: boolean }> = [];
    for (const n of found) {
      if (/display:\s*none/.test(attr(n, 'style') ?? '')) continue;
      try {
        const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId })) as { model: { border: number[] } };
        const q = model.border;
        out.push({ x: q[0]! + off.x, y: q[1]! + off.y, w: q[2]! - q[0]!, h: q[5]! - q[1]!, locked: (attr(n, 'class') ?? '').includes('locked') });
      } catch {
        // hidden
      }
    }
    return out.sort((a, b) => a.y - b.y);
  } finally {
    await cdp.detach();
  }
}

/** Click the icon inside `selector`'s field. */
export async function clickIcon(p: Page, selector: string) {
  const f = (await p.locator(selector).boundingBox())!;
  const ic = (await icons(p)).find((b) => b.y >= f.y - 2 && b.y + b.h <= f.y + f.height + 2 && b.x >= f.x && b.x + b.w <= f.x + f.width + 1);
  if (!ic) throw new Error(`no Litewarden icon in ${selector}`);
  await p.mouse.click(ic.x + ic.w / 2, ic.y + ic.h / 2);
  return ic;
}

/** One of our framed pages (menu.html, prompt.html, teach.html, twofa.html) once it has loaded and been placed. */
export async function surface(p: Page, page: 'menu' | 'prompt' | 'teach' | 'twofa', timeout = 8000): Promise<Frame> {
  const end = Date.now() + timeout;
  for (;;) {
    const f = p.frames().find((x) => isPage(x.url(), page));
    if (f) {
      const box = await (await f.frameElement()).boundingBox().catch(() => null);
      if (box && box.x > -100) return f;
    }
    if (Date.now() > end) throw new Error(`${page}.html never appeared`);
    await p.waitForTimeout(100);
  }
}

export const gone = async (p: Page, page: 'menu' | 'prompt' | 'teach' | 'twofa') => !p.frames().some((x) => isPage(x.url(), page));
function isPage(url: string, page: string) {
  return /^chrome-extension:/.test(url) && url.split(/[?#]/)[0]!.endsWith(`/${page}.html`);
}

export async function frameBox(f: Frame): Promise<Box> {
  const b = (await (await f.frameElement()).boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** Everything a surface must not cover, as the page sees it. */
export async function protectedBoxes(p: Page, scope = 'form, .dlg, #root, main'): Promise<Box[]> {
  return p.evaluate((sc) => {
    const host = document.querySelector(sc) ?? document.body;
    const els = [...host.querySelectorAll('input:not([type=hidden]), select, textarea, button, label')].filter((e) => !(e instanceof HTMLLabelElement) || e.querySelector('input[type=checkbox]'));
    return els
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, label: `${e.localName}#${e.id || (e as HTMLInputElement).type || ''}` };
      })
      .filter((b) => b.w > 1 && b.h > 1);
  }, scope);
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;

/** Decrypted logins on the test server for a host, straight from the API (the truth, not the extension's copy). */
export async function serverLogins(host: string): Promise<Array<{ id: string; name: string; username: string | null; password: string | null; totp: string | null; notes: string | null; deleted: boolean }>> {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const sync = await api.sync();
  const out = [];
  for (const x of sync.ciphers) {
    if (x.type !== 1) continue;
    const it = await decryptItem(C, x, { userKey, privateKeys: null, orgKeys: new Map(), orgKeyErrors: new Map() }).catch(() => null);
    if (!it?.login || !it.login.uris.some((u) => u.uri.includes(host))) continue;
    out.push({ id: x.id, name: it.name, username: it.login.username, password: it.login.password, totp: it.login.totp, notes: it.notes, deleted: !!x.deletedDate });
  }
  return out;
}

/** The content script's own timing (__lwCost in its isolated world, which the page can't see). */
export async function contentCost(p: Page): Promise<{ init: number; scan: number; idle: number } | null> {
  const cdp = await p.context().newCDPSession(p);
  try {
    const ctxs: Array<{ id: number; name: string; auxData?: { type?: string; frameId?: string; isDefault?: boolean } }> = [];
    cdp.on('Runtime.executionContextCreated', (e: { context: (typeof ctxs)[number] }) => void ctxs.push(e.context));
    await cdp.send('Runtime.enable');
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const iso = ctxs.find((c) => c.auxData?.type === 'isolated' && c.auxData.frameId === frameTree.frame.id && /litewarden/i.test(c.name));
    if (!iso) return null;
    const r = (await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__lwCost ?? null)', contextId: iso.id, returnByValue: true })) as { result: { value: string } };
    return JSON.parse(r.result.value);
  } finally {
    await cdp.detach();
  }
}

/** Tab id of a page, from the service worker. */
export async function tabIdOf(sw: () => Promise<import('@playwright/test').Worker>, p: Page): Promise<number> {
  const url = p.url();
  return (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).sort((a, b) => b.id! - a.id!)[0]!.id!, url);
}

/**
 * keyboard.press with a deadline. A press that never completes (the browser never acknowledged the key) used to
 * show up as a bare 2-minute test timeout; this fails fast and says where the focus and our frames were.
 */
export async function pressOrExplain(p: Page, key: string, ms = 15_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<'stalled'>((r) => (timer = setTimeout(() => r('stalled'), ms)));
  const done = await Promise.race([p.keyboard.press(key).then(() => 'ok' as const), stalled]);
  clearTimeout(timer);
  if (done === 'ok') return;
  const frames = p.frames().map((f) => f.url().replace(/^chrome-extension:\/\/[^/]+/, 'ext:').split('#')[0]);
  const active = await p.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}`).catch((e) => `unknown (${e})`);
  throw new Error(`${key} press never finished after ${ms} ms. Page focus: ${active}. Frames: ${frames.join(', ')}`);
}

/** Create logins straight on the test server (as another device would). */
export async function createLogins(items: Array<{ name: string; username: string; password: string; uri: string; totp?: string }>) {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const userId = (await api.sync()).profile.id;
  for (const it of items) {
    const body = await buildCipher({ type: 1, name: it.name, login: { username: it.username, password: it.password, totp: it.totp ?? null, uris: [{ uri: it.uri, match: null }] } } as never, userKey, { encryptedFor: userId });
    await api.createCipher(body as Record<string, unknown>);
  }
}

/**
 * Two folders on the main e2e account, with corpus logins in them: "E2E Crypto" holds Alice, "E2E Rental" holds
 * Carol; Bob and the generated items stay in no folder. Safe to run again (finds the folders by name).
 */
export async function ensureFolders(): Promise<{ crypto: string; rental: string }> {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const sync = await api.sync();
  const byName = new Map<string, string>();
  for (const f of sync.folders ?? []) byName.set((await C.decryptString(f.name, userKey).catch(() => null)) ?? '', f.id);
  const folder = async (name: string) => byName.get(name) ?? (await api.req<{ id: string }>('POST', '/api/folders', { json: { name: await C.encryptString(name, userKey) } })).id;
  const crypto = await folder('E2E Crypto');
  const rental = await folder('E2E Rental');
  const ids: Record<string, string> = {};
  for (const x of sync.ciphers) {
    if (x.deletedDate) continue;
    const name = await C.decryptString(x.name, userKey).catch(() => '');
    if (name === 'Corpus · Alice' || name === 'Frames · Carol') ids[name] = x.id;
  }
  await api.req('PUT', '/api/ciphers/move', { json: { ids: [ids['Corpus · Alice']], folderId: crypto } });
  await api.req('PUT', '/api/ciphers/move', { json: { ids: [ids['Frames · Carol']], folderId: rental } });
  return { crypto, rental };
}

/** Every live item on the test server whose name starts with `prefix`, decrypted (any type). */
export async function serverItems(prefix: string) {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const sync = await api.sync();
  const out = [];
  for (const x of sync.ciphers) {
    if (x.deletedDate) continue;
    const it = await decryptItem(C, x, { userKey, privateKeys: null, orgKeys: new Map(), orgKeyErrors: new Map() }).catch(() => null);
    if (it?.name.startsWith(prefix)) out.push(it);
  }
  return out;
}

/** Create items of any type straight on the test server (as another device would), optionally in a folder. */
export async function createItems(items: Array<{ type: number; name: string; folderId?: string; card?: Record<string, string>; identity?: Record<string, string>; notes?: string; login?: { username: string; password: string; totp: null; uris: Array<{ uri: string; match: number | null }> } }>) {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const userId = (await api.sync()).profile.id;
  for (const it of items) {
    const body = (await buildCipher({ notes: null, ...it } as never, userKey, { encryptedFor: userId })) as Record<string, unknown>;
    if (it.folderId) body.folderId = it.folderId;
    await api.createCipher(body);
  }
}

/** A folder on the main e2e account by name (made if missing), for tests that shouldn't touch the shared ones. */
export async function ensureFolder(name: string): Promise<string> {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const sync = await api.sync();
  for (const f of sync.folders ?? []) if ((await C.decryptString(f.name, userKey).catch(() => null)) === name) return f.id;
  return (await api.req<{ id: string }>('POST', '/api/folders', { json: { name: await C.encryptString(name, userKey) } })).id;
}

/** Delete (for good) the test server's items whose names match, left over from earlier runs. */
export async function deleteItems(match: RegExp): Promise<number> {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  const sync = await api.sync();
  let n = 0;
  for (const x of sync.ciphers) {
    const name = await C.decryptString(x.name, userKey).catch(() => null);
    if (!name || !match.test(name)) continue;
    await api.req('DELETE', `/api/ciphers/${encodeURIComponent(x.id)}`);
    n++;
  }
  return n;
}

/** Delete a folder on the main e2e account by name, if it's there (its items move to "No folder"). */
export async function deleteFolder(name: string) {
  const c = e2eCreds();
  const { api, userKey } = await loginAccount(serverUrl(VERSION), { ...c.main, kdf: { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null } });
  for (const f of (await api.sync()).folders ?? []) if ((await C.decryptString(f.name, userKey).catch(() => null)) === name) await api.req('DELETE', `/api/folders/${encodeURIComponent(f.id)}`);
}
