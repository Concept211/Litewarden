// SPDX-License-Identifier: GPL-3.0-only
// The unlocked session lives here: sign in, unlock (PIN or master password), lock, sync, and the decrypted
// list index the popup reads. Keys stay in chrome.storage.session (memory) so a killed service worker can resume.
import {
  Api,
  CipherType,
  DecryptError,
  LitewardenError,
  ServerUnreachable,
  TwoFactorRequired,
  WrongPassword,
  b64decode,
  b64encode,
  decryptItem,
  decryptListItem,
  iconDomain,
  loadKeys,
  normalizeServerUrl,
  parseLoose,
  unlockWithPassword,
  webCrypto as C,
  type Cipher,
  type FullItem,
  type Keys,
  type LoginResponse,
  type SymKey,
  type SyncResponse,
  type Tokens,
} from '../../core';
import type { Progress, StateInfo } from '../../shared/messages';
import { getSettings, local, mem, type Account, type IndexItem, type Session } from '../../shared/store';

export class UserError extends LitewardenError {
  override name = 'UserError';
}
export class LockedOut extends LitewardenError {
  override name = 'LockedOut';
}
export class WrongPin extends LitewardenError {
  override name = 'WrongPin';
}

const PW_TRIES = 5;
const PW_WAIT_MS = 60_000;
const PIN_TRIES = 5;

// ---------- small helpers ----------

let apiCache: Api | null = null;
async function api(): Promise<Api> {
  const { account, tokens } = await local.get('account', 'tokens');
  if (!account) throw new UserError('Not signed in.');
  if (!apiCache || apiCache.base !== account.server) {
    apiCache = new Api(account.server, { deviceId: account.deviceId, tokens: tokens ?? null, onTokens: (t) => void local.set({ tokens: t }) });
  } else {
    apiCache.tokens = tokens ?? apiCache.tokens;
  }
  return apiCache;
}

export function broadcast(ev: Progress): void {
  chrome.runtime.sendMessage({ event: 'progress', ...ev }).catch(() => {});
}

/** Rebuild SymKeys from the session (cheap; CryptoKeys import lazily). */
let keysCache: { at: number; keys: Keys } | null = null;
export async function sessionKeys(): Promise<Keys> {
  const { session } = await mem.get('session');
  if (!session) throw new UserError('Litewarden is locked.');
  if (keysCache?.at === session.unlockedAt) return keysCache.keys;
  const orgKeys = new Map<string, SymKey>();
  for (const [id, raw] of Object.entries(session.orgKeys)) orgKeys.set(id, C.symKey(b64decode(raw)));
  const keys: Keys = { userKey: C.symKey(b64decode(session.userKey)), privateKeys: null, orgKeys, orgKeyErrors: new Map() };
  keysCache = { at: session.unlockedAt, keys };
  return keys;
}

let vaultCache: SyncResponse | null = null;
async function vault(): Promise<SyncResponse> {
  if (vaultCache) return vaultCache;
  const { vault: v } = await local.get('vault');
  if (!v) throw new UserError('No vault on this device yet. Sync first.');
  vaultCache = v;
  return v;
}

// ---------- state ----------

export async function state(): Promise<StateInfo> {
  const [{ account }, { session, pinWrapped, lockout }, l, settings] = await Promise.all([
    local.get('account'),
    mem.get('session', 'pinWrapped', 'lockout'),
    local.get('pinWrapped'),
    getSettings(),
  ]);
  let status: StateInfo['status'] = !account ? 'new' : session ? 'unlocked' : 'locked';
  if (status === 'unlocked' && session?.lockAt && session.lockAt < Date.now()) {
    await lock();
    status = 'locked';
  }
  return {
    status,
    email: account?.email ?? null,
    server: account?.server ?? null,
    serverName: account?.serverInfo.name ?? null,
    serverVersion: account?.serverInfo.version ?? null,
    pinEnabled: !!(pinWrapped ?? l.pinWrapped),
    pwUntil: lockout && lockout.pwUntil > Date.now() ? lockout.pwUntil : 0,
    pwFails: lockout?.pwFails ?? 0,
    settings,
  };
}

// ---------- first run ----------

export async function checkServer(url: string) {
  let base: string;
  try {
    base = normalizeServerUrl(url);
  } catch {
    throw new UserError('Enter the full address, like https://vault.example.com');
  }
  const a = new Api(base);
  const info = await Promise.race([
    a.serverInfo(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new ServerUnreachable(base)), 8000)),
  ]);
  return { ...info, url: base };
}

export async function login(p: { server: string; email: string; password: string; twoFactor?: { provider: number; token: string; remember: boolean } }) {
  const server = normalizeServerUrl(p.server);
  const email = p.email.trim().toLowerCase();
  const { account: prev, twoFactorRemember, deviceId: savedId } = await local.get('account', 'twoFactorRemember', 'deviceId');
  const deviceId = savedId ?? prev?.deviceId ?? crypto.randomUUID();
  if (!savedId) await local.set({ deviceId });
  const a = new Api(server, { deviceId });
  const serverInfo = await a.serverInfo();
  if (serverInfo.tooOld) {
    throw new UserError(`This server runs Vaultwarden ${serverInfo.version}. Litewarden needs 1.35.0 or later. Update Vaultwarden, then try again.`);
  }
  const kdf = await a.prelogin(email);
  const masterKey = await C.deriveMasterKey(p.password, email, kdf);
  const hash = await C.masterPasswordHash(masterKey, p.password);
  let tf = p.twoFactor ? { provider: p.twoFactor.provider, token: p.twoFactor.token.replace(/\s/g, ''), remember: p.twoFactor.remember } : undefined;
  const remembered = twoFactorRemember?.[email];
  if (!tf && remembered) tf = { provider: 5, token: remembered, remember: false };
  let tok: LoginResponse;
  try {
    tok = await a.loginPassword(email, hash, tf);
  } catch (err) {
    if (tf?.provider === 5) {
      // The remembered-device token expired: drop it and ask for a code.
      const next = { ...twoFactorRemember };
      delete next[email];
      await local.set({ twoFactorRemember: next });
      tok = await a.loginPassword(email, hash);
    } else throw err;
  }
  const remember = (tok as Record<string, unknown>).TwoFactorToken;
  if (typeof remember === 'string' && remember) await local.set({ twoFactorRemember: { ...twoFactorRemember, [email]: remember } });

  const stretched = await C.stretchMasterKey(masterKey);
  if (!tok.Key) throw new UserError('The server did not send the account key.');
  const userKey = C.symKey(await C.decryptBytes(tok.Key, stretched));
  // A different account replaces everything from the old one.
  if (prev && (prev.email !== email || prev.server !== server)) await wipeLocalVault();
  const account: Account = {
    server,
    email,
    userId: '',
    name: null,
    kdf: { kdf: kdf.kdf, kdfIterations: kdf.kdfIterations, kdfMemory: kdf.kdfMemory ?? null, kdfParallelism: kdf.kdfParallelism ?? null },
    encUserKey: tok.Key,
    encPrivateKey: tok.PrivateKey ?? null,
    deviceId,
    serverInfo,
  };
  await local.set({ account, tokens: a.tokens as Tokens });
  apiCache = a;
  a.tokens = a.tokens ?? (tok as Tokens);
  await startSession(userKey);
  await syncNow(true);
  return { status: 'ok' as const };
}

async function wipeLocalVault() {
  vaultCache = null;
  keysCache = null;
  await local.remove('vault', 'lastSync', 'recent', 'pinWrapped', 'persistedSession', 'tokens');
  await mem.remove('session', 'index', 'indexCount', 'recentItems', 'notes', 'tabMatches', 'iconCache', 'pinWrapped', 'failures');
}

// ---------- unlock / lock ----------

async function startSession(userKey: SymKey, orgKeys: Record<string, string> = {}) {
  const settings = await getSettings();
  const now = Date.now();
  const session: Session = {
    userKey: b64encode(userKey.raw),
    orgKeys,
    unlockedAt: now,
    lockAt: settings.lockMinutes ? now + settings.lockMinutes * 60_000 : null,
  };
  await mem.set({ session, lockout: { pwFails: 0, pwUntil: 0, pinFails: 0 } });
  if (!settings.lockOnClose) await local.set({ persistedSession: session });
  await armAutoLock();
  onLockChange?.(true);
}

export async function unlockPassword(password: string) {
  const [{ account }, { lockout }] = await Promise.all([local.get('account'), mem.get('lockout')]);
  if (!account) throw new UserError('Not signed in.');
  const lo = lockout ?? { pwFails: 0, pwUntil: 0, pinFails: 0 };
  if (lo.pwUntil > Date.now()) throw new LockedOut('Too many tries. Wait a minute, then try again.', { cause: lo.pwUntil });
  let userKey: SymKey;
  try {
    ({ userKey } = await unlockWithPassword(C, password, account.email, account.kdf, account.encUserKey));
  } catch (err) {
    if (!(err instanceof DecryptError) && !(err instanceof Error && /decrypt|mac/i.test(err.message))) throw err;
    const pwFails = lo.pwFails + 1;
    const pwUntil = pwFails >= PW_TRIES ? Date.now() + PW_WAIT_MS : 0;
    await mem.set({ lockout: { ...lo, pwFails: pwUntil ? 0 : pwFails, pwUntil } });
    if (pwUntil) throw new LockedOut('Too many tries. You can try again in 1 minute.', { cause: pwUntil });
    const left = PW_TRIES - pwFails;
    const e = new WrongPassword();
    e.message = `That's not the master password for ${account.email}. Check Caps Lock and try again. ${left} ${left === 1 ? 'try' : 'tries'} left before a 1-minute wait.`;
    throw e;
  }
  await startSession(userKey);
  await rebuildFromLocal().catch(() => {});
  void syncNow(false).catch(() => {});
  return { status: 'ok' as const };
}

/** PIN -> account KDF (salted with the email) -> stretched key that wraps the user key. */
async function pinKey(pin: string, account: Account) {
  return C.stretchMasterKey(await C.deriveMasterKey(pin, account.email, account.kdf));
}

export async function setPin(pin: string | null) {
  const { account } = await local.get('account');
  if (!account) throw new UserError('Not signed in.');
  if (pin == null) {
    await mem.set({ pinWrapped: null });
    await local.set({ pinWrapped: null });
    return;
  }
  if (!/^\d{6}$/.test(pin)) throw new UserError('The PIN is 6 digits.');
  const keys = await sessionKeys();
  const wrapped = await C.encryptBytes(keys.userKey.raw, await pinKey(pin, account));
  const settings = await getSettings();
  await mem.set({ pinWrapped: wrapped });
  await local.set({ pinWrapped: settings.pinSurvivesRestart ? wrapped : null });
}

export async function unlockPin(pin: string) {
  const [{ account, pinWrapped: diskPin }, { pinWrapped: memPin, lockout }] = await Promise.all([local.get('account', 'pinWrapped'), mem.get('pinWrapped', 'lockout')]);
  const wrapped = memPin ?? diskPin;
  if (!account) throw new UserError('Not signed in.');
  if (!wrapped) throw new UserError('PIN unlock is off. Use your master password.');
  const lo = lockout ?? { pwFails: 0, pwUntil: 0, pinFails: 0 };
  let raw: Uint8Array;
  try {
    raw = await C.decryptBytes(wrapped, await pinKey(pin, account));
  } catch {
    const pinFails = lo.pinFails + 1;
    if (pinFails >= PIN_TRIES) {
      await mem.set({ pinWrapped: null, lockout: { ...lo, pinFails: 0 } });
      await local.set({ pinWrapped: null });
      throw new WrongPin('Too many wrong PINs, so PIN unlock is now off. Use your master password, then set the PIN again in Settings.', {
        cause: 'disabled',
      });
    }
    await mem.set({ lockout: { ...lo, pinFails } });
    const left = PIN_TRIES - pinFails;
    throw new WrongPin(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left, then you'll need the master password.`);
  }
  await startSession(C.symKey(raw));
  await rebuildFromLocal().catch(() => {});
  void syncNow(false).catch(() => {});
  return { status: 'ok' as const };
}

export let onLockChange: ((unlocked: boolean) => void) | null = null;
export const setLockListener = (fn: (unlocked: boolean) => void) => (onLockChange = fn);

export async function lock() {
  keysCache = null;
  await mem.remove('session', 'index', 'indexCount', 'recentItems', 'notes', 'tabMatches', 'failures');
  await local.set({ persistedSession: null });
  await chrome.alarms.clear('autolock');
  onLockChange?.(false);
}

export async function logout() {
  const a = await api().catch(() => null);
  await lock();
  await wipeLocalVault();
  await local.remove('account', 'tokens');
  apiCache = null;
  void a;
}

/** Push the auto-lock deadline out (called on every popup action). */
export async function touch() {
  const { session } = await mem.get('session');
  if (!session) return;
  const settings = await getSettings();
  session.lockAt = settings.lockMinutes ? Date.now() + settings.lockMinutes * 60_000 : null;
  await mem.set({ session });
  await armAutoLock();
}

export async function armAutoLock() {
  const { session } = await mem.get('session');
  await chrome.alarms.clear('autolock');
  if (session?.lockAt) await chrome.alarms.create('autolock', { when: session.lockAt });
}

/** Browser start: restore a session mirrored to disk (only when "lock when the browser closes" is off). */
export async function restoreOnStartup() {
  const [{ persistedSession, pinWrapped }, settings] = await Promise.all([local.get('persistedSession', 'pinWrapped'), getSettings()]);
  if (pinWrapped && settings.pinSurvivesRestart) await mem.set({ pinWrapped });
  if (persistedSession && !settings.lockOnClose) {
    await mem.set({ session: persistedSession });
    await rebuildFromLocal().catch(() => {});
    onLockChange?.(true);
  }
}

// ---------- sync + index ----------

let syncing: Promise<{ count: number; changed: number }> | null = null;

export function syncNow(report: boolean) {
  syncing ??= doSync(report).finally(() => (syncing = null));
  return syncing;
}

async function doSync(report: boolean) {
  const a = await api();
  if (report) broadcast({ phase: 'sync', done: 0, total: 0 });
  let data: SyncResponse;
  try {
    data = await a.sync();
  } catch (err) {
    await local.set({ lastSyncError: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const { vault: old } = await local.get('vault');
  const oldRev = new Map((old?.ciphers ?? []).map((c) => [c.id, c.revisionDate]));
  const changed = data.ciphers.filter((c) => oldRev.get(c.id) !== c.revisionDate).length + Math.max(0, (old?.ciphers.length ?? 0) - data.ciphers.length);
  vaultCache = data;
  const { account } = await local.get('account');
  if (account) {
    account.userId = data.profile.id;
    account.name = (data.profile as { name?: string | null }).name ?? null;
    account.encUserKey = data.profile.key || account.encUserKey;
    account.encPrivateKey = data.profile.privateKey ?? account.encPrivateKey;
  }
  await local.set({ vault: data, lastSync: Date.now(), lastSyncError: null, ...(account ? { account } : {}) });
  await buildIndex(data, report);
  return { count: data.ciphers.filter((c) => !c.deletedDate).length, changed };
}

async function rebuildFromLocal() {
  const v = await vault();
  await buildIndex(v, false);
}

/** Decrypt the list stage for every item in chunks (progress for the first-run screen), then notes for search. */
async function buildIndex(data: SyncResponse, report: boolean) {
  const { session } = await mem.get('session');
  if (!session) return;
  const base = await sessionKeys();
  const keys = await loadKeys(C, data, base.userKey);
  // Persist org keys into the session so a woken worker doesn't redo RSA.
  const orgKeys: Record<string, string> = {};
  for (const [id, k] of keys.orgKeys) orgKeys[id] = b64encode(k.raw);
  session.orgKeys = orgKeys;
  await mem.set({ session });
  keysCache = { at: session.unlockedAt, keys };

  const live = data.ciphers.filter((c) => !c.deletedDate);
  const items: IndexItem[] = [];
  const failures: Array<{ id: string; message: string }> = [];
  const CHUNK = 250;
  for (let i = 0; i < live.length; i += CHUNK) {
    const part = live.slice(i, i + CHUNK);
    await Promise.all(
      part.map(async (c) => {
        try {
          const li = await decryptListItem(C, c, keys);
          items.push({ ...li, domain: li.type === CipherType.Login ? iconDomain(li.uris) : null, hosts: hostsOf(li.uris) });
        } catch (err) {
          failures.push({ id: c.id, message: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    if (report) broadcast({ phase: 'decrypt', done: Math.min(live.length, i + CHUNK), total: live.length });
  }
  items.sort((x, y) => x.name.localeCompare(y.name));
  await mem.set({ index: items, indexCount: items.length, failures, tabMatches: {} });
  await refreshRecentItems(items);
  if (report) broadcast({ phase: 'done', done: items.length, total: live.length });
  onIndexChange?.();
  void buildNotes(live, keys);
}

async function buildNotes(live: Cipher[], keys: Keys) {
  const notes: Record<string, string> = {};
  await Promise.all(
    live
      .filter((c) => c.notes)
      .map(async (c) => {
        try {
          const it = await decryptItemNotes(c, keys);
          if (it) notes[c.id] = it;
        } catch {
          // already reported by the list stage if the key is bad
        }
      }),
  );
  if ((await mem.get('session')).session) await mem.set({ notes });
}

async function decryptItemNotes(c: Cipher, keys: Keys) {
  const base = c.organizationId ? keys.orgKeys.get(c.organizationId) : keys.userKey;
  if (!base || !c.notes) return null;
  const k = c.key ? C.symKey(await C.decryptBytes(c.key, base)) : base;
  return C.decryptString(c.notes, k);
}

export let onIndexChange: (() => void) | null = null;
export const setIndexListener = (fn: () => void) => (onIndexChange = fn);

function hostsOf(uris: Array<{ uri: string }>): string[] {
  const out: string[] = [];
  for (const u of uris) {
    const p = parseLoose(u.uri);
    const h = p ? p.hostname : u.uri;
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// ---------- items ----------

export async function fullItem(id: string): Promise<FullItem> {
  const [keys, v] = await Promise.all([sessionKeys(), vault()]);
  const c = v.ciphers.find((x) => x.id === id);
  if (!c) throw new UserError('That item is no longer in the vault. Sync and try again.');
  return decryptItem(C, c, keys);
}

export async function recordUse(id: string) {
  const { recent } = await local.get('recent');
  await local.set({ recent: [id, ...(recent ?? []).filter((x) => x !== id)].slice(0, 20) });
  await refreshRecentItems();
}

/** Keep the few most recently used items in the session, so the popup's first paint never reads the full index. */
async function refreshRecentItems(index?: IndexItem[]) {
  const [{ recent }, m] = await Promise.all([local.get('recent'), index ? Promise.resolve({ index }) : mem.get('index')]);
  if (!m.index) return;
  const byId = new Map(m.index.map((i) => [i.id, i]));
  await mem.set({ recentItems: (recent ?? []).map((id) => byId.get(id)).filter((x): x is IndexItem => !!x).slice(0, 8) });
}

export { TwoFactorRequired };
