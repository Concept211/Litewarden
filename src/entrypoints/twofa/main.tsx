// SPDX-License-Identifier: GPL-3.0-only
// The card on a site's 2FA setup page: "Add 2FA to Litewarden?" Adds the page's key to the site's login and types
// the current code into the page, so the user only has to confirm on the site. Same frame rules as the save card:
// its own frame, covers nothing (not even the QR code), Esc or "Not now" closes it.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/hanken-grotesk/latin-800.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import '../../ui/inpage.css';
import { BellOff, Check, TriangleAlert, X } from 'lucide-preact';
import { send, type RemoteError, type TotpData } from '../../shared/messages';
import { Keep, Site, initIcons } from '../../ui/bits';
import { applyFrameTheme, useAutoSize, useGuard, useHash } from '../../ui/frame';

type Act = 'add' | 'notnow' | 'never' | 'undo' | 'unlock';

const group = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

function Card() {
  const { token, bar } = useHash();
  const [d, setD] = useState<TotpData | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [busy, setBusy] = useState<Act | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { can, blocked } = useGuard(root);

  const take = (x: TotpData) => {
    applyFrameTheme(x.theme);
    if (x.server) void initIcons(x.server);
    setD(x);
    setPick((p) => (p && x.targets.some((t) => t.id === p) ? p : x.itemId));
    setUser((u) => u || x.account || '');
    setErr(x.error ?? null);
  };
  const load = () =>
    send('totpData', { token })
      .then(take)
      .catch((e: RemoteError) => setErr(e.message));
  useEffect(() => {
    void load();
    // Unlocked, or added from the popup: the worker changes the record; follow it.
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => area === 'session' && (ch.pendingTotps || ch.index) && void load();
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [token]);

  useAutoSize(token, !!d);

  // Added (code typed) or "never": the card goes by itself after a few seconds, unless the user starts Undo.
  const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!((d?.state === 'added' && d.filled) || d?.state === 'never')) return;
    const h = setTimeout(() => void send('totpAct', { token, act: 'notnow' }).catch(() => {}), 8000);
    dismiss.current = h;
    return () => {
      clearTimeout(h);
      if (dismiss.current === h) dismiss.current = null;
    };
  }, [d?.state, d?.filled]);

  // Added but no code field found: the code to type stays up to date.
  useEffect(() => {
    if (d?.state !== 'added' || d.filled) return;
    const h = setInterval(() => void load(), 3000);
    return () => clearInterval(h);
  }, [d?.state, d?.filled]);

  async function act(a: Act, ev: { isTrusted: boolean; type: string }) {
    if (busy || !can(ev)) return;
    if (a === 'unlock') return void send('totpAct', { token, act: 'unlock' }).catch(() => {});
    if (dismiss.current) clearTimeout(dismiss.current);
    dismiss.current = null;
    setBusy(a);
    try {
      const r = await send('totpAct', { token, act: a, itemId: d?.kind === 'add' ? pick : null, username: user });
      if (a !== 'notnow') take(r);
    } catch (e) {
      setErr((e as RemoteError).message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && void send('totpAct', { token, act: 'notnow' }).catch(() => {});
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [token]);

  if (!d) return <div ref={root}>{err && <div class="conf"><div class="t"><b>{err}</b></div></div>}</div>;

  const site = <Site host={d.site} />;
  const target = d.targets.find((t) => t.id === pick) ?? null;
  const who = target ? target.username || target.name : user || d.site;
  const X_ = (
    <button class="ib x" aria-label="Not now" title="Not now (Esc)" onClick={(e) => void act('notnow', e)}>
      <X />
    </button>
  );

  if (d.state === 'added' || d.state === 'never') {
    const never = d.state === 'never';
    return (
      <div ref={root}>
        <div class="conf" role="status">
          <span class={`ok-dot${never ? ' off' : ''}`}>{never ? <BellOff /> : <Check />}</span>
          <div class="t">
            <b>{never ? <>Won't offer 2FA on {site}</> : `2FA added to ${who}`}</b>
            <span>
              {never ? (
                'Change it in Settings, Autofill.'
              ) : d.filled ? (
                'Code typed into the page'
              ) : (
                <>
                  Type <b class="mono t2-code">{group(d.code ?? '')}</b> into the page
                </>
              )}
            </span>
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

  const locked = d.kind === 'locked';
  const isNew = d.kind === 'new';
  const replace = !!target?.hasTotp;
  const title = isNew ? 'Save 2FA for this site?' : replace ? 'Replace the 2FA key?' : 'Add 2FA to Litewarden?';
  const primary: { act: Act; label: string } = locked ? { act: 'unlock', label: 'Unlock' } : isNew ? { act: 'add', label: 'Save' } : replace ? { act: 'add', label: 'Replace' } : { act: 'add', label: 'Add' };

  if (bar)
    return (
      <div ref={root}>
        <div class="bar">
          <Keep />
          <div class="t">
            <b>{title}</b>
            <span>{locked ? 'Litewarden is locked' : isNew ? `A new login for ${d.site}` : `${who} on ${d.site}`}</span>
          </div>
          <button class="btn" disabled={!!busy} onClick={(e) => void act(primary.act, e)}>
            {primary.label}
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
            {title}
            <span class="p-sub">{site}</span>
          </b>
          {X_}
        </div>
        {blocked && <div class="blocked">Part of this card is hidden by the page, so clicks are ignored.</div>}
        <div class="p-body">
          {locked ? (
            <p class="p-text">Litewarden is locked. Unlock it to add this page's 2FA key.</p>
          ) : isNew ? (
            <>
              <label class="field">
                <span class="l">
                  Username {d.account && <small>from the QR code</small>}
                </span>
                <span class="inp">
                  <input value={user} spellcheck={false} aria-label="Username" onInput={(e) => setUser((e.currentTarget as HTMLInputElement).value)} />
                </span>
              </label>
              <p class="p-text t2-hint">No login is saved for this site yet. This saves one with the 2FA key; the password is added when you next sign in.</p>
            </>
          ) : (
            <>
              {d.targets.length > 1 ? (
                <label class="field">
                  <span class="l">Add to</span>
                  <select class="sel full" aria-label="Add to" value={pick ?? ''} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}>
                    {d.targets.map((t) => (
                      <option value={t.id}>
                        {t.username || t.name}
                        {t.username && t.name !== d.site ? ` (${t.name})` : ''}
                        {t.hasTotp ? ', has 2FA' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                target && (
                  <div class="t2-login">
                    <b>{target.username || target.name}</b>
                    <span>{target.hasTotp ? 'Already has a 2FA key' : 'No 2FA yet'}</span>
                  </div>
                )
              )}
              {replace ? (
                <div class="t2-warn">
                  <TriangleAlert />
                  <span>Replace it only if you're setting up 2FA again. The old key is kept in the login's notes.</span>
                </div>
              ) : (
                <p class="p-text t2-hint">Adds this page's 2FA key to the login, then types the current code into the page for you.</p>
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
          <button class="btn" disabled={!!busy} onClick={(e) => void act(primary.act, e)}>
            {busy === primary.act ? <span class="spinner" /> : primary.label}
          </button>
        </div>
      </div>
    </div>
  );
}

render(<Card />, document.getElementById('app')!);
