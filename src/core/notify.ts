// SPDX-License-Identifier: GPL-3.0-only
// The notifications hub speaks SignalR over a WebSocket with the MessagePack protocol (Vaultwarden only offers
// that one). This is the small subset Litewarden needs: the handshake, length-prefixed frames, a MessagePack
// reader, the ping message, and the push types that mean "the vault changed".

export const HANDSHAKE = '{"protocol":"messagepack","version":1}\u001e';

/** Bitwarden push types (PushType). */
export const PushType = {
  SyncCipherUpdate: 0,
  SyncCipherCreate: 1,
  SyncLoginDelete: 2,
  SyncFolderDelete: 3,
  SyncCiphers: 4,
  SyncVault: 5,
  SyncOrgKeys: 6,
  SyncFolderCreate: 7,
  SyncFolderUpdate: 8,
  SyncCipherDelete: 9,
  SyncSettings: 10,
  LogOut: 11,
} as const;

/** Pushes that change what's in the vault (Litewarden answers them with a sync). */
export const VAULT_PUSHES = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

export type MsgValue = null | boolean | number | string | Uint8Array | MsgValue[] | { [k: string]: MsgValue } | { ext: number; data: Uint8Array };

/** Decode one MessagePack value. Throws on truncated input. */
export function unpack(b: Uint8Array): MsgValue {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n: number) => {
    if (i + n > b.length) throw new Error('MessagePack: truncated');
  };
  const u8 = () => (need(1), b[i++]!);
  const u16 = () => (need(2), (i += 2), dv.getUint16(i - 2));
  const u32 = () => (need(4), (i += 4), dv.getUint32(i - 4));
  const bytes = (n: number) => (need(n), b.subarray((i += n) - n, i));
  const str = (n: number) => new TextDecoder().decode(bytes(n));
  const arr = (n: number): MsgValue[] => Array.from({ length: n }, () => read());
  const map = (n: number) => {
    const o: Record<string, MsgValue> = {};
    for (let k = 0; k < n; k++) o[String(read())] = read();
    return o;
  };
  const read = (): MsgValue => {
    const t = u8();
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x80) return map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bytes(u8());
      case 0xc5: return bytes(u16());
      case 0xc6: return bytes(u32());
      case 0xc7: { const n = u8(); const ext = (u8() << 24) >> 24; return { ext, data: bytes(n) }; }
      case 0xc8: { const n = u16(); const ext = (u8() << 24) >> 24; return { ext, data: bytes(n) }; }
      case 0xc9: { const n = u32(); const ext = (u8() << 24) >> 24; return { ext, data: bytes(n) }; }
      case 0xca: need(4); i += 4; return dv.getFloat32(i - 4);
      case 0xcb: need(8); i += 8; return dv.getFloat64(i - 8);
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: need(8); i += 8; return Number(dv.getBigUint64(i - 8));
      case 0xd0: need(1); i += 1; return dv.getInt8(i - 1);
      case 0xd1: need(2); i += 2; return dv.getInt16(i - 2);
      case 0xd2: need(4); i += 4; return dv.getInt32(i - 4);
      case 0xd3: need(8); i += 8; return Number(dv.getBigInt64(i - 8));
      case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: {
        const ext = (u8() << 24) >> 24;
        return { ext, data: bytes(1 << (t - 0xd4)) };
      }
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16());
      case 0xdd: return arr(u32());
      case 0xde: return map(u16());
      case 0xdf: return map(u32());
      default: throw new Error(`MessagePack: unknown type 0x${t.toString(16)}`);
    }
  };
  return read();
}

/**
 * The handshake answer is JSON ending in 0x1e ("{}" on success, {"error":...} otherwise). Vaultwarden sends it as a
 * binary frame, other servers as text; both are accepted. Returns null when `data` isn't a handshake answer.
 */
export function handshakeReply(data: Uint8Array | string): { ok: boolean; error: string | null } | null {
  const text = typeof data === 'string' ? data : data[0] === 0x7b && data[data.length - 1] === 0x1e ? new TextDecoder().decode(data) : null;
  if (text == null || !text.startsWith('{')) return null;
  try {
    const o = JSON.parse(text.replace(/+$/, '')) as { error?: string };
    return { ok: !o.error, error: o.error ?? null };
  } catch {
    return null;
  }
}

/** Split a binary SignalR payload into its length-prefixed (VarInt) messages. */
export function splitFrames(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < b.length) {
    let len = 0;
    let shift = 0;
    for (;;) {
      if (i >= b.length) throw new Error('SignalR: truncated length');
      const x = b[i++]!;
      len |= (x & 0x7f) << shift;
      if (!(x & 0x80)) break;
      shift += 7;
      if (shift > 28) throw new Error('SignalR: bad length');
    }
    if (i + len > b.length) throw new Error('SignalR: truncated frame');
    out.push(b.subarray(i, i + len));
    i += len;
  }
  return out;
}

/** The SignalR ping, MessagePack [6], framed. Sent every 20 s so the hub (and Chrome) keep the socket alive. */
export const PING = Uint8Array.of(0x02, 0x91, 0x06);

export interface Push {
  type: number;
  /** The device that caused it (so a client can skip its own changes). */
  contextId: string | null;
  payload: MsgValue;
}

/**
 * Pull vault pushes out of one binary WebSocket message. SignalR invocation: [1, headers, invocationId, target,
 * arguments]; Bitwarden sends target "ReceiveMessage" with one argument {ContextId, Type, Payload}.
 */
export function parsePushes(data: Uint8Array): Push[] {
  const out: Push[] = [];
  if (handshakeReply(data)) return out;
  for (const f of splitFrames(data)) {
    const m = unpack(f);
    if (!Array.isArray(m) || m[0] !== 1 || m[3] !== 'ReceiveMessage') continue;
    const arg = (m[4] as MsgValue[] | undefined)?.[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg) || arg instanceof Uint8Array || 'ext' in arg) continue;
    const o = arg as Record<string, MsgValue>;
    const type = o.Type ?? o.type;
    if (typeof type !== 'number') continue;
    const ctx = o.ContextId ?? o.contextId;
    out.push({ type, contextId: typeof ctx === 'string' ? ctx : null, payload: o.Payload ?? o.payload ?? null });
  }
  return out;
}
