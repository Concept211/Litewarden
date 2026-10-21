// SPDX-License-Identifier: GPL-3.0-only
// Unlock, variant C (PIN first): PIN boxes when PIN is on, master password one tap away.
import { useEffect, useState } from 'preact/hooks';
import { CircleAlert, Eye, EyeOff, Info, LockKeyhole, LockOpen, Timer } from 'lucide-preact';
import { RemoteError, send } from '../../shared/messages';
import { Avatar, Busy, CodeBoxes, initIcons, Keep } from '../../ui/bits';
import type { Boot } from './boot';
import { useAutoFocus } from './focus';

const host = (u: string | undefined) => (u ? u.replace(/^https?:\/\//, '') : '');

export function lockNote(b: Boot) {
  const m = b.settings.lockMinutes;
  const idle = m ? `after ${m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minute${m === 1 ? '' : 's'}`} idle` : '';
  const close = b.settings.lockOnClose ? 'when the browser closes' : '';
  const parts = [idle, close].filter(Boolean).join(' and ');
  return parts ? `Locks ${parts}. Change this in Settings.` : 'Only locks when you press Lock. Change this in Settings.';
}

export function Unlock({ boot: b, onUnlocked, onLoggedOut }: { boot: Boot; onUnlocked: () => void; onLoggedOut: () => void }) {
  const [mode, setMode] = useState<'pin' | 'pw'>(b.pinEnabled ? 'pin' : 'pw');
  const [pinEnabled, setPinEnabled] = useState(b.pinEnabled);
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(b.lockout && b.lockout.pwUntil > Date.now() ? b.lockout.pwUntil : 0);
  const [now, setNow] = useState(Date.now());
  const [confirmOut, setConfirmOut] = useState(false);
  useAutoFocus([mode, until > now]);
  useEffect(() => void (b.account && initIcons(b.account.server)), []);

  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) {
        setUntil(0);
        setErr(null);
      }
    }, 500);
    return () => clearInterval(t);
  }, [until]);

  async function unlock(kind: 'pin' | 'pw', value: string) {
    if (!value) {
      setErr(kind === 'pw' ? 'Type your master password first.' : 'Enter your 6-digit PIN.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'pin') await send('unlockPin', { pin: value });
      else await send('unlockPassword', { password: value });
      onUnlocked();
    } catch (e) {
      const r = e as RemoteError;
      setErr(r.message);
      if (r.name === 'LockedOut') setUntil(Number(r.data) || Date.now() + 60_000);
      if (r.name === 'WrongPin') {
        setPin('');
        if (r.data === 'disabled') {
          setPinEnabled(false);
          setMode('pw');
        }
      }
      if (r.name === 'WrongPassword') setPw('');
    } finally {
      setBusy(false);
    }
  }

  const locked = until > now;
  const wait = Math.max(0, Math.ceil((until - now) / 1000));
  const pwField = (
    <label class={`field${err && mode === 'pw' ? ' err' : ''}`}>
      <span class="l">Master password</span>
      <span class="inp">
        <input
          id="pw"
          {...({ type: reveal ? 'text' : 'password' } as { type: 'password' })}
          autocomplete="current-password"
          value={pw}
          disabled={locked}
          data-af
          aria-invalid={!!err}
          onInput={(e) => setPw((e.currentTarget as HTMLInputElement).value)}
        />
        <button type="button" class="ib" aria-label={reveal ? 'Hide password' : 'Show password'} title={reveal ? 'Hide password' : 'Show password'} onClick={() => setReveal(!reveal)}>
          {reveal ? <EyeOff /> : <Eye />}
        </button>
      </span>
      <span class="f-msg">
        {locked ? <Timer /> : err ? <CircleAlert /> : <LockKeyhole />}
        <span>
          {locked ? (
            <>
              Too many tries. You can try again in <span class="wait">{`${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')}`}</span>.
            </>
          ) : (
            (err ?? 'Unlocking takes about half a second. Your password never leaves this device.')
          )}
        </span>
      </span>
    </label>
  );

  return (
    <div class="ul">
      <div class="ul-mark">
        <Keep />
        Litewarden
      </div>
      <div class="acct">
        <Avatar email={b.account?.email ?? '?'} />
        <div class="who">
          <b>{b.account?.email}</b>
          <span>
            {host(b.account?.server)}
            {b.account?.serverInfo.version ? ` · ${b.account.serverInfo.name} ${b.account.serverInfo.version}` : ''}
          </span>
        </div>
        <button class="lo" onClick={() => setConfirmOut(true)}>
          Log out
        </button>
      </div>
      <form id="f" onSubmit={(e) => (e.preventDefault(), void unlock(mode, mode === 'pin' ? pin : pw))}>
        {mode === 'pin' ? (
          <>
            <div class={`field${err ? ' err' : ''}`}>
              <span class="l">
                PIN<small>6 digits</small>
              </span>
              <CodeBoxes cls="pin" label="PIN" value={pin} onChange={setPin} autoFocus disabled={busy} onComplete={(v) => void unlock('pin', v)} />
              <span class="f-msg">
                {err ? <CircleAlert /> : <Info />}
                <span>
                  {err ??
                    (b.settings.pinSurvivesRestart
                      ? 'PIN keeps working after the browser restarts.'
                      : 'PIN works until the browser closes. After that, use the master password once.')}
                </span>
              </span>
            </div>
            {busy && <p class="muted" style={{ textAlign: 'center', margin: 0 }}>Unlocking…</p>}
            <button type="button" class="btn ghost wide" onClick={() => (setMode('pw'), setErr(null))}>
              Use master password instead
            </button>
          </>
        ) : (
          <>
            {!pinEnabled && (
              <div class="note">
                <Info />
                <div>
                  <b>PIN unlock is off</b>
                  <p>Unlock with your master password, then turn on PIN in Settings.</p>
                </div>
              </div>
            )}
            {pwField}
            <Busy class="btn wide" id="go" type="submit" busy={busy} label="Unlocking…" disabled={locked}>
              <LockOpen />
              Unlock
            </Busy>
            {pinEnabled && (
              <button type="button" class="btn ghost wide" onClick={() => (setMode('pin'), setErr(null))}>
                Use PIN instead
              </button>
            )}
          </>
        )}
      </form>
      <p class="foot-note">{lockNote(b)}</p>
      {confirmOut && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setConfirmOut(false)}>
          <div class="h-card" role="dialog" aria-label="Log out">
            <div class="h-head">
              <b>Log out of {b.account?.email}?</b>
            </div>
            <p>This removes the encrypted vault copy and your PIN from this browser. You'll need your master password to sign in again.</p>
            <div class="c-actions">
              <button type="button" onClick={() => setConfirmOut(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="c-ok"
                onClick={async () => {
                  await send('logout');
                  onLoggedOut();
                }}
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
