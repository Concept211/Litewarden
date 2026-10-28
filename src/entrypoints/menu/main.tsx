// SPDX-License-Identifier: GPL-3.0-only
// The in-page menu: an extension page framed next to a login field (or a card or address field). Type to filter,
// arrows and Enter fill, Esc closes. Locked, it takes the PIN itself; the master password stays in the toolbar popup.
// The page can't read or script it; clicks only count while it's fully visible (useGuard).
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import '../../ui/inpage.css';
import { Check } from 'lucide-preact';
import { expiredMMYY } from '../../core/cards';
import { secondsRemaining, totp } from '../../core/totp';
import { send, type MenuData, type RemoteError } from '../../shared/messages';
import type { IndexItem } from '../../shared/store';
import { CodeBoxes, Keep, Site, Tile, initIcons } from '../../ui/bits';

const WORDS = {
  login: { filter: 'Filter logins', what: 'a login', none: 'No logins saved for', hint: 'Sign in once and Litewarden offers to save it.' },
  card: { filter: 'Filter cards', what: 'a card', none: 'No cards saved yet', hint: 'Add one with + in the toolbar popup.' },
  identity: { filter: 'Filter addresses', what: 'an address', none: 'No addresses saved yet', hint: 'Add an identity with + in the toolbar popup.' },
} as const;
import { applyFrameTheme, useAutoSize, useGuard, useHash } from '../../ui/frame';

function Menu() {
  const { token } = useHash();
  const [data, setData] = useState<MenuData | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  /** Payment frames from other origins the fill wants to use: asked once per shop. */
  const [frameAsk, setFrameAsk] = useState<{ id: string; origins: string[] } | null>(null);
  /** "Unlocked and filled": shown for a moment, then the menu closes. */
  const [done, setDone] = useState<string | null>(null);
  /**
   * Until when (ms) an unlock counts as asked from this menu (PIN here, or Unlock and the popup): the first list
   * that arrives after it fills at once when it has one choice. The list can take a moment (the vault's index is
   * rebuilt after the session starts), so it waits for one with something in it.
   */
  const wantFill = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const unlockBtn = useRef<HTMLButtonElement>(null);
  const { can, blocked } = useGuard(root);

  async function load() {
    try {
      const d = await send('menuData', { token });
      applyFrameTheme(d.theme);
      if (d.server) await initIcons(d.server);
      setData(d);
      if (d.status === 'unlocked' && d.items.length && wantFill.current > Date.now()) {
        wantFill.current = 0;
        const one = d.items.length === 1 ? d.items[0]! : null;
        if (one) void fillNow(one);
      }
    } catch (e) {
      // Not "locked": the vault may well be open. Say what failed; Esc and the footer still close the frame.
      setMsg((e as RemoteError).message);
    }
  }
  useEffect(() => {
    void load();
    // Unlocked in the popup while the menu is open (or the list was rebuilt after an unlock): show the logins.
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => area === 'session' && (ch.session || ch.index) && void load();
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [token]);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const t = q.trim().toLowerCase();
    return t ? all.filter((i) => `${i.name} ${i.username ?? ''} ${i.subtitle ?? ''}`.toLowerCase().includes(t)) : all;
  }, [data, q]);

  // live 2FA codes
  useEffect(() => {
    const secrets = data?.totp ?? {};
    if (!Object.keys(secrets).length) return;
    let live = true;
    const tick = async () => {
      const out: Record<string, string> = {};
      for (const [id, s] of Object.entries(secrets)) out[id] = await totp(s).catch(() => '');
      if (live) setCodes(out);
    };
    void tick();
    const h = setInterval(tick, Math.min(1000, secondsRemaining() * 1000));
    return () => {
      live = false;
      clearInterval(h);
    };
  }, [data]);

  // The frame on the page hugs the menu. Not while filtering: a menu that shrinks as you type would jump around.
  // A question (fill on another site, fill payment frames) resizes it even then: it must not push the list out.
  useAutoSize(token, (!!data || !!msg || !!done) && (!q || !!frameAsk || !!confirm));

  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);

  // Autofocus is blocked in a cross-origin frame; the page's content script focuses this frame instead, and the
  // filter box takes the focus from there.
  useEffect(() => {
    // Locked: the PIN boxes have the focus (or, without a PIN, the Unlock button, so Enter unlocks).
    const f = () => {
      if (!data || data.status === 'unlocked') return input.current?.focus();
      const box = root.current?.querySelectorAll<HTMLInputElement>('.m-pin input')[Math.min(pin.length, 5)];
      (box ?? unlockBtn.current)?.focus();
    };
    if (document.hasFocus()) f();
    addEventListener('focus', f);
    return () => removeEventListener('focus', f);
  }, [data]);

  const close = () => void send('surfaceAct', { token, act: 'close' }).catch(() => {});
  const unlock = () => {
    wantFill.current = Date.now() + 120_000;
    void send('openPopup').catch(() => {});
  };

  async function pinUnlock(v: string) {
    if (busy) return;
    setBusy(true);
    setPinErr(null);
    wantFill.current = Date.now() + 30_000;
    try {
      await send('menuUnlock', { token, pin: v });
    } catch (e) {
      wantFill.current = 0;
      setPin('');
      const err = e as RemoteError;
      setPinErr(err.message);
      // Too many wrong PINs turned the PIN off: the menu falls back to Unlock (the popup, master password).
      if (err.data === 'disabled') void load();
      return;
    } finally {
      // Not held while the list loads: the list shows (from the storage change) and Enter must work at once.
      setBusy(false);
    }
    void load();
  }

  function outcome(r: { outcome: string; frameOrigins?: string[] }, id: string) {
    const offer = data?.offer ?? 'login';
    if (r.outcome === 'confirm-site') setConfirm(id);
    else if (r.outcome === 'confirm-frame' && r.frameOrigins?.length) setFrameAsk({ id, origins: r.frameOrigins });
    else if (r.outcome === 'no-fields')
      setMsg(offer === 'login' ? 'No login fields found here. Use "Wrong fields?" to point at them.' : `No ${offer === 'card' ? 'card' : 'address'} fields found here to fill.`);
    else if (r.outcome === 'blocked-page') setMsg("Litewarden can't fill on this page.");
  }

  async function fill(id: string, force: boolean, ev: { isTrusted: boolean; type: string }) {
    if (busy || !can(ev)) return;
    setBusy(true);
    setMsg(null);
    setFrameAsk(null);
    try {
      outcome(await send('menuFill', { token, id, force }), id);
    } catch (e) {
      setMsg((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }

  /** Right after an unlock from this menu, with one thing to fill: fill it, say so, close. */
  async function fillNow(it: IndexItem) {
    setBusy(true);
    try {
      const r = await send('menuFill', { token, id: it.id, stay: true });
      if (r.outcome !== 'filled') return outcome(r, it.id);
      setDone(it.type === 1 ? (it.username ?? it.name) : it.name);
      setTimeout(close, 1400);
    } catch (e) {
      setMsg((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') return (e.preventDefault(), close());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, Math.min(items.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))));
    }
    if (e.key === 'Enter' && data && data.status !== 'unlocked') {
      e.preventDefault();
      // The PIN boxes unlock on the 6th digit; Enter there only resends a full PIN.
      if (data.pin) return void (pin.length === 6 && pinUnlock(pin));
      return unlock();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const ask = frameAsk?.id ?? confirm;
      const it = ask ? data?.items.find((i) => i.id === ask) : items[sel];
      if (it) void fill(it.id, !!ask, e);
    }
  }

  // Keys are handled for the whole frame: right after it opens, the focus can still be on <body> rather than the
  // filter box, and Esc, the arrows and Enter must work then too.
  const keys = useRef(onKey);
  keys.current = onKey;
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  const foot = (
    <div class="m-foot">
      <span class="sp">Esc to close</span>
      <button onClick={(e) => can(e) && void send('surfaceAct', { token, act: 'teach' })}>Wrong fields?</button>
      <button onClick={(e) => can(e) && void send('surfaceAct', { token, act: 'hide' })}>Hide here</button>
    </div>
  );
  if (!data)
    return (
      <div class="menu" ref={root}>
        {msg && (
          <>
            <div class="m-msg">{msg}</div>
            <div class="m-foot">
              <span class="sp">Esc to close</span>
              <button onClick={close}>Close</button>
            </div>
          </>
        )}
      </div>
    );
  if (done)
    return (
      <div ref={root}>
        <div class="conf" role="status">
          <span class="ok-dot">
            <Check />
          </span>
          <div class="t">
            <b>Unlocked and filled</b>
            <span>
              {done} on {data.site}
            </span>
          </div>
        </div>
      </div>
    );
  const locked = data.status !== 'unlocked';
  const w = WORDS[data.offer];
  return (
    <div class="menu" ref={root}>
      <label class="m-top">
        <Keep />
        <input ref={input} placeholder={locked ? 'Litewarden is locked' : data.offer === 'login' ? `Filter ${data.site}` : w.filter} aria-label={w.filter} value={q} disabled={locked} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      </label>
      {blocked && <div class="blocked">Part of this menu is hidden by the page, so clicks are ignored.</div>}
      {locked && data.pin ? (
        <div class={`m-msg m-pin${pinErr ? ' err' : ''}`}>
          <b>Type your PIN to unlock</b>
          <CodeBoxes cls="pin" mask label="PIN" value={pin} onChange={(v) => (setPin(v), setPinErr(null))} autoFocus disabled={busy} onComplete={(v) => void pinUnlock(v)} />
          {pinErr && (
            <span class="m-err" role="alert">
              {pinErr}
            </span>
          )}
          <button class="m-link" onClick={(e) => can(e) && unlock()}>
            or use the master password
          </button>
        </div>
      ) : locked ? (
        <div class="m-msg">
          <b>Litewarden is locked</b>
          Unlock it to fill {w.what} here.
          {pinErr && (
            <span class="m-err" role="alert">
              {pinErr}
            </span>
          )}
          <br />
          <span class="m-unlock">
            <button ref={unlockBtn} class="btn" onClick={(e) => can(e) && unlock()}>
              Unlock
            </button>
            or press <kbd>Enter</kbd>
          </span>
        </div>
      ) : (
        <div id="mlist" data-scroll role="listbox" aria-label={data.offer === 'login' ? `Logins for ${data.site}` : data.offer === 'card' ? 'Cards' : 'Addresses'}>
          {data.offer !== 'login' && !!items.length && <div class="m-sec">{data.offer === 'card' ? 'Cards' : 'Addresses'}</div>}
          {items.map((it, i) => {
            const old = it.type === 3 && !!it.exp && expiredMMYY(it.exp);
            return (
              <div class={`m-row${i === sel ? ' is-sel' : ''}`} role="option" aria-selected={i === sel} data-id={it.id} onMouseEnter={() => setSel(i)} onClick={(e) => void fill(it.id, false, e)}>
                <Tile item={it} />
                <div class="who">
                  <div class="nm">{it.name}</div>
                  <div class="un">{it.type === 1 ? (it.username ?? 'No username') : (it.subtitle ?? '')}</div>
                </div>
                {codes[it.id] && (
                  <span class="code">
                    {codes[it.id]!.slice(0, 3)} {codes[it.id]!.slice(3)}
                  </span>
                )}
                {it.type === 3 && it.exp && (old ? <span class="pill bad">expired</span> : <span class="code">{it.exp}</span>)}
              </div>
            );
          })}
          {!items.length && (
            <div class="m-msg">
              <b>
                {q ? (
                  `No match for "${q}"`
                ) : data.offer === 'login' ? (
                  <>
                    No logins saved for <Site host={data.site} />
                  </>
                ) : (
                  w.none
                )}
              </b>
              {q ? 'Try another word.' : w.hint}
            </div>
          )}
        </div>
      )}
      {frameAsk && (
        <div class="m-confirm">
          <span>
            The {data.offer === 'card' ? 'card' : 'address'} boxes are in frames from {frameAsk.origins.map((o) => o.replace(/^https?:\/\//, '')).join(', ')} on {data.site}. Fill them?
          </span>
          <button class="btn" onClick={(e) => void fill(frameAsk.id, true, e)}>
            Fill
          </button>
        </div>
      )}
      {confirm && (
        <div class="m-confirm">
          <span>This login is saved for another site. Fill it here?</span>
          <button class="btn" onClick={(e) => void fill(confirm, true, e)}>
            Fill anyway
          </button>
        </div>
      )}
      {msg && <div class="m-msg">{msg}</div>}
      {foot}
    </div>
  );
}

render(<Menu />, document.getElementById('app')!);
