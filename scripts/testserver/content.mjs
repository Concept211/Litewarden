// Deterministic plaintext vault content for the throwaway test accounts (fixed RNG seed -> same items every run).
// Crypto (keys, IVs) is still random on each run; only the content is deterministic.
// SPDX-License-Identifier: GPL-3.0-only

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANDS = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'stark', 'wayne', 'wonka', 'tyrell', 'cyberdyne', 'soylent', 'vandelay',
  'pied-piper', 'dunder', 'sterling', 'oscorp', 'aperture', 'blackmesa', 'gringotts', 'monarch', 'massive-dynamic', 'nakatomi', 'ghostbusters',
  'bluth', 'prestige', 'krusty', 'duff', 'planetexpress', 'momcorp', 'pawnee', 'sabre', 'vehement', 'rekall', 'weyland', 'virtucon', 'zorg',
  'oceanic', 'dharma', 'kwik-e', 'bubba-gump', 'los-pollos', 'madrigal', 'gekko', 'bada-bing', 'spacely', 'cogswell', 'mooby', 'buy-n-large',
  'lexcorp', 'daily-planet', 'queen', 'kord', 'ollivanders', 'hogwarts', 'duckburg', 'xanadu', 'atlantis', 'valhalla', 'avalon', 'shangri-la'];
const TLDS = ['com', 'net', 'org', 'io', 'co.uk', 'de', 'app', 'dev', 'co', 'fr', 'es', 'com.au', 'ca', 'nl', 'jp'];
const FIRST = ['alex', 'sam', 'jordan', 'taylor', 'casey', 'riley', 'morgan', 'jamie', 'robin', 'drew', 'avery', 'quinn', 'blake', 'dana', 'harper', 'rowan', 'maria', 'jose', 'chen', 'priya', 'olu', 'ines', 'sven', 'yuki'];
const LAST = ['smith', 'garcia', 'nguyen', 'patel', 'kim', 'rossi', 'muller', 'silva', 'jones', 'brown', 'lee', 'wilson', 'martin', 'novak', 'ivanov', 'okafor'];
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec',
  'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'ember', 'harbor', 'meadow', 'summit', 'cobalt', 'lantern', 'quartz'];
const NOTE_LINES = ['Recovery email is the old Gmail.', 'Security question: first pet = see paper notebook.', 'Shared with the family plan.', 'Renewal due in March.',
  'Account number on the back of the card.', 'Support PIN: ask by phone only.', 'Do not rotate before the audit.', 'Two-factor via authenticator app.', 'Created during the 2021 migration.',
  'Webmail login. Mobile app uses a separate app password.', 'API keys live in the second tab.'];
const UNICODE_NAMES = ['Café Müller GmbH', '日本語のサイト', 'Почта России', '🔐 Emoji Bank', 'Señor Tacos', 'موقع عربي', 'Zürich Kantonalbank'];
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PWCHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';

export const FOLDERS = ['Banking', 'Shopping', 'Social', 'Work', 'Dev', 'Travel', 'Streaming', 'Utilities', 'Gov', 'Health', 'Gaming', 'Archive / Old'];

export const TEST_SITES = [
  // local test-page corpus URLs (M2/M3 will serve these)
  'http://localhost:4173/forms/stacked.html', 'http://localhost:4173/forms/two-step.html', 'http://localhost:4173/forms/iframe-host.html',
  'http://localhost:4173/forms/shadow-dom.html', 'http://localhost:4173/forms/spa.html', 'http://localhost:4173/forms/signup.html',
  'http://localhost:4173/forms/change-password.html', 'http://localhost:4173/forms/password-only.html',
];

const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const word = (r) => pick(r, WORDS);
const randStr = (r, n, chars) => Array.from({ length: n }, () => chars[Math.floor(r() * chars.length)]).join('');

function longName(r, len) {
  let s = '';
  while (s.length < len) s += word(r) + ' ';
  return s.trim().slice(0, len);
}

function makeLogin(r, i) {
  const brand = pick(r, BRANDS);
  const tld = pick(r, TLDS);
  const host = `${r() < 0.5 ? 'www.' : r() < 0.3 ? 'accounts.' : r() < 0.3 ? 'login.' : ''}${brand}.${tld}`;
  const first = pick(r, FIRST), last = pick(r, LAST);
  const username = r() < 0.55 ? `${first}.${last}${int(r, 1, 99)}@${r() < 0.5 ? 'example.com' : 'mail.test'}` : `${first}${last}${int(r, 1, 999)}`;
  const uris = [{ uri: `https://${host}/${r() < 0.5 ? 'login' : r() < 0.5 ? 'signin' : ''}`.replace(/\/$/, '') + (r() < 0.2 ? `?next=/${word(r)}` : ''), match: null }];
  if (r() < 0.12) uris.push({ uri: `https://${brand}.${tld}`, match: 1 }); // base domain match
  if (r() < 0.05) uris.push({ uri: `https://${brand}.${tld}:${pick(r, [8080, 8443, 3000])}/`, match: 3 }); // exact
  if (r() < 0.03) uris.push({ uri: `androidapp://com.${brand.replace(/-/g, '')}.app`, match: null });
  if (r() < 0.02) uris.push({ uri: `^https://.*${brand}.*$`, match: 4 }); // regex
  return {
    type: 1,
    name: `${brand[0].toUpperCase()}${brand.slice(1)} ${r() < 0.3 ? pick(r, ['Account', 'Portal', 'Admin', 'Billing', 'Store']) : word(r)} ${i}`,
    notes: r() < 0.4 ? Array.from({ length: int(r, 1, 4) }, () => pick(r, NOTE_LINES)).join('\n') : null,
    favorite: r() < 0.03,
    reprompt: r() < 0.02 ? 1 : 0,
    login: { username, password: randStr(r, int(r, 12, 28), PWCHARS), totp: null, uris },
    fields: r() < 0.08 ? [{ name: 'PIN', value: String(int(r, 1000, 9999)), type: 1 }, { name: 'Customer ID', value: String(int(r, 100000, 999999)), type: 0 }] : null,
  };
}

const totpSecret = (r) => randStr(r, 32, B32);

/** Build the personal vault: `count` items in total. Index is stable for a given (seed, count). */
export function genPersonalItems(seed = 1337, count = 2000) {
  const r = mulberry32(seed);
  const items = [];
  const nNotes = Math.round(count * 0.06), nCards = Math.round(count * 0.06), nIds = Math.round(count * 0.02);
  const nTotp = Math.round(count * 0.08), nLong = Math.max(10, Math.round(count * 0.0125)), nUni = 12, nTest = TEST_SITES.length;
  const nLogins = count - nNotes - nCards - nIds;
  for (let i = 0; i < nLogins; i++) items.push(makeLogin(r, i));
  // special logins overlay the first slots so they're stable
  for (let i = 0; i < nTotp; i++) {
    const it = items[i * 3];
    const secret = totpSecret(r);
    const form = i % 10;
    it.login.totp = form < 6 ? secret
      : form < 8 ? `otpauth://totp/${encodeURIComponent(it.name)}:${encodeURIComponent(it.login.username)}?secret=${secret}&issuer=${encodeURIComponent(it.name)}&digits=6&period=30`
      : form === 8 ? `otpauth://totp/${encodeURIComponent(it.name)}?secret=${secret}&algorithm=SHA256&digits=8&period=60`
      : `steam://${secret}`;
  }
  for (let i = 0; i < nLong; i++) {
    const it = items[1 + i * 7];
    it.name = longName(r, int(r, 180, 900));
    if (i % 3 === 0) it.notes = longName(r, 4000);
  }
  for (let i = 0; i < nUni; i++) {
    const it = items[2 + i * 11];
    it.name = `${pick(r, UNICODE_NAMES)} ${i}`;
    it.login.username = `usuário${i}@exemplo.com`;
  }
  for (let i = 0; i < nTest; i++) {
    const it = items[5 + i * 13];
    it.name = `Test form: ${TEST_SITES[i].split('/').pop()}`;
    it.login.uris = [{ uri: TEST_SITES[i], match: null }];
    it.login.username = 'testuser';
  }
  // a handful of same-domain duplicates (current-site list must show several)
  for (let i = 0; i < 6; i++) {
    const it = items[40 + i * 17];
    it.login.uris = [{ uri: `https://www.example.com/${i ? 'app' + i : ''}`, match: null }];
    it.name = `Example.com account ${i + 1}`;
  }
  for (let i = 0; i < nNotes; i++) {
    items.push({ type: 2, name: `Note ${word(r)} ${word(r)} ${i}`, notes: Array.from({ length: int(r, 1, 12) }, () => pick(r, NOTE_LINES)).join('\n'), favorite: r() < 0.03, reprompt: 0, secureNote: { type: 0 } });
  }
  for (let i = 0; i < nCards; i++) {
    items.push({
      type: 3, name: `${pick(r, ['Visa', 'Mastercard', 'Amex', 'Discover'])} ${pick(r, BRANDS)} ${i}`, notes: null, favorite: false, reprompt: r() < 0.3 ? 1 : 0,
      card: { cardholderName: `${pick(r, FIRST)} ${pick(r, LAST)}`.toUpperCase(), brand: pick(r, ['Visa', 'Mastercard', 'Amex', 'Discover']), number: randStr(r, 16, '0123456789'), expMonth: String(int(r, 1, 12)), expYear: String(int(r, 2027, 2033)), code: randStr(r, 3, '0123456789') },
    });
  }
  for (let i = 0; i < nIds; i++) {
    items.push({
      type: 4, name: `Identity ${pick(r, FIRST)} ${i}`, notes: null, favorite: false, reprompt: 0,
      identity: { title: 'Mx', firstName: pick(r, FIRST), lastName: pick(r, LAST), address1: `${int(r, 1, 999)} ${word(r)} St`, city: word(r), state: 'CA', postalCode: String(int(r, 10000, 99999)), country: 'US', email: `${pick(r, FIRST)}@example.com`, phone: `555-${int(r, 1000, 9999)}` },
    });
  }
  // deterministic shuffle so types are interleaved
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  // folder assignment (about 60% foldered) and per-item key flag (10%)
  items.forEach((it, i) => {
    it.folderIdx = r() < 0.6 ? Math.floor(r() * FOLDERS.length) : null;
    it.itemKey = r() < 0.1;
    it.seq = i;
  });
  return items;
}

export const ORG_COLLECTIONS = ['Shared Ops', 'Engineering'];

export function genOrgItems(seed = 4242, count = 60) {
  const r = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => {
    const it = makeLogin(r, i);
    it.name = `Org ${it.name}`;
    it.collectionIdx = i % ORG_COLLECTIONS.length;
    if (i % 5 === 0) it.login.totp = totpSecret(r);
    it.itemKey = i % 4 === 0;
    return it;
  });
}
