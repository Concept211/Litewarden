// SPDX-License-Identifier: GPL-3.0-only
// The clipboard clear compares a SHA-256 of what Litewarden copied with a SHA-256 of what is on the clipboard 30
// seconds later, so it can skip the clear when you copied something newer. The hash is all we keep; the copied
// text itself is not stored anywhere on our side.
export async function clipHash(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
