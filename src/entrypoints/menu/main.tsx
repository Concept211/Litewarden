// SPDX-License-Identifier: GPL-3.0-only
// The in-page menu: an extension page framed next to a login field. Type to filter, arrows and Enter fill, Esc
// closes. The page can't read or script it; clicks only count while it's fully visible (useGuard).
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import '../../ui/inpage.css';
import { secondsRemaining, totp } from '../../core/totp';
import { send, type MenuData, type RemoteError } from '../../shared/messages';
import { Keep, Site, Tile, initIcons } from '../../ui/bits';
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
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { can, blocked } = useGuard(root);

  async function load() {
    try {
      const d = await send('menuData', { token });
      applyFrameTheme(d.theme);
      if (d.server) await initIcons(d.server);
      setData(d);
    } catch (e) {
      // Not "locked": the vault may well be open. Say what failed; Esc and the footer still close the frame.
      setMsg((e as RemoteError).message);
    }
  }
  useEffect(() => {
    void load();
    // Unlocked in the popup while the menu is open: show the logins.
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => area === 'session' && ch.session && void load();
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [token]);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const t = q.trim().toLowerCase();
    return t ? all.filter((i) => `${i.name} ${i.username ?? ''}`.toLowerCase().includes(t)) : all;
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
  useAutoSize(token, (!!data || !!msg) && !q);

  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);

  // Autofocus is blocked in a cross-origin frame; the page's content script focuses this frame instead, and the
  // filter box takes the focus from there.
  useEffect(() => {
    const f = () => input.current?.focus();
    if (document.hasFocus()) f();
    addEventListener('focus', f);
    return () => removeEventListener('focus', f);
  }, [data]);

  const close = () => void send('surfaceAct', { token, act: 'close' }).catch(() => {});

  async function fill(id: string, force: boolean, ev: { isTrusted: boolean; type: string }) {
    if (busy || !can(ev)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await send('menuFill', { token, id, force });
      if (r.outcome === 'confirm-site') setConfirm(id);
      else if (r.outcome === 'no-fields') setMsg('No login fields found here. Use "Wrong fields?" to point at them.');
      else if (r.outcome === 'blocked-page') setMsg("Litewarden can't fill on this page.");
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
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = confirm ? data?.items.find((i) => i.id === confirm) : items[sel];
      if (it) void fill(it.id, !!confirm, e);
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
  const locked = data.status !== 'unlocked';
  return (
    <div class="menu" ref={root}>
      <label class="m-top">
        <Keep />
        <input ref={input} placeholder={locked ? 'Litewarden is locked' : `Filter ${data.site}`} aria-label="Filter logins" value={q} disabled={locked} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      </label>
      {blocked && <div class="blocked">Part of this menu is hidden by the page, so clicks are ignored.</div>}
      {locked ? (
        <div class="m-msg">
          <b>Litewarden is locked</b>
          Unlock it to fill a login here.
          <br />
          <button class="btn" onClick={(e) => can(e) && void send('openPopup').catch(() => {})}>
            Unlock
          </button>
        </div>
      ) : (
        <div id="mlist" data-scroll role="listbox" aria-label={`Logins for ${data.site}`}>
          {items.map((it, i) => (
            <div class={`m-row${i === sel ? ' is-sel' : ''}`} role="option" aria-selected={i === sel} data-id={it.id} onMouseEnter={() => setSel(i)} onClick={(e) => void fill(it.id, false, e)}>
              <Tile item={it} />
              <div class="who">
                <div class="nm">{it.name}</div>
                <div class="un">{it.username ?? 'No username'}</div>
              </div>
              {codes[it.id] && <span class="code">{codes[it.id]!.slice(0, 3)} {codes[it.id]!.slice(3)}</span>}
            </div>
          ))}
          {!items.length && (
            <div class="m-msg">
              <b>{q ? `No match for "${q}"` : <>No logins saved for <Site host={data.site} /></>}</b>
              {q ? 'Try another word.' : 'Sign in once and Litewarden offers to save it.'}
            </div>
          )}
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
