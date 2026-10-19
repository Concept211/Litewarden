// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fold, SearchIndex } from '../../src/core/search';
import { base32decode, parseTotp, secondsRemaining, totp } from '../../src/core/totp';
import { baseDomain, iconDomain, matchesPage, matchUri, UriMatch } from '../../src/core/urlmatch';

describe('TOTP (RFC 6238 appendix B vectors, 8 digits)', () => {
  const secrets = {
    'SHA-1': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', // "12345678901234567890"
    'SHA-256': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA', // 32 bytes
    'SHA-512':
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA', // 64 bytes
  };
  const vectors: Array<[number, Record<keyof typeof secrets, string>]> = [
    [59, { 'SHA-1': '94287082', 'SHA-256': '46119246', 'SHA-512': '90693936' }],
    [1111111109, { 'SHA-1': '07081804', 'SHA-256': '68084774', 'SHA-512': '25091201' }],
    [1111111111, { 'SHA-1': '14050471', 'SHA-256': '67062674', 'SHA-512': '99943326' }],
    [1234567890, { 'SHA-1': '89005924', 'SHA-256': '91819424', 'SHA-512': '93441116' }],
    [2000000000, { 'SHA-1': '69279037', 'SHA-256': '90698825', 'SHA-512': '38618901' }],
    [20000000000, { 'SHA-1': '65353130', 'SHA-256': '77737706', 'SHA-512': '47863826' }],
  ];
  for (const [t, want] of vectors) {
    for (const alg of Object.keys(secrets) as Array<keyof typeof secrets>) {
      it(`${alg} at T=${t}`, async () => {
        const uri = `otpauth://totp/Test?secret=${secrets[alg]}&digits=8&algorithm=${alg.replace('-', '')}`;
        expect(await totp(uri, t * 1000)).toBe(want[alg]);
      });
    }
  }
  it('bare secrets default to 6 digits, 30 s, SHA-1', async () => {
    expect(await totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
    expect(parseTotp(' jbsw y3dp ')).toMatchObject({ digits: 6, period: 30, algorithm: 'SHA-1', steam: false });
  });
  it('steam:// gives 5 characters from the Steam alphabet', async () => {
    const code = await totp('steam://GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000);
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  });
  it('period and countdown', () => {
    expect(parseTotp('otpauth://totp/x?secret=AAAA&period=60').period).toBe(60);
    expect(secondsRemaining(30, 61_000)).toBe(29);
  });
  it('invalid base32 is explained', () => {
    expect(() => base32decode('abc!')).toThrow(/invalid character/);
  });
});

describe('URL matching', () => {
  const login = 'https://github.com/login';
  it('base domain: subdomains match, other sites and look-alikes do not', () => {
    expect(matchUri('github.com', login, null)).toBe(true);
    expect(matchUri('https://www.github.com', 'https://gist.github.com/', UriMatch.BaseDomain)).toBe(true);
    expect(matchUri('github.com', 'https://github.com.evil.example/login', null)).toBe(false);
    expect(matchUri('github.com', 'https://notgithub.com/', null)).toBe(false);
  });
  it('base domain respects public and private suffixes', () => {
    expect(baseDomain('a.b.co.uk')).toBe('b.co.uk');
    expect(matchUri('alice.github.io', 'https://bob.github.io/', null)).toBe(false);
    expect(matchUri('https://bank.co.uk', 'https://other.co.uk', null)).toBe(false);
  });
  it('LAN hosts and IPs compare as whole hosts', () => {
    expect(matchUri('https://proxmox.home:8006', 'https://proxmox.home:8006/#v1', null)).toBe(true);
    expect(matchUri('http://192.168.1.10', 'http://192.168.1.10:8080/', null)).toBe(true);
    expect(matchUri('http://192.168.1.10', 'http://192.168.1.11/', null)).toBe(false);
    expect(matchUri('localhost', 'http://localhost:3000/', null)).toBe(true);
  });
  it('host includes the port', () => {
    expect(matchUri('https://example.com:8443', 'https://example.com:8443/x', UriMatch.Host)).toBe(true);
    expect(matchUri('https://example.com:8443', 'https://example.com/x', UriMatch.Host)).toBe(false);
    expect(matchUri('https://example.com', 'https://www.example.com/', UriMatch.Host)).toBe(false);
  });
  it('starts with, exact, regex, never', () => {
    expect(matchUri('https://example.com/app', 'https://example.com/app/login', UriMatch.StartsWith)).toBe(true);
    expect(matchUri('https://example.com/app', 'https://example.com/other', UriMatch.StartsWith)).toBe(false);
    expect(matchUri('https://example.com/login', 'https://example.com/login', UriMatch.Exact)).toBe(true);
    expect(matchUri('https://example.com/login', 'https://example.com/login?x', UriMatch.Exact)).toBe(false);
    expect(matchUri('^https://(www\\.)?example\\.com/', 'https://www.example.com/a', UriMatch.RegularExpression)).toBe(true);
    expect(matchUri('([', 'https://x/', UriMatch.RegularExpression)).toBe(false);
    expect(matchUri('github.com', login, UriMatch.Never)).toBe(false);
  });
  it('non-web pages and app URIs never base-domain match', () => {
    expect(matchUri('androidapp://com.github.android', login, null)).toBe(false);
    expect(matchUri('github.com', 'chrome://settings', null)).toBe(false);
    expect(matchUri('github.com', 'javascript:alert(1)', null)).toBe(false);
  });
  it('matchesPage and iconDomain', () => {
    const uris = [{ uri: 'androidapp://x', match: null }, { uri: 'https://Accounts.Example.com/login', match: null }];
    expect(matchesPage(uris, 'https://example.com/')).toBe(true);
    expect(iconDomain(uris)).toBe('accounts.example.com');
  });
});

describe('search', () => {
  const docs = [
    { id: '1', name: 'GitHub', username: 'me@pablo.dev', urls: ['github.com'] },
    { id: '2', name: 'GitHub · deploy bot', username: 'c211-deploy', urls: ['github.com'] },
    { id: '3', name: 'Cloudflare', username: 'ops@concept211.com', urls: ['dash.cloudflare.com'], notes: 'API token rotated in March' },
    { id: '4', name: 'Café Müller GmbH', username: 'pablo', urls: ['cafe-mueller.de'] },
    { id: '5', name: 'Hetzner Cloud', username: 'me@pablo.dev', urls: ['hetzner.com'], favorite: true },
  ];
  const idx = new SearchIndex(docs);
  it('name prefix beats substring beats username', () => {
    const r = idx.search('cloud').map((h) => h.doc.id);
    expect(r[0]).toBe('3');
    expect(r).toContain('5');
  });
  it('every token must match, across fields', () => {
    expect(idx.search('github deploy').map((h) => h.doc.id)).toEqual(['2']);
    expect(idx.search('github nothere')).toEqual([]);
  });
  it('returns ranges for highlighting', () => {
    const [hit] = idx.search('hub');
    expect(hit!.doc.id).toBe('1');
    expect(hit!.ranges.name).toEqual([[3, 6]]);
  });
  it('matches usernames, URLs and notes', () => {
    expect(idx.search('concept211')[0]!.ranges.username).toEqual([[4, 14]]);
    expect(idx.search('dash')[0]!.ranges.url.get(0)).toEqual([[0, 4]]);
    expect(idx.search('rotated')[0]!.doc.id).toBe('3');
  });
  it('folds accents and case', () => {
    expect(fold('Café Müller').length).toBe('Café Müller'.length);
    expect(idx.search('cafe muller')[0]!.doc.id).toBe('4');
  });
  it('subsequence fallback on names', () => {
    expect(idx.search('htzn')[0]!.doc.id).toBe('5');
  });
  it('2,000 docs search in well under a frame', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), name: `Site ${i} account`, username: `user${i}@example.com`, urls: [`site${i}.example.com`] }));
    const big = new SearchIndex(many);
    const t = performance.now();
    big.search('site 19');
    expect(performance.now() - t).toBeLessThan(50);
  });
});
