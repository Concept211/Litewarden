// SPDX-License-Identifier: GPL-3.0-only
// Live updates: a WebSocket to the server's notifications hub while the vault is unlocked. A change made on
// another device arrives as a push and triggers a sync within a second. A ping every 20 s keeps the socket (and,
// since Chrome 116, the service worker) alive. When the hub isn't there or drops, a timer sync is the fallback.
import { HANDSHAKE, PING, PushType, VAULT_PUSHES, handshakeReply, hubUrl, parsePushes, serverUrls } from '../../core';
import { getSettings, local, mem, type LiveState } from '../../shared/store';
import { api, applyCipherPush, syncNow } from './session';

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 5_000;
let wanted = false;

async function setState(status: LiveState['status'], detail: string | null = null, push = false) {
  const { live } = await mem.get('live');
  await mem.set({ live: { status, detail, lastPush: push ? Date.now() : (live?.lastPush ?? null) } });
}

function clearTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (retryTimer) clearTimeout(retryTimer);
  pingTimer = retryTimer = null;
}

/** Connect if live updates are on and the vault is unlocked; otherwise make sure we're disconnected. */
export async function startLive(): Promise<void> {
  const [settings, { session }, { account }] = await Promise.all([getSettings(), mem.get('session'), local.get('account')]);
  if (!settings.liveSync || !session || !account) return stopLive(settings.liveSync ? 'off' : 'off');
  wanted = true;
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  clearTimers();
  await setState('connecting');
  let url: string;
  try {
    url = hubUrl(serverUrls(account.server), await (await api()).freshAccessToken());
  } catch (err) {
    await setState('error', err instanceof Error ? err.message : String(err));
    return scheduleRetry();
  }
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let ready = false;
  sock.onopen = () => sock.send(HANDSHAKE);
  sock.onmessage = (m) => {
    const data = typeof m.data === 'string' ? m.data : new Uint8Array(m.data as ArrayBuffer);
    const hs = handshakeReply(data);
    if (hs) {
      if (!hs.ok) {
        void setState('unavailable', hs.error);
        sock.close();
        return;
      }
      ready = true;
      backoff = 5_000;
      void setState('connected');
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(PING), 20_000);
      return;
    }
    if (typeof data === 'string') return;
    let pushes;
    try {
      pushes = parsePushes(data);
    } catch {
      return; // a frame we can't read is not worth dropping the connection over
    }
    const mine = account.deviceId;
    const relevant = pushes.filter((p) => p.contextId !== mine && (VAULT_PUSHES.has(p.type) || p.type === PushType.SyncSettings));
    if (!relevant.length) return;
    void setState('connected', null, true);
    // One item changed: fetch just that item. Anything else (folders, org keys, an import) means a full sync.
    const one = relevant.length === 1 ? relevant[0]! : null;
    const itemId = one && one.payload && typeof one.payload === 'object' && !Array.isArray(one.payload) ? (one.payload as Record<string, unknown>).Id : null;
    const single = one && typeof itemId === 'string' && ([PushType.SyncCipherUpdate, PushType.SyncCipherCreate, PushType.SyncLoginDelete, PushType.SyncCipherDelete] as number[]).includes(one.type);
    if (single && !syncTimer) {
      const removed = one.type === PushType.SyncLoginDelete || one.type === PushType.SyncCipherDelete;
      void applyCipherPush(itemId as string, removed).catch(() => fullSyncSoon());
      return;
    }
    fullSyncSoon();
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    clearTimers();
    if (!wanted) return;
    // Never got past the handshake: the server has no hub (or a proxy blocks WebSockets).
    void setState(ready ? 'error' : 'unavailable', ready ? `Connection dropped (code ${ev.code}).` : `The server didn't accept a live connection (code ${ev.code}).`);
    scheduleRetry();
  };
  sock.onerror = () => {
    /* onclose follows and handles it */
  };
}

/** Several pushes in a row (an import, a bulk move) become one sync. */
function fullSyncSoon() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow(false).catch(() => {});
  }, 400);
}

function scheduleRetry() {
  if (!wanted) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void startLive(), backoff);
  backoff = Math.min(backoff * 2, 5 * 60_000);
}

export async function stopLive(status: LiveState['status'] = 'off'): Promise<void> {
  wanted = false;
  clearTimers();
  if (syncTimer) clearTimeout(syncTimer);
  const s = ws;
  ws = null;
  s?.close();
  await setState(status);
}

/** Background sync timer (also the fallback when there's no live connection). */
export async function armSyncAlarm(): Promise<void> {
  const [settings, { session }] = await Promise.all([getSettings(), mem.get('session')]);
  await chrome.alarms.clear('sync');
  if (settings.syncMinutes > 0 && session) await chrome.alarms.create('sync', { delayInMinutes: settings.syncMinutes, periodInMinutes: settings.syncMinutes });
}

export const liveConnected = () => !!ws && ws.readyState === WebSocket.OPEN;
