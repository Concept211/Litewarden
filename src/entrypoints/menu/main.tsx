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
import { Check, RefreshCw, SlidersHorizontal, X } from 'lucide-preact';
import { expiredMMYY } from '../../core/cards';
import { generatePassword, GEN_MAX, GEN_MIN, type GenOptions } from '../../core/generator';
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

const ago = (at: number) => {
  const m = Math.floor((Date.now() - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} hr ago`;
  const d = Math.floor(m / 1440);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};

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
  const [done, setDone] = useState<{ title: string; line: string } | null>(null);
  /** The generator was asked for on a sign-in box (a new password box starts there). */
  const [genAsked, setGenAsked] = useState(false);
  const [gen, setGen] = useState<GenOptions | null>(null);
  const [genPw, setGenPw] = useState('');
  const [genTune, setGenTune] = useState(false);
  const fillBtn = useRef<HTMLButtonElement>(null);
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
      if (d.gen) setGen((g) => g ?? d.gen!.options);
      if (d.status === 'unlocked' && d.items.length && wantFill.current > Date.now()) {
        wantFill.current = 0;
        const one = d.items.length === 1 ? d.items[0]! : null;
        if (one) void fillNow(one, d.site);
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
      if (!data || data.status === 'unlocked') return (fillBtn.current ?? input.current)?.focus();
      const box = root.current?.querySelectorAll<HTMLInputElement>('.m-pin input')[Math.min(pin.length, 5)];
      (box ?? unlockBtn.current)?.focus();
    };
    if (document.hasFocus()) f();
    addEventListener('focus', f);
    return () => removeEventListener('focus', f);
  }, [data, genAsked]);

  const lengthFor = (o: GenOptions) => Math.min(data?.gen?.max ?? GEN_MAX, GEN_MAX, Math.max(data?.gen?.min ?? GEN_MIN, GEN_MIN, o.length));
  const showGen = data?.status === 'unlocked' && !!data.gen && (data.gen.kind === 'new' || genAsked);
  // A box's limits decide the length, without changing what's remembered for other sites.
  useEffect(() => {
    if (showGen && gen && !genPw) setGenPw(generatePassword({ ...gen, length: lengthFor(gen) }));
  }, [showGen, gen]);

  function tune(patch: Partial<GenOptions>) {
    const next = { ...gen!, ...patch };
    setGen(next);
    setGenPw(generatePassword({ ...next, length: lengthFor(next) }));
    void send('setSettings', { gen: next }).catch(() => {});
  }

  function filledNew(n: number) {
    if (!n) return setMsg('The password box is no longer on the page, so nothing was filled.');
    setDone({ title: 'New password filled', line: n > 1 ? `In ${n} boxes. Submit the form to save it.` : 'Submit the form to save it.' });
    setTimeout(close, 1400);
  }

  async function fillGenerated(ev: { isTrusted: boolean; type: string }) {
    if (busy || !genPw || !can(ev)) return;
    setBusy(true);
    setMsg(null);
    try {
      filledNew((await send('menuGenFill', { token, password: genPw })).filled);
    } catch (e) {
      setMsg((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }

  async function missedAct(act: 'fill' | 'save' | 'forget', ev: { isTrusted: boolean; type: string }) {
    const id = data?.missed?.id;
    if (busy || !id || !can(ev)) return;
    setBusy(true);
    setMsg(null);
    try {
      const { filled } = await send('menuMissed', { token, id, act });
      if (act === 'fill') filledNew(filled);
      if (act === 'forget') void load();
    } catch (e) {
      setMsg((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }

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
    else if (r.outcome === 'reprompt') setMsg(`This ${offer === 'login' ? 'login' : offer === 'card' ? 'card' : 'address'} asks for your master password. Open Litewarden from the toolbar, open the item and type it there, then fill again.`);
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
  async function fillNow(it: IndexItem, site: string) {
    setBusy(true);
    try {
      const r = await send('menuFill', { token, id: it.id, stay: true });
      if (r.outcome !== 'filled') return outcome(r, it.id);
      setDone({ title: 'Unlocked and filled', line: `${it.type === 1 ? (it.username ?? it.name) : it.name} on ${site}` });
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
      // One of these buttons has the focus (Tab got there): Enter is its own click.
      if ((e.target as Element | null)?.closest?.('.m-foot, .m-tools, .m-opts, .m-missed')) return;
      e.preventDefault();
      if (showGen) return void fillGenerated(e);
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
      {showGen && data?.gen?.kind === 'signin' ? (
        <span class="sp">
          <button onClick={(e) => can(e) && setGenAsked(false)}>Back to logins</button>
        </span>
      ) : data?.status === 'unlocked' && data.gen && !showGen ? (
        <span class="sp">
          <button
            onClick={(e) => {
              if (!can(e)) return;
              setQ('');
              setGenAsked(true);
            }}
          >
            Generate password
          </button>
        </span>
      ) : (
        <span class="sp">Esc to close</span>
      )}
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
            <b>{done.title}</b>
            <span>{done.line}</span>
          </div>
        </div>
      </div>
    );
  const locked = data.status !== 'unlocked';
  const w = WORDS[data.offer];
  const missedRow = data.missed && !genTune && (
    <div class="m-missed">
      <div>
        <b>Generated here {ago(data.missed.at)}</b>
        <span>Not saved as a login</span>
      </div>
      <button onClick={(e) => void missedAct('fill', e)}>Fill</button>
      <button onClick={(e) => void missedAct('save', e)}>Save</button>
      <button class="ib" aria-label="Forget this password" title="Forget this password" onClick={(e) => void missedAct('forget', e)}>
        <X />
      </button>
    </div>
  );
  if (showGen && gen) {
    const len = lengthFor(gen);
    const boxes = data.gen!.boxes;
    return (
      <div class="menu" ref={root}>
        {blocked && <div class="blocked">Part of this menu is hidden by the page, so clicks are ignored.</div>}
        <div class="m-gen">
          <button ref={fillBtn} class="m-use" onClick={(e) => void fillGenerated(e)}>
            <b>Use this new password</b>
            <span data-pw>{genPw}</span>
          </button>
          <div class="m-tools">
            <button class={`ib${genTune ? ' on' : ''}`} aria-label="Options" title="Options" aria-expanded={genTune} onClick={() => setGenTune(!genTune)}>
              <SlidersHorizontal />
            </button>
            <button class="ib" aria-label="Another one" title="Another one" onClick={() => setGenPw(generatePassword({ ...gen, length: len }))}>
              <RefreshCw />
            </button>
          </div>
        </div>
        {genTune ? (
          <div class="m-opts">
            <div class="r">
              <span>Length</span>
              <span class="m-step">
                <button aria-label="Shorter" disabled={len <= Math.max(data.gen!.min ?? GEN_MIN, GEN_MIN)} onClick={() => tune({ length: len - 1 })}>
                  −
                </button>
                <span data-len>{len}</span>
                <button aria-label="Longer" disabled={len >= Math.min(data.gen!.max ?? GEN_MAX, GEN_MAX)} onClick={() => tune({ length: len + 1 })}>
                  +
                </button>
              </span>
            </div>
            <div class="r">
              <span>Symbols</span>
              <label class="sw">
                <input type="checkbox" role="switch" aria-label="Symbols" checked={gen.symbols} onChange={(e) => tune({ symbols: (e.currentTarget as HTMLInputElement).checked })} />
                <i />
              </label>
            </div>
            <div class="r">
              <span>Numbers</span>
              <label class="sw">
                <input type="checkbox" role="switch" aria-label="Numbers" checked={gen.digits} onChange={(e) => tune({ digits: (e.currentTarget as HTMLInputElement).checked })} />
                <i />
              </label>
            </div>
          </div>
        ) : (
          !data.missed && <div class="m-note">{boxes === 1 ? 'Fills this box.' : boxes === 2 ? 'Fills both boxes.' : `Fills all ${boxes} boxes.`} Litewarden offers to save it when you submit.</div>
        )}
        {missedRow}
        {msg && <div class="m-msg">{msg}</div>}
        {foot}
      </div>
    );
  }
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
          {data.gen?.kind === 'new' ? 'Unlock it to generate a password here.' : `Unlock it to fill ${w.what} here.`}
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
      {!locked && missedRow}
      {msg && <div class="m-msg">{msg}</div>}
      {foot}
    </div>
  );
}

render(<Menu />, document.getElementById('app')!);
