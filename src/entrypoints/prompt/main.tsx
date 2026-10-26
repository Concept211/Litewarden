// SPDX-License-Identifier: GPL-3.0-only
// Save / update-password prompt (variant C: a card next to the form; a slim bar when the card fits nowhere).
// Never blocks the page: it sits in its own frame, covers nothing, and goes away with Esc or "Not now".
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/hanken-grotesk/latin-800.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import '../../ui/inpage.css';
import { BellOff, Check, Eye, EyeOff, X } from 'lucide-preact';
import { send, type PromptData, type RemoteError } from '../../shared/messages';
import { Keep, Site, initIcons } from '../../ui/bits';
import { applyFrameTheme, useAutoSize, useGuard, useHash } from '../../ui/frame';
import { tidyPaste } from '../../ui/paste';

tidyPaste();

type Act = 'save' | 'notnow' | 'never' | 'undo' | 'unlock';

function Prompt() {
  const { token, bar } = useHash();
  const [d, setD] = useState<PromptData | null>(null);
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [folder, setFolder] = useState<string>('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<Act | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { can, blocked } = useGuard(root);

  const take = (x: PromptData) => {
    applyFrameTheme(x.theme);
    if (x.server) void initIcons(x.server);
    setD(x);
    setUser(x.username);
    setPw(x.password);
    setErr(x.error ?? null);
  };
  useEffect(() => {
    send('promptData', { token })
      .then(take)
      .catch((e: RemoteError) => setErr(e.message));
    // Unlocked from "Unlock to save": the worker re-decides and reloads us; also pick it up here.
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => area === 'session' && ch.pendingSaves && void send('promptData', { token }).then(take).catch(() => {});
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [token]);

  useAutoSize(token, !!d);

  // A saved / never confirmation goes away by itself after a few seconds, unless the user starts something
  // (Undo): act() cancels it at once, so a slow server can't let the timer close the card mid-Undo.
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (d?.state !== 'saved' && d?.state !== 'never') return;
    const h = setTimeout(() => void send('promptAct', { token, act: 'notnow' }).catch(() => {}), 8000);
    dismiss.current = h;
    return () => {
      clearTimeout(h);
      if (dismiss.current === h) dismiss.current = null;
    };
  }, [d?.state]);

  async function act(a: Act, ev: { isTrusted: boolean; type: string }) {
    if (busy || !can(ev)) return;
    // Opening the popup is fire and forget: the card updates by itself once the vault is unlocked.
    if (a === 'unlock') return void send('promptAct', { token, act: 'unlock' }).catch(() => {});
    if (dismiss.current) clearTimeout(dismiss.current);
    dismiss.current = null;
    setBusy(a);
    try {
      const r = await send('promptAct', { token, act: a, username: user, password: pw, folderId: folder || null });
      if (a !== 'notnow') take(r);
    } catch (e) {
      setErr((e as RemoteError).message);
    } finally {
      setBusy(null);
    }
  }

  // Esc anywhere in the frame (focus may be on <body>).
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && void send('promptAct', { token, act: 'notnow' }).catch(() => {});
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [token]);
  if (!d) return <div ref={root}>{err && <div class="conf"><div class="t"><b>{err}</b></div></div>}</div>;

  const upd = d.kind === 'update';
  const locked = d.kind === 'locked';
  const title = upd ? `Update password for ${d.username || 'this login'}?` : `Save login for ${d.site}?`;
  const site = <Site host={d.site} />;
  const heading = upd ? title : <>Save login for {site}?</>;
  const X_ = (
    <button class="ib x" aria-label="Not now" title="Not now (Esc)" onClick={(e) => void act('notnow', e)}>
      <X />
    </button>
  );

  if (d.state === 'saved' || d.state === 'never') {
    const never = d.state === 'never';
    return (
      <div ref={root}>
        <div class="conf" role="status">
          <span class={`ok-dot${never ? ' off' : ''}`}>{never ? <BellOff /> : <Check />}</span>
          <div class="t">
            <b>{never ? <>Won't ask on {site}</> : upd ? 'Password updated' : 'Login saved'}</b>
            <span>{never ? 'Change it in Settings, Autofill.' : <>{upd ? d.username : d.username || 'No username'} on {site}</>}</span>
          </div>
          <button class="btn ghost" onClick={(e) => void act('undo', e)}>
            Undo
          </button>
          {X_}
        </div>
        {err && <p class="p-err">{err}</p>}
      </div>
    );
  }

  const primary = locked ? 'Unlock to save' : upd ? 'Update' : 'Save';
  const primaryAct: Act = locked ? 'unlock' : 'save';

  if (bar)
    return (
      <div ref={root}>
        <div class="bar">
          <Keep />
          <div class="t">
            <b>{heading}</b>
            <span>{locked ? 'Litewarden is locked' : upd ? 'The password you just used is new' : `${d.username || 'No username'} · ••••••••••`}</span>
          </div>
          <button class="btn" disabled={!!busy} onClick={(e) => void act(primaryAct, e)}>
            {primary}
          </button>
          {X_}
        </div>
      </div>
    );

  return (
    <div ref={root}>
      <div class="prompt" role="dialog" aria-label={title}>
        <div class="p-head">
          <Keep />
          <b>
            {heading}
            {upd && <span class="p-sub">{site}</span>}
          </b>
          {X_}
        </div>
        {blocked && <div class="blocked">Part of this card is hidden by the page, so clicks are ignored.</div>}
        <div class="p-body">
          {locked ? (
            <p class="p-text">Litewarden is locked. Unlock it to save {d.username ? <b>{d.username}</b> : 'this login'} for {site}.</p>
          ) : upd ? (
            <div class="diff">
              <div>
                <small>Saved</small>
                <span class="mono">••••••••••</span>
              </div>
              <div>
                <small>New</small>
                <span class="mono">{reveal ? pw : '•'.repeat(Math.min(16, pw.length))}</span>
                <button class="ib" aria-label={reveal ? 'Hide new password' : 'Show new password'} onClick={() => setReveal(!reveal)}>
                  {reveal ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label class="field">
                <span class="l">Username</span>
                <span class="inp">
                  <input value={user} spellcheck={false} aria-label="Username" onInput={(e) => setUser((e.currentTarget as HTMLInputElement).value)} />
                </span>
              </label>
              <label class="field">
                <span class="l">Password</span>
                <span class="inp">
                  <input class="mono" {...({ type: reveal ? 'text' : 'password' } as { type: 'password' })} value={pw} aria-label="Password" onInput={(e) => setPw((e.currentTarget as HTMLInputElement).value)} />
                  <button type="button" class="ib" aria-label={reveal ? 'Hide password' : 'Show password'} onClick={() => setReveal(!reveal)}>
                    {reveal ? <EyeOff /> : <Eye />}
                  </button>
                </span>
              </label>
              {d.folders.length > 0 && (
                <label class="field">
                  <span class="l">Folder</span>
                  <select class="sel full" aria-label="Folder" value={folder} onChange={(e) => setFolder((e.currentTarget as HTMLSelectElement).value)}>
                    <option value="">No folder</option>
                    {d.folders.map((f) => (
                      <option value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {err && <p class="p-err">{err}</p>}
        </div>
        <div class="p-acts">
          <button class="never" onClick={(e) => void act('never', e)}>
            Never for this site
          </button>
          <button class="btn sec" onClick={(e) => void act('notnow', e)}>
            Not now
          </button>
          <button class="btn" disabled={!!busy} onClick={(e) => void act(primaryAct, e)}>
            {busy === primaryAct ? <span class="spinner" /> : locked ? 'Unlock' : primary}
          </button>
        </div>
      </div>
    </div>
  );
}

render(<Prompt />, document.getElementById('app')!);
