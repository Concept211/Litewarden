// SPDX-License-Identifier: GPL-3.0-only
// Does a saved login belong to the page? Implements the Bitwarden URI match types.
// This decides where Litewarden offers to fill, so it errs toward "no match".
import { getDomain } from 'tldts';
import type { ListUri } from './vault';

export const UriMatch = { BaseDomain: 0, Host: 1, StartsWith: 2, Exact: 3, RegularExpression: 4, Never: 5 } as const;

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

/** Registrable domain ("eTLD+1"), private suffixes included so a.github.io and b.github.io stay apart. */
export function baseDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  // IPs, localhost and single-label LAN names have no registrable domain: the whole host is the "domain".
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export function matchUri(saved: string, pageUrl: string, match: number | null, defaultMatch: number = UriMatch.BaseDomain): boolean {
  const type = match ?? defaultMatch;
  if (type === UriMatch.Never) return false;
  const page = parseLoose(pageUrl);
  switch (type) {
    case UriMatch.BaseDomain: {
      const s = parseLoose(saved);
      return !!(s && page && baseDomain(s.hostname) === baseDomain(page.hostname));
    }
    case UriMatch.Host: {
      const s = parseLoose(saved);
      return !!(s && page && s.host.toLowerCase() === page.host.toLowerCase());
    }
    case UriMatch.StartsWith:
      return pageUrl.startsWith(saved.trim());
    case UriMatch.Exact:
      return pageUrl === saved.trim();
    case UriMatch.RegularExpression:
      try {
        return new RegExp(saved, 'i').test(pageUrl);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** True when any of the item's URIs matches the page. */
export const matchesPage = (uris: ListUri[], pageUrl: string, defaultMatch: number = UriMatch.BaseDomain): boolean =>
  uris.some((u) => matchUri(u.uri, pageUrl, u.match, defaultMatch));

/** Domain to request the favicon for (from the user's own server's /icons endpoint). */
export function iconDomain(uris: ListUri[]): string | null {
  for (const u of uris) {
    const p = parseLoose(u.uri);
    if (p) return p.hostname.toLowerCase();
  }
  return null;
}
