// SPDX-License-Identifier: GPL-3.0-only
// "Teach this site" (variant B, side panel): the user points at the username, password and optional 2FA field;
// the content script records the clicks and this panel shows the steps. Esc cancels at any point.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/hanken-grotesk/latin-800.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import '../../ui/inpage.css';
import { Check, X } from 'lucide-preact';
import { getSettings, type TeachState } from '../../shared/store';
import { send, type RemoteError } from '../../shared/messages';
import { Keep } from '../../ui/bits';
import { applyFrameTheme, useGuard, useHash } from '../../ui/frame';

type Act = 'back' | 'save' | 'cancel' | 'undo' | 'done';
const ASK = ['', 'Click the username or email field', 'Click the password field', 'Click the 2FA code field, if this page has one'];

function Teach() {
  const { token, bar } = useHash();
  const [site, setSite] = useState('');
  const [st, setSt] = useState<TeachState>({ step: 1, username: null, password: null, totp: null });
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { can, blocked } = useGuard(root);

  useEffect(() => {
    void getSettings().then((s) => applyFrameTheme(s.theme));
    send('teachData', { token })
      .then((d) => (setSite(d.site), setSt(d.state)))
      .catch((e: RemoteError) => setErr(e.message));
    const on = (m: { event?: string; token?: string; state?: TeachState }) => {
      if (m?.event === 'teach-state' && m.token === token && m.state) setSt(m.state);
    };
    chrome.runtime.onMessage.addListener(on);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && void send('teachAct', { token, act: 'cancel' });
    addEventListener('keydown', key);
    return () => (chrome.runtime.onMessage.removeListener(on), removeEventListener('keydown', key));
  }, [token]);

  const act = (a: Act, ev: { isTrusted: boolean; type: string }) => {
    if (a !== 'cancel' && !can(ev)) return;
    void send('teachAct', { token, act: a }).catch((e: RemoteError) => setErr(e.message));
  };
  const n = st.step;
  const close = (
    <button class="ib x" aria-label="Cancel" title="Cancel (Esc)" onClick={(e) => act('cancel', e)}>
      <X />
    </button>
  );

  if (n === 4) {
    if (bar)
      return (
        <div ref={root} class="tbar" role="status">
          <span class="ok-dot">
            <Check />
          </span>
          <div class="t">
            <b>Rule saved</b>
            <span>
              {site}: username {st.username ?? 'none'}, password {st.password ?? 'none'}
              {st.totp ? `, 2FA ${st.totp}` : ''}
            </span>
          </div>
          <button class="btn ghost" onClick={(e) => act('undo', e)}>
            Undo
          </button>
          <button class="btn" onClick={(e) => act('done', e)}>
            Done
          </button>
        </div>
      );
    return (
      <div ref={root} class="saved" role="status">
        <div class="h">
          <span class="ok-dot">
            <Check />
          </span>
          <b>Saved for {site}</b>
        </div>
        <div class="map">
          <span>Username</span>
          <span class="mono">{st.username ?? 'none'}</span>
          <span>Password</span>
          <span class="mono">{st.password ?? 'none'}</span>
          <span>2FA code</span>
          <span class={st.totp ? 'mono' : 'muted'}>{st.totp ?? 'none'}</span>
        </div>
        <p>Litewarden fills these fields on this site from now on. If the site changes, remove the rule in Settings, Autofill, Site rules.</p>
        <div class="acts">
          <button class="btn ghost" onClick={(e) => act('undo', e)}>
            Undo
          </button>
          <button class="btn" onClick={(e) => act('done', e)}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (bar)
    return (
      <div ref={root} class="tbar">
        <Keep />
        <div class="dots" aria-hidden="true">
          {[1, 2, 3].map((k) => (
            <i class={k <= n ? 'on' : ''} />
          ))}
        </div>
        <div class="t">
          <b>{ASK[n]}</b>
          <span>Step {n} of 3 · Esc cancels</span>
        </div>
        {n > 1 && (
          <button class="btn sec" onClick={(e) => act('back', e)}>
            Back
          </button>
        )}
        {n === 3 && (
          <button class="btn" onClick={(e) => act('save', e)}>
            Skip and save
          </button>
        )}
        {close}
      </div>
    );

  const role = (k: number, t: string, val: string | null, opt = false) => {
    const done = k < n && (k < 3 || !!val);
    return (
      <div class={`role${k === n ? ' cur' : done ? ' ok' : ''}`}>
        <span class="n">{done ? <Check /> : k}</span>
        <div>
          <b>
            {t}
            {opt && <span> (optional)</span>}
          </b>
          <span class={val ? 'mono' : ''}>{val ?? (k === n ? 'Click it on the page' : k < n ? 'Skipped' : 'Waiting')}</span>
        </div>
      </div>
    );
  };
  return (
    <div ref={root} class="panel" role="dialog" aria-label="Teach this site">
      <div class="p-head">
        <Keep />
        <b>Teach this site</b>
        {close}
      </div>
      {blocked && <div class="blocked">Part of this panel is hidden by the page, so clicks are ignored.</div>}
      <div class="p-body">
        <p class="muted" style={{ margin: '0 2px', fontSize: '12px', lineHeight: 1.45 }}>
          Point at {site ? `${site}'s` : 'the'} login fields once and Litewarden remembers them on this device.
        </p>
        {role(1, 'Username or email', st.username)}
        {role(2, 'Password', st.password)}
        {role(3, '2FA code', st.totp, true)}
        {err && <p class="p-err">{err}</p>}
      </div>
      <div class="p-acts">
        {n > 1 && (
          <button class="btn sec" onClick={(e) => act('back', e)}>
            Back
          </button>
        )}
        <button class="btn" disabled={n < 3} onClick={(e) => act('save', e)}>
          Save rule
        </button>
      </div>
    </div>
  );
}

render(<Teach />, document.getElementById('app')!);
