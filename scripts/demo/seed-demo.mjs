// SPDX-License-Identifier: GPL-3.0-only
// Seed a demo account on a throwaway test server for the README, social-preview and Web Store images.
// Usage: npx tsx scripts/demo/seed-demo.mjs [--version 1.37.4]
//
// What it does (test servers only, ports 8301+, never the real vault):
//  - registers alex.morgan@example.com (a throwaway account; the password is generated into _testserver/demo-creds.json)
//  - adds about 40 logins for well-known sites plus two notes, all with made-up usernames and passwords
//  - drops the fictional Northwind icon into the server's icon cache and warms the real favicons, so the
//    popup shows real site icons. The server's icon download must be on: put {"disable_icon_download": false}
//    in _testserver/<version>/data/config.json (the admin config wins over start.ps1's env) and restart it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from '../../src/core/api.ts';
import { webCrypto as C } from '../../src/core/crypto/index.ts';
import { ROOT, serverUrl } from '../testserver/env.ts';
import { buildCipher, loginAccount, register } from '../testserver/seed.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_CREDS = path.join(ROOT, '_testserver', 'demo-creds.json');
const KDF = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };

/** The fictional sign-in page the shots are taken on (see demo-site.mjs). */
export const NORTHWIND_HOST = 'northwind.io';

export function demoCreds() {
  if (fs.existsSync(DEMO_CREDS)) return JSON.parse(fs.readFileSync(DEMO_CREDS, 'utf8'));
  const pw = Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString('base64url');
  const c = { note: 'Throwaway demo account on local test servers only.', email: 'alex.morgan@example.com', password: 'demo-' + pw, pin: '246810' };
  fs.mkdirSync(path.dirname(DEMO_CREDS), { recursive: true });
  fs.writeFileSync(DEMO_CREDS, JSON.stringify(c, null, 2));
  return c;
}

// [name, host (https), username, totp secret or null, favorite]
const LOGINS = [
  ['Northwind', NORTHWIND_HOST, 'alex.morgan@example.com', 'KRSXG5CTMVRXEZLUKN2XGZLSOBQXE2DF', true],
  ['Northwind Admin', NORTHWIND_HOST, 'a.morgan.admin@example.com', null, false],
  ['GitHub', 'github.com', 'alexmorgan-dev', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', true],
  ['Google', 'accounts.google.com', 'alex.morgan.demo@example.com', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', true],
  ['Amazon', 'amazon.com', 'alex.morgan@example.com', null, false],
  ['Netflix', 'netflix.com', 'alex.morgan@example.com', null, false],
  ['Spotify', 'spotify.com', 'alexm', null, false],
  ['Dropbox', 'dropbox.com', 'alex.morgan@example.com', 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U', false],
  ['Slack', 'slack.com', 'alex.morgan@example.com', null, false],
  ['Figma', 'figma.com', 'alex.morgan@example.com', null, false],
  ['Notion', 'notion.so', 'alex.morgan@example.com', null, false],
  ['Cloudflare', 'dash.cloudflare.com', 'alex.morgan@example.com', 'NBSWY3DPEB3W64TMMQQQ2NZSGAYDAMBQ', true],
  ['PayPal', 'paypal.com', 'alex.morgan@example.com', null, false],
  ['Reddit', 'reddit.com', 'alex_morgan_42', null, false],
  ['Apple ID', 'appleid.apple.com', 'alex.morgan@example.com', null, false],
  ['Microsoft', 'login.live.com', 'alex.morgan@example.com', null, false],
  ['LinkedIn', 'linkedin.com', 'alex.morgan@example.com', null, false],
  ['X', 'x.com', 'alexmorgan', null, false],
  ['Discord', 'discord.com', 'alex.morgan@example.com', null, false],
  ['Twitch', 'twitch.tv', 'alexmorgan_tv', null, false],
  ['Zoom', 'zoom.us', 'alex.morgan@example.com', null, false],
  ['Airbnb', 'airbnb.com', 'alex.morgan@example.com', null, false],
  ['Uber', 'uber.com', 'alex.morgan@example.com', null, false],
  ['eBay', 'ebay.com', 'alexmorgan_88', null, false],
  ['Etsy', 'etsy.com', 'alex.morgan@example.com', null, false],
  ['Stripe', 'dashboard.stripe.com', 'alex.morgan@example.com', 'ORUGS4ZANFZSAYJAORSXG5BAMNXW2IDF', false],
  ['Vercel', 'vercel.com', 'alexmorgan-dev', null, false],
  ['npm', 'npmjs.com', 'alexmorgan-dev', 'MZXW6YTBOI4TQ2LKNNSWE43FOJZGK4TF', false],
  ['Atlassian', 'id.atlassian.com', 'alex.morgan@example.com', null, false],
  ['Trello', 'trello.com', 'alex.morgan@example.com', null, false],
  ['Asana', 'app.asana.com', 'alex.morgan@example.com', null, false],
  ['Adobe', 'adobe.com', 'alex.morgan@example.com', null, false],
  ['Canva', 'canva.com', 'alex.morgan@example.com', null, false],
  ['Shopify', 'shopify.com', 'alex.morgan@example.com', null, false],
  ['DigitalOcean', 'cloud.digitalocean.com', 'alex.morgan@example.com', 'KNSXS43FNZSXIZLTONQXGIDFNRSXE4DB', false],
  ['Medium', 'medium.com', 'alex.morgan@example.com', null, false],
  ['Wikipedia', 'wikipedia.org', 'AlexMorgan', null, false],
  ['Steam', 'store.steampowered.com', 'alexmorgan_plays', null, false],
  ['Wise', 'wise.com', 'alex.morgan@example.com', null, false],
  ['Hulu', 'hulu.com', 'alex.morgan@example.com', null, false],
];

const NOTES = [
  ['Home Wi-Fi', 'Network: Morgan-5G\nRouter admin: 192.168.1.1\nGuest network password changes on the first of each month.'],
  ['Server room checklist', '1. Check the UPS battery\n2. Rotate the backup drive\n3. Update the router firmware\n4. Test the restore from last month'],
];

const pwgen = (() => {
  // Deterministic and obviously fake: only used for the demo vault.
  let s = 7;
  const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';
  return () => Array.from({ length: 20 }, () => chars[Math.floor(next() * chars.length)]).join('');
})();

function items() {
  const out = LOGINS.map(([name, host, username, totp, favorite]) => ({
    type: 1, name, notes: null, favorite, reprompt: 0,
    login: { username, password: pwgen(), totp, uris: [{ uri: `https://${host}/${host === NORTHWIND_HOST ? 'login' : ''}`.replace(/\/$/, ''), match: null }] },
  }));
  for (const [name, notes] of NOTES) out.push({ type: 2, name, notes, favorite: false, reprompt: 0, secureNote: { type: 0 } });
  return out;
}

async function main() {
  const version = process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : '1.37.4';
  const server = serverUrl(version);
  const dataDir = path.join(ROOT, '_testserver', version, 'data');
  const a = demoCreds();
  const reg = await register(new Api(server), a.email, a.password, KDF);
  const { api, userKey } = await loginAccount(server, { ...a, kdf: KDF });
  const sync = await api.sync();
  const list = items();
  if (sync.ciphers.length >= list.length) console.log(`already seeded (${sync.ciphers.length} items; register HTTP ${reg})`);
  else {
    const ciphers = [];
    for (const it of list) ciphers.push(await buildCipher(it, userKey, { encryptedFor: sync.profile.id }));
    await api.req('POST', '/api/ciphers/import', { json: { ciphers, folders: [], folderRelationships: [] } });
    console.log(`seeded ${list.length} items`);
  }

  // The fictional brand has no favicon on the internet: hand the server's icon cache its icon.
  const cache = path.join(dataDir, 'icon_cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync(path.join(here, 'northwind-icon.png'), path.join(cache, `${NORTHWIND_HOST}.png`));
  fs.rmSync(path.join(cache, `${NORTHWIND_HOST}.png.miss`), { force: true });

  // Warm the real favicons (the server downloads each on first request) and report which ones are missing.
  const fallback = Buffer.from(await (await fetch(`${server}/icons/invalid.invalid/icon.png`)).arrayBuffer());
  let missing = 0;
  await Promise.all(
    [...new Set(LOGINS.map((l) => l[1]))].map(async (host) => {
      const r = await fetch(`${server}/icons/${host}/icon.png`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
      const buf = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (!buf || buf.equals(fallback)) {
        missing++;
        console.log(`  no favicon for ${host}`);
      }
    }),
  );
  console.log(`icons: ${new Set(LOGINS.map((l) => l[1])).size - missing} real, ${missing} missing`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
