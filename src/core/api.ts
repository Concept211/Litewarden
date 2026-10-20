// SPDX-License-Identifier: GPL-3.0-only
// Minimal REST client for Vaultwarden (and Bitwarden-compatible) servers. Talks only to the user's server.
import { b64url, utf8 } from './bytes';
import { ApiError, ServerUnreachable, TwoFactorRequired, WrongPassword, WrongTwoFactorCode, serverMessage } from './errors';
import type { Kdf } from './crypto/types';

/** Bitwarden DeviceType for a Chrome extension. */
export const DEVICE_TYPE_CHROME_EXT = 2;
/** Oldest Vaultwarden release this build is tested against (see the version matrix in scripts/testserver). */
export const MIN_VAULTWARDEN = '1.35.0';

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  [k: string]: unknown;
}

export interface Prelogin extends Kdf {
  /** Which endpoint answered (feature detection, for diagnostics). */
  endpoint: string;
}

export interface ServerInfo {
  /** "Vaultwarden", "Bitwarden", or whatever the server reports. */
  name: string;
  /** Bitwarden API compatibility version from /api/config (e.g. "2026.6.0"). */
  apiVersion: string | null;
  /** Vaultwarden release (e.g. "1.37.4") from /api/version, when the server is Vaultwarden. */
  version: string | null;
  isVaultwarden: boolean;
  /** True when this is Vaultwarden older than MIN_VAULTWARDEN. */
  tooOld: boolean;
}

/** "vault.home.arpa" -> "https://vault.home.arpa"; strips trailing slashes and a pasted "/#/..." web-vault path. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  const path = u.pathname.replace(/\/#.*$/, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** Compare dotted versions numerically: -1, 0 or 1. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Read a prelogin body in any of the shapes servers send (flat, nested kdfSettings, PascalCase). */
export function parsePrelogin(d: Record<string, unknown>): Kdf {
  const pick = (...ks: string[]) => {
    for (const k of ks) if (d[k] != null) return d[k] as number;
    return undefined;
  };
  const ks = (d.kdfSettings ?? d.KdfSettings ?? {}) as Record<string, number | null | undefined>;
  const kdf = pick('kdf', 'Kdf') ?? ks.kdfType ?? ks.KdfType ?? 0;
  const kdfIterations = pick('kdfIterations', 'KdfIterations') ?? ks.iterations ?? ks.Iterations;
  if (kdfIterations == null) throw new ApiError(200, d, 'Reading the key settings');
  return {
    kdf,
    kdfIterations,
    kdfMemory: pick('kdfMemory', 'KdfMemory') ?? ks.memory ?? ks.Memory ?? null,
    kdfParallelism: pick('kdfParallelism', 'KdfParallelism') ?? ks.parallelism ?? ks.Parallelism ?? null,
  };
}

/**
 * Where each service lives. A self-hosted server serves everything under one base URL; Bitwarden's cloud splits
 * them across hosts. Litewarden's code uses self-hosted style paths ("/api/...", "/identity/...") everywhere and
 * `resolve()` maps them, so nothing else needs to know which kind of server it is.
 */
export interface ServerUrls {
  base: string;
  api: string;
  identity: string;
  icons: string;
  notifications: string;
  webVault: string;
  cloud: 'US' | 'EU' | null;
}

const CLOUD = {
  US: { api: 'https://api.bitwarden.com', identity: 'https://identity.bitwarden.com', icons: 'https://icons.bitwarden.net', notifications: 'https://notifications.bitwarden.com', webVault: 'https://vault.bitwarden.com' },
  EU: { api: 'https://api.bitwarden.eu', identity: 'https://identity.bitwarden.eu', icons: 'https://icons.bitwarden.eu', notifications: 'https://notifications.bitwarden.eu', webVault: 'https://vault.bitwarden.eu' },
} as const;

/** Which cloud a web-vault address belongs to ("vault.bitwarden.com" or plain "bitwarden.com"), else null. */
export function cloudRegion(base: string): 'US' | 'EU' | null {
  const h = new URL(base).hostname.toLowerCase();
  if (h === 'bitwarden.com' || h === 'vault.bitwarden.com') return 'US';
  if (h === 'bitwarden.eu' || h === 'vault.bitwarden.eu') return 'EU';
  return null;
}

export function serverUrls(input: string): ServerUrls {
  const base = normalizeServerUrl(input);
  const cloud = cloudRegion(base);
  if (cloud) return { base: CLOUD[cloud].webVault, ...CLOUD[cloud], cloud };
  return { base, api: base + '/api', identity: base + '/identity', icons: base + '/icons', notifications: base + '/notifications', webVault: base, cloud: null };
}

/** Map a self-hosted style path to its full URL on this server. */
export function resolveUrl(u: ServerUrls, path: string): string {
  for (const [prefix, root] of [
    ['/api', u.api],
    ['/identity', u.identity],
    ['/icons', u.icons],
    ['/notifications', u.notifications],
  ] as const) {
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) return root + path.slice(prefix.length);
  }
  return u.base + path;
}

/** The notifications hub WebSocket URL (ws:// for http servers). */
export function hubUrl(u: ServerUrls, accessToken: string): string {
  return resolveUrl(u, '/notifications/hub').replace(/^http/i, 'ws') + '?access_token=' + encodeURIComponent(accessToken);
}

const PRELOGIN_PATHS = ['/identity/accounts/prelogin/password', '/identity/accounts/prelogin', '/api/accounts/prelogin'];

export interface ApiOptions {
  deviceId?: string;
  clientVersion?: string;
  tokens?: Tokens | null;
  /** Called whenever tokens change (login, refresh) so the caller can persist them. */
  onTokens?: (t: Tokens | null) => void;
  fetch?: typeof fetch;
}

export class Api {
  readonly base: string;
  readonly urls: ServerUrls;
  readonly deviceId: string;
  readonly clientVersion: string;
  tokens: Tokens | null;
  private readonly onTokens: ((t: Tokens | null) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(base: string, opts: ApiOptions = {}) {
    this.urls = serverUrls(base);
    this.base = this.urls.base;
    this.deviceId = opts.deviceId ?? globalThis.crypto.randomUUID();
    this.clientVersion = opts.clientVersion ?? '2026.9.0';
    this.tokens = opts.tokens ?? null;
    this.onTokens = opts.onTokens;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private setTokens(t: Tokens | null) {
    this.tokens = t;
    this.onTokens?.(t);
  }

  async raw(
    method: string,
    path: string,
    { json, form, auth = true, headers = {} }: { json?: unknown; form?: Record<string, string>; auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown }> {
    const h: Record<string, string> = {
      'Bitwarden-Client-Name': 'browser',
      'Bitwarden-Client-Version': this.clientVersion,
      'Device-Type': String(DEVICE_TYPE_CHROME_EXT),
      ...headers,
    };
    if (auth && this.tokens) h.Authorization = 'Bearer ' + this.tokens.access_token;
    let body: string | undefined;
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
    }
    if (form) {
      body = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    }
    let res: Response;
    try {
      res = await this.fetchImpl(resolveUrl(this.urls, path), { method, headers: h, body, credentials: 'omit', cache: 'no-store' });
    } catch (err) {
      throw new ServerUnreachable(this.base, err);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  /** Request with one automatic token refresh on 401. */
  async req<T = unknown>(method: string, path: string, opts: Parameters<Api['raw']>[2] = {}): Promise<T> {
    let r = await this.raw(method, path, opts);
    if (r.status === 401 && this.tokens?.refresh_token) {
      await this.refresh();
      r = await this.raw(method, path, opts);
    }
    if (r.status >= 400) throw new ApiError(r.status, r.data, `${method} ${path}`);
    return r.data as T;
  }

  /** Feature detection: newest prelogin endpoint first, legacy last (Vaultwarden 1.37.4 removed /api/accounts/prelogin). */
  async prelogin(email: string): Promise<Prelogin> {
    const tried: string[] = [];
    for (const p of PRELOGIN_PATHS) {
      const r = await this.raw('POST', p, { json: { email }, auth: false });
      if (r.status === 200 && r.data && typeof r.data === 'object') {
        return { ...parsePrelogin(r.data as Record<string, unknown>), endpoint: p };
      }
      // Rate limited (Vaultwarden 1.37.4 limits unauthenticated endpoints): stop, don't misreport it as missing.
      if (r.status === 429) throw new ApiError(429, 'Too many requests. Wait a minute, then try again.', 'Reading the key settings (prelogin)');
      tried.push(`${p} ${r.status}`);
    }
    throw new ApiError(404, tried.join(', '), 'Reading the key settings (prelogin)');
  }

  async serverInfo(): Promise<ServerInfo> {
    const cfg = await this.raw('GET', '/api/config', { auth: false });
    if (cfg.status !== 200 || !cfg.data || typeof cfg.data !== 'object') {
      throw new ApiError(cfg.status, cfg.data, 'Checking the server (/api/config)');
    }
    const c = cfg.data as { version?: string; server?: { name?: string } | null };
    const name = c.server?.name ?? 'Bitwarden';
    const isVaultwarden = /vaultwarden/i.test(name);
    let version: string | null = null;
    if (isVaultwarden) {
      const v = await this.raw('GET', '/api/version', { auth: false });
      if (v.status === 200 && typeof v.data === 'string' && /^\d+\.\d+/.test(v.data)) version = v.data;
    }
    return {
      name,
      apiVersion: c.version ?? null,
      version,
      isVaultwarden,
      tooOld: isVaultwarden && version != null && compareVersions(version, MIN_VAULTWARDEN) < 0,
    };
  }

  /** Password grant. Throws TwoFactorRequired, WrongPassword or ApiError. */
  async loginPassword(email: string, masterPasswordHash: string, twoFactor?: { provider: number; token: string; remember?: boolean }) {
    const form: Record<string, string> = {
      grant_type: 'password',
      username: email,
      password: masterPasswordHash,
      scope: 'api offline_access',
      client_id: 'browser',
      deviceType: String(DEVICE_TYPE_CHROME_EXT),
      deviceName: 'chrome',
      deviceIdentifier: this.deviceId,
    };
    if (twoFactor) {
      form.twoFactorToken = twoFactor.token;
      form.twoFactorProvider = String(twoFactor.provider);
      form.twoFactorRemember = twoFactor.remember ? '1' : '0';
    }
    const r = await this.raw('POST', '/identity/connect/token', { form, auth: false, headers: { 'Auth-Email': b64url(utf8(email)) } });
    if (r.status === 200) {
      this.setTokens(r.data as Tokens);
      return r.data as LoginResponse;
    }
    const body = (r.data ?? {}) as Record<string, unknown>;
    if (twoFactor && r.status === 400) throw new WrongTwoFactorCode();
    const providers = (body.TwoFactorProviders ?? body.twoFactorProviders) as Array<number | string> | undefined;
    if (r.status === 400 && Array.isArray(providers) && providers.length) throw new TwoFactorRequired(providers.map(Number));
    if (r.status === 400 && /password|credential|invalid_grant/i.test(serverMessage(body) + String(body.error ?? ''))) {
      throw new WrongPassword();
    }
    throw new ApiError(r.status, body, 'Login');
  }

  async refresh(): Promise<void> {
    const rt = this.tokens?.refresh_token;
    if (!rt) throw new ApiError(401, null, 'Refreshing the session');
    const r = await this.raw('POST', '/identity/connect/token', {
      auth: false,
      form: { grant_type: 'refresh_token', client_id: 'browser', refresh_token: rt },
    });
    if (r.status !== 200) {
      this.setTokens(null);
      throw new ApiError(r.status, r.data, 'Refreshing the session');
    }
    this.setTokens({ ...this.tokens, ...(r.data as Tokens) });
  }

  sync(): Promise<SyncResponse> {
    return this.req<SyncResponse>('GET', '/api/sync?excludeDomains=true');
  }

  createCipher(body: Record<string, unknown>): Promise<Cipher> {
    return this.req<Cipher>('POST', '/api/ciphers', { json: body });
  }

  updateCipher(id: string, body: Record<string, unknown>): Promise<Cipher> {
    return this.req<Cipher>('PUT', `/api/ciphers/${encodeURIComponent(id)}`, { json: body });
  }

  /** Move to the trash (soft delete); restorable from the web vault. */
  async trashCipher(id: string): Promise<void> {
    await this.req('PUT', `/api/ciphers/${encodeURIComponent(id)}/delete`);
  }

  /** Seconds until the access token expires (from its JWT exp), or 0 if unknown/expired. */
  tokenSecondsLeft(now = Date.now()): number {
    const t = this.tokens?.access_token;
    if (!t) return 0;
    try {
      const payload = JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
      return payload.exp ? Math.max(0, Math.floor(payload.exp - now / 1000)) : 0;
    } catch {
      return 0;
    }
  }

  /** A fresh access token (refreshing first if it expires within a minute), e.g. for the notifications hub. */
  async freshAccessToken(): Promise<string> {
    if (this.tokenSecondsLeft() < 60) await this.refresh();
    if (!this.tokens?.access_token) throw new ApiError(401, null, 'Getting a session token');
    return this.tokens.access_token;
  }
}

// ---------- server payload shapes (only the fields Litewarden reads) ----------

export interface LoginResponse extends Tokens {
  Key?: string;
  PrivateKey?: string;
  Kdf?: number;
  KdfIterations?: number;
  KdfMemory?: number | null;
  KdfParallelism?: number | null;
  AccountKeys?: AccountKeys | null;
  UserDecryptionOptions?: unknown;
}

export interface AccountKeys {
  publicKeyEncryptionKeyPair?: { wrappedPrivateKey?: string; publicKey?: string } | null;
  signatureKeyPair?: unknown;
  securityState?: unknown;
}

export interface CipherUri {
  uri: string | null;
  match: number | null;
}

export interface Cipher {
  id: string;
  type: number;
  organizationId: string | null;
  folderId: string | null;
  key?: string | null;
  name: string;
  notes: string | null;
  favorite?: boolean;
  reprompt?: number;
  revisionDate?: string;
  creationDate?: string;
  deletedDate?: string | null;
  login?: { username: string | null; password: string | null; totp: string | null; uris: CipherUri[] | null; [k: string]: unknown } | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  fields?: Array<{ name: string | null; value: string | null; type: number }> | null;
  /** Everything else the server sends (password history, passkeys, attachments...), passed through on edit. */
  [k: string]: unknown;
}

export interface SyncResponse {
  profile: {
    id: string;
    email: string;
    key: string;
    privateKey: string | null;
    accountKeys?: AccountKeys | null;
    organizations: Array<{ id: string; name: string; key: string | null }>;
  };
  folders: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; organizationId: string; name: string }>;
  ciphers: Cipher[];
}
