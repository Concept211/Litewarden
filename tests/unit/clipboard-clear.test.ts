// SPDX-License-Identifier: GPL-3.0-only
// The timed clipboard clear only clears what Litewarden copied. The offscreen document is tested against a fake
// clipboard and textarea; the worker side checks it remembers and sends the hash, not the text.
import { beforeEach, describe, expect, it } from 'vitest';
import { clipHash } from '../../src/shared/cliphash';

let clipboard = '';
let canPaste = true;
const listeners: Record<string, Array<(e: unknown) => void>> = {};
const textarea = { value: '', focus() {} };
(globalThis as unknown as { document: unknown }).document = {
  getElementById: () => textarea,
  addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ??= []).push(f),
  removeEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== f)),
  execCommand: (cmd: string) => {
    if (cmd === 'paste') {
      if (!canPaste) return false;
      for (const f of listeners.paste ?? []) f({ clipboardData: { getData: () => clipboard }, preventDefault() {} });
      return true;
    }
    if (cmd === 'copy') {
      for (const f of listeners.copy ?? []) f({ clipboardData: { setData: (_t: string, v: string) => (clipboard = v) }, preventDefault() {} });
      return true;
    }
    return false;
  },
};
let onMessage!: (m: unknown, s: unknown, reply: (r: unknown) => void) => boolean | void;
(globalThis as unknown as { chrome: unknown }).chrome = { runtime: { onMessage: { addListener: (f: typeof onMessage) => (onMessage = f) } } };
await import('../../src/entrypoints/offscreen/main');

const ask = (m: Record<string, unknown>) => new Promise<{ ok: boolean; skipped?: boolean; read?: boolean }>((res) => onMessage({ target: 'offscreen', ...m }, null, res as (r: unknown) => void));

beforeEach(() => {
  clipboard = '';
  canPaste = true;
  textarea.value = '';
});

describe('offscreen clear', () => {
  it('clears when the clipboard still holds the copied value', async () => {
    clipboard = 'hunter2';
    const r = await ask({ type: 'clear', hash: await clipHash('hunter2') });
    expect(r).toMatchObject({ ok: true, read: true });
    expect(r.skipped).toBeUndefined();
    expect(clipboard).toBe('');
  });
  it('leaves a newer copy alone', async () => {
    clipboard = 'something I copied later';
    const r = await ask({ type: 'clear', hash: await clipHash('hunter2') });
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(clipboard).toBe('something I copied later');
  });
  it('an already empty clipboard is left as it is', async () => {
    expect(await ask({ type: 'clear', hash: await clipHash('hunter2') })).toMatchObject({ ok: true, skipped: true });
  });
  it('if the clipboard cannot be read, it clears anyway (a secret must not stay)', async () => {
    canPaste = false;
    clipboard = 'hunter2';
    expect(await ask({ type: 'clear', hash: await clipHash('hunter2') })).toMatchObject({ ok: true, read: false });
    expect(clipboard).toBe('');
  });
  it('with no hash on record it clears unconditionally', async () => {
    clipboard = 'anything';
    await ask({ type: 'clear' });
    expect(clipboard).toBe('');
  });
  it('does not leave the text in the textarea', async () => {
    clipboard = 'hunter2';
    await ask({ type: 'clear', hash: await clipHash('hunter2') });
    expect(textarea.value).toBe('');
  });
  it('write puts the value on the clipboard', async () => {
    expect(await ask({ type: 'write', value: '123456' })).toMatchObject({ ok: true });
    expect(clipboard).toBe('123456');
  });
});

describe('hash', () => {
  it('is SHA-256 hex and differs per value', async () => {
    expect(await clipHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await clipHash('a')).not.toBe(await clipHash('b'));
  });
});
