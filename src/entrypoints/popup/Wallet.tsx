// SPDX-License-Identifier: GPL-3.0-only
// Crypto wallets (mockup "wallet", view A): the address card, the private key and seed phrase, and the wallet form.
// Also the master password box that items with Bitwarden's re-prompt show before their secrets.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, Eye, EyeOff, LockKeyhole, Sparkles, Timer } from 'lucide-preact';
import type { FieldDraft } from '../../core/edit';
import { addressProblem, guessNetwork, networkById, NETWORKS, normalizeSeed, OTHER_COLORS, seedWords, WALLET_FIELDS, walletOf, type Wallet, type WalletPart } from '../../core/wallet';
import { RemoteError, send } from '../../shared/messages';
import { Busy, Coin } from '../../ui/bits';
import { CopyBtn, EyeBtn, Kv, type CopyFn } from './ItemForms';

const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;

// ---------- master password re-prompt ----------

/**
 * The box a re-prompt item shows in place of its secrets. `closed`: a Show button first (wallets, whose address
 * is useful without it); otherwise the password box is ready to type in.
 */
export function RepromptBox({ id, title, text, closed, onDone }: { id: string; title: string; text: string; closed?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(!closed);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  async function go() {
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await send('confirmItem', { id, password: pw });
      setPw('');
      onDone();
    } catch (e) {
      setErr((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class={`lockbox${err ? ' field err' : ''}`} role="group" aria-label="Master password">
      <div class="h">
        <LockKeyhole />
        {open ? 'Type your master password' : title}
      </div>
      {!open ? (
        <>
          <p>{text}</p>
          <button type="button" class="btn sec" onClick={() => setOpen(true)}>
            <Eye />
            Show
          </button>
        </>
      ) : (
        <>
          {closed ? null : <p>{text}</p>}
          <span class="inp">
            <input
              id="f-reprompt"
              type="password"
              aria-label="Master password"
              autocomplete="off"
              ref={input}
              value={pw}
              onInput={(e) => setPw(val(e))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void go();
                }
              }}
            />
          </span>
          {err && <span class="f-msg">{err}</span>}
          <div class="acts">
            <Busy busy={busy} label="Checking" class="btn" type="button" onClick={() => void go()}>
              Show
            </Busy>
            {closed && (
              <button type="button" class="btn ghost" onClick={() => (setOpen(false), setErr(null), setPw(''))}>
                Cancel
              </button>
            )}
          </div>
          <p>It's checked on this computer. Nothing is sent to the server.</p>
        </>
      )}
    </div>
  );
}

// ---------- view ----------

/** The network's card: logo, name and the full address with the first and last characters in bold. */
export function AddressCard({ wallet, copy }: { wallet: Pick<Wallet, 'network' | 'address'>; copy: CopyFn }) {
  const net = networkById(wallet.network);
  const [a, b] = net?.colors ?? OTHER_COLORS;
  const s = wallet.address ?? '';
  return (
    <div class="addr-card" style={{ background: `linear-gradient(135deg, ${a}, ${b} 75%)` }}>
      <div class="t">
        <Coin network={wallet.network} />
        {net?.name ?? (wallet.network || 'Wallet')}
      </div>
      {s && (
        <button type="button" class="ib" aria-label="Copy address" title="Copy address" onClick={() => copy(s, 'Address', false)}>
          <Copy />
        </button>
      )}
      <small>Public address</small>
      {s.length > 14 ? (
        <div class="a">
          <b>{s.slice(0, 6)}</b>
          {s.slice(6, -4)}
          <b>{s.slice(-4)}</b>
        </div>
      ) : (
        <div class={`a${s ? '' : ' none'}`}>{s || 'None saved'}</div>
      )}
    </div>
  );
}

const HIDE_AFTER = 60;

/** The private key row and the seed phrase grid. Shown words hide again after a minute. */
export function WalletSecrets({ wallet, copy }: { wallet: Wallet; copy: CopyFn }) {
  const [showKey, setShowKey] = useState(false);
  const [left, setLeft] = useState(0);
  const words = seedWords(wallet.seed);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  useEffect(() => {
    if (!showKey) return;
    const t = setTimeout(() => setShowKey(false), HIDE_AFTER * 1000);
    return () => clearTimeout(t);
  }, [showKey]);
  const shown = left > 0;
  return (
    <>
      {wallet.at.privateKey !== undefined && (
        <div class="group" style={{ marginTop: '10px' }}>
          <Kv
            label="Private key"
            actions={
              wallet.privateKey && (
                <>
                  <EyeBtn on={showKey} what="private key" onClick={() => setShowKey(!showKey)} />
                  <CopyBtn what="Private key" onClick={() => copy(wallet.privateKey, 'Private key', true)} />
                </>
              )
            }
          >
            <div class="mono pw">{wallet.privateKey ? (showKey ? wallet.privateKey : '•'.repeat(16)) : <span class="muted">None</span>}</div>
          </Kv>
        </div>
      )}
      {wallet.at.seed !== undefined && (
        <>
          <div class="g-title">Seed phrase{words.length ? ` · ${words.length} words` : ''}</div>
          <div class="group">
            {words.length ? (
              <>
                <div class="seed" aria-label="Seed phrase">
                  {words.map((w, i) => (
                    <span>
                      <i>{i + 1}</i>
                      {shown ? w : '••••••'}
                    </span>
                  ))}
                </div>
                <div class="seed-bar">
                  <button type="button" class="btn sec" onClick={() => setLeft(shown ? 0 : HIDE_AFTER)}>
                    {shown ? <EyeOff /> : <Eye />}
                    {shown ? 'Hide' : 'Show'}
                  </button>
                  <button type="button" class="btn ghost" onClick={() => copy(words.join(' '), 'Seed phrase', true)}>
                    <Copy />
                    Copy all
                  </button>
                  {shown && (
                    <span class="timer" aria-label={`Hides in ${left} seconds`}>
                      <Timer />
                      Hides in 0:{String(left).padStart(2, '0')}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <Kv label="Seed phrase">
                <div class="muted">None</div>
              </Kv>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---------- form ----------

/** Set one wallet part in the item's custom fields, adding the field (with its standard name) if it isn't there. */
export function withPart(fields: FieldDraft[], part: WalletPart, value: string): FieldDraft[] {
  const at = walletOf(fields)?.at[part];
  if (at !== undefined) return fields.map((f, i) => (i === at ? { ...f, value } : f));
  return [...fields, { name: WALLET_FIELDS[part].name, value, type: WALLET_FIELDS[part].type }];
}

/** The custom fields a new wallet starts with. */
export const newWalletFields = (): FieldDraft[] => (['network', 'address', 'privateKey', 'seed'] as const).map((p) => ({ name: WALLET_FIELDS[p].name, value: '', type: WALLET_FIELDS[p].type }));

type Checks = typeof import('../../shared/walletcheck');
const OTHER = '__other';

export function WalletForm({ fields, name, nameErr, onName, onFields }: { fields: FieldDraft[]; name: string; nameErr: string | null; onName: (v: string) => void; onFields: (f: FieldDraft[]) => void }) {
  const w = walletOf(fields);
  const network = w?.network ?? '';
  const address = w?.address ?? '';
  const key = w?.privateKey ?? '';
  const seed = w?.seed ?? '';
  const [auto, setAuto] = useState<'address' | 'name' | 'site' | null>(network ? null : 'address');
  const [other, setOther] = useState(!!network && !networkById(network));
  // Masked while typed too (someone may be looking over your shoulder); the eye shows them.
  const [showKey, setShowKey] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [chk, setChk] = useState<Checks | null>(null);
  useEffect(() => {
    void import('../../shared/walletcheck').then(setChk).catch(() => {});
  }, []);

  const set = (part: WalletPart, v: string) => onFields(withPart(fields, part, v));
  // Until the user picks one, the network follows the address and the name.
  function follow(f: FieldDraft[], next: { address: string; name: string }) {
    if (!auto) return onFields(f);
    const g = guessNetwork(next);
    setAuto(g?.from ?? 'address');
    onFields(withPart(f, 'network', g ? networkById(g.id)!.name : ''));
  }

  const net = networkById(network);
  const evm = !!net?.evm || (!net && /^0x/i.test(address.trim()));
  const addrBad = addressProblem(address, other ? null : net) ?? (chk && evm ? (chk.checkEvmAddress(address) as { bad?: string } | null)?.bad : null) ?? null;
  const keyCheck = chk ? chk.checkKey(key, address, evm) : null;
  const seedCheck = chk && seed.trim() ? chk.checkSeed(seed) : null;
  const pick = other ? OTHER : (net?.id ?? '');

  return (
    <>
      <label class={`field${nameErr ? ' err' : ''}`}>
        <span class="l">Name</span>
        <span class="inp">
          <input
            id="f-name"
            value={name}
            maxLength={1000}
            placeholder="Hyperliquid main"
            onInput={(e) => {
              onName(val(e));
              if (auto) follow(fields, { address, name: val(e) });
            }}
          />
        </span>
        {nameErr && <span class="f-msg">{nameErr}</span>}
      </label>
      <label class={`field${addrBad ? ' err' : ''}`}>
        <span class="l">
          Public address<small>Optional</small>
        </span>
        <span class="inp">
          <input id="f-address" class="mono" autocomplete="off" spellcheck={false} placeholder="0x…, bc1…" value={address} onInput={(e) => follow(withPart(fields, 'address', val(e).trim()), { address: val(e).trim(), name })} />
        </span>
        {addrBad && <span class="f-msg">{addrBad}</span>}
      </label>
      <div class="field">
        <span class="l">Network</span>
        <div class="net-pick">
          <Coin network={other ? null : network} />
          <select
            class="sel full"
            id="f-network"
            aria-label="Network"
            value={pick}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              setAuto(null);
              setOther(v === OTHER);
              set('network', v === OTHER ? (net ? '' : network) : (networkById(v)?.name ?? ''));
              if (v === OTHER) setTimeout(() => document.getElementById('f-network-other')?.focus(), 0);
            }}
          >
            <option value="">Not set</option>
            <optgroup label="Same 0x address">
              {NETWORKS.filter((n) => n.evm).map((n) => (
                <option value={n.id}>{n.name}</option>
              ))}
            </optgroup>
            <optgroup label="Other networks">
              {NETWORKS.filter((n) => !n.evm).map((n) => (
                <option value={n.id}>{n.name}</option>
              ))}
            </optgroup>
            <option value={OTHER}>Other…</option>
          </select>
        </div>
        {other && (
          <span class="inp" style={{ marginTop: '6px' }}>
            <input id="f-network-other" aria-label="Network name" placeholder="Network name" value={network} onInput={(e) => set('network', val(e))} />
          </span>
        )}
        {auto && net && (
          <span class="f-hint">
            <Sparkles />
            Set from the {auto}.{evm ? ' A 0x address works on many networks.' : ''}
          </span>
        )}
      </div>
      <div class={`field${keyCheck && 'bad' in keyCheck ? ' err' : ''}`}>
        <span class="l">
          Private key<small>Optional</small>
        </span>
        <span class="inp">
          <input id="f-key" class={`mono${showKey ? '' : ' masked'}`} aria-label="Private key" autocomplete="off" spellcheck={false} placeholder="Paste the key" value={key} onInput={(e) => set('privateKey', val(e).trim())} />
          <EyeBtn on={showKey} what="private key" onClick={() => setShowKey(!showKey)} />
        </span>
        {keyCheck && ('bad' in keyCheck ? <span class="f-msg">{keyCheck.bad}</span> : <Ok text={keyCheck.ok} />)}
      </div>
      <div class={`field${seedCheck && 'bad' in seedCheck ? ' err' : ''}`}>
        <span class="l">
          Seed phrase<small>Optional</small>
        </span>
        <span class="inp ta">
          <textarea
            id="f-seed"
            class={`mono${showSeed ? '' : ' masked'}`}
            aria-label="Seed phrase"
            rows={3}
            autocomplete="off"
            spellcheck={false}
            placeholder="12 or 24 words"
            value={seed}
            onInput={(e) => set('seed', (e.currentTarget as HTMLTextAreaElement).value)}
            onBlur={(e) => {
              const v = (e.currentTarget as HTMLTextAreaElement).value;
              if (v.trim() && normalizeSeed(v) !== v) set('seed', normalizeSeed(v));
            }}
          />
          <EyeBtn on={showSeed} what="seed phrase" onClick={() => setShowSeed(!showSeed)} />
        </span>
        {seedCheck && ('bad' in seedCheck ? <span class="f-msg">{seedCheck.bad}</span> : <Ok text={seedCheck.ok} />)}
      </div>
    </>
  );
}

function Ok({ text }: { text: string }) {
  return (
    <span class="f-hint ok">
      <Check />
      {text}
    </span>
  );
}
