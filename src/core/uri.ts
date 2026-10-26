// SPDX-License-Identifier: GPL-3.0-only
// URI helpers that don't need the public suffix list, so the popup can use them without bundling it.
import type { ListUri } from './vault';

/** Parse a stored URI the way users type them: "github.com" means http(s)://github.com. Null for app URIs etc. */
export function parseLoose(uri: string): URL | null {
  const s = uri.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Where "open and fill" goes: the first web address that isn't a pattern (regex) or turned off for matching.
 * One saved without a scheme ("chase.com") opens over https. */
export function launchUrl(uris: ListUri[]): URL | null {
  for (const u of uris) {
    if (u.match === 4 || u.match === 5) continue;
    const s = u.uri.trim();
    const p = parseLoose(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
    if (p) return p;
  }
  return null;
}

/** Domain to request the favicon for (from the user's own server's /icons endpoint). */
export function iconDomain(uris: ListUri[]): string | null {
  for (const u of uris) {
    const p = parseLoose(u.uri);
    if (p) return p.hostname.toLowerCase();
  }
  return null;
}
