// SPDX-License-Identifier: GPL-3.0-only
// First run (r4/firstrun): server check, sign in, two-step code, then the vault downloads and decrypts.
import { useEffect, useState } from 'preact/hooks';
import { Check, CircleAlert, CircleCheck, Eye, EyeOff, Info, LockKeyhole, Server } from 'lucide-preact';
import type { ServerInfo } from '../../core/api';
import { RemoteError, send, type Progress } from '../../shared/messages';
import { Busy, CodeBoxes, Keep } from '../../ui/bits';
import { useAutoFocus } from './focus';

type Step = 'url' | 'cloud' | 'login' | 'twofa' | 'done';
const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function FirstRun({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('url');
  const [url, setUrl] = useState('https://');
  const [found, setFound] = useState<(ServerInfo & { url: string }) | null>(null);
  const [urlErr, setUrlErr] = useState<{ kind: 'old' | 'down' | 'bad' | 'other'; text: string } | null>(null);
  const [region, setRegion] = useState<'US' | 'EU'>('US');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [reveal, setReveal] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [ready, setReady] = useState(false);
  const [final, setFinal] = useState<string | null>(null);

  useEffect(() => {
    const l = (m: Progress & { event?: string }) => {
      if (m.event !== 'progress') return;
      setProgress(m);
      setStep('done');
    };
    chrome.runtime.onMessage.addListener(l);
    return () => chrome.runtime.onMessage.removeListener(l);
  }, []);

  useAutoFocus([step, !!found, ready]);
  const server = found?.url ?? url;
  const stepNo = step === 'url' || step === 'cloud' ? 1 : step === 'login' ? 2 : step === 'twofa' ? 3 : 4;

  async function check() {
    const u = url.trim();
    if (!/^(https?:\/\/)?[^/\s]+\.[^/\s]+|^(https?:\/\/)?(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?/i.test(u) || /^https?:\/\/$/i.test(u)) {
      setUrlErr({ kind: 'bad', text: 'Enter the full address, like https://vault.example.com' });
      return;
    }
    setBusy(true);
    setUrlErr(null);
    setFound(null);
    try {
      const info = await send('checkServer', { url: u });
      if (info.tooOld) setUrlErr({ kind: 'old', text: `This server runs Vaultwarden ${info.version}. Litewarden needs 1.35.0 or later.` });
      else setFound(info);
    } catch (err) {
      const e = err as RemoteError;
      if (e.name === 'ServerUnreachable')
        setUrlErr({ kind: 'down', text: `No answer from ${host(u.includes('://') ? u : 'https://' + u)} after 8 seconds. Check the address and that you're on the same network or VPN as the server.` });
      else if (e.name === 'UserError') setUrlErr({ kind: 'bad', text: e.message });
      else setUrlErr({ kind: 'other', text: `That address answered, but not like a Vaultwarden server. ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function signIn(twoFactor?: { provider: number; token: string; remember: boolean }) {
    if (!email.trim() || !pw) {
      setLoginErr(!email.trim() ? 'Enter your email.' : 'Enter your master password.');
      return;
    }
    setBusy(true);
    setLoginErr(null);
    try {
      const r = await send('login', { server, email, password: pw, ...(twoFactor ? { twoFactor } : {}) });
      if (r.status === 'ok') {
        setStep('done');
        setReady(true);
      }
    } catch (err) {
      const e = err as RemoteError;
      if (e.name === 'TwoFactorRequired') {
        const providers = (e.data as number[] | undefined) ?? [];
        if (providers.includes(0)) {
          setStep('twofa');
          setCode('');
        } else setLoginErr("This account uses a two-step method Litewarden can't do yet (only authenticator apps for now). Use the web vault, or add an authenticator app to the account.");
      } else if (e.name === 'WrongTwoFactorCode') {
        setLoginErr(e.message);
        setCode('');
        setStep('twofa');
      } else if (e.name === 'WrongPassword') {
        setLoginErr('The email or master password is wrong. Check Caps Lock and try again.');
        setStep('login');
      } else {
        setLoginErr(e.message);
        if (step === 'done') setStep('login');
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (progress?.phase === 'done') setFinal(`${progress.done.toLocaleString()} items ready. Nothing left your browser unencrypted.`);
  }, [progress]);

  const top = (
    <>
      <div class="fr-top">
        <Keep />
        Litewarden{stepNo < 4 && <span class="step">Step {stepNo} of 3</span>}
      </div>
      {stepNo < 4 && (
        <div class="bar3">
          {[1, 2, 3].map((n) => (
            <i class={n <= stepNo ? 'on' : ''} />
          ))}
        </div>
      )}
    </>
  );

  if (step === 'cloud')
    return (
      <div class="fr">
        {top}
        <h2>Bitwarden cloud</h2>
        <p class="lead">Litewarden is built for self-hosted Vaultwarden. It also works with Bitwarden's cloud, but that's tested less.</p>
        <div class="field">
          <span class="l">Region</span>
          <div class="seg full">
            {(['US', 'EU'] as const).map((r) => (
              <button aria-pressed={region === r} onClick={() => setRegion(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <div class="note">
          <Info />
          <div>Pick the region your account was created in. If you sign in at vault.bitwarden.eu, choose EU.</div>
        </div>
        <div class="grow" />
        <button
          class="btn wide"
          onClick={() => {
            const u = region === 'US' ? 'https://vault.bitwarden.com' : 'https://vault.bitwarden.eu';
            setUrl(u);
            setFound({ url: u, name: 'Bitwarden', apiVersion: null, version: null, isVaultwarden: false, tooOld: false });
            setStep('login');
          }}
        >
          Continue
        </button>
        <button class="btn ghost wide" onClick={() => setStep('url')}>
          Use a self-hosted server
        </button>
      </div>
    );

  if (step === 'url')
    return (
      <form class="fr" onSubmit={(e) => (e.preventDefault(), found ? setStep('login') : void check())}>
        {top}
        <h2>Where is your vault?</h2>
        <p class="lead">Enter your Vaultwarden server. Litewarden only ever talks to this server.</p>
        <label class={`field${urlErr ? ' err' : ''}`}>
          <span class="l">Server address</span>
          <span class="inp">
            <input
              id="url"
              value={url}
              inputMode="url"
              autocomplete="url"
              spellcheck={false}
              data-af
              onInput={(e) => {
                setUrl((e.currentTarget as HTMLInputElement).value);
                setFound(null);
                setUrlErr(null);
              }}
            />
          </span>
          <span class="f-msg">
            {urlErr ? <CircleAlert /> : <Info />}
            <span>
              {urlErr ? urlErr.text : 'The address you open your web vault at.'}
              {urlErr?.kind === 'old' && (
                <>
                  {' '}
                  <a class="link" href="https://github.com/dani-garcia/vaultwarden/releases" target="_blank" rel="noopener">
                    Update Vaultwarden
                  </a>
                  , then try again.
                </>
              )}
            </span>
          </span>
        </label>
        {found && (
          <div class="found">
            <span class="si">
              <Server />
            </span>
            <div>
              <b>
                {found.name}
                {found.version ? ` ${found.version}` : ''}
              </b>
              <span>
                {host(found.url)}
                {found.apiVersion ? ` · API ${found.apiVersion}` : ''}
              </span>
            </div>
            <span class="ok">
              <CircleCheck />
            </span>
          </div>
        )}
        <div class="grow" />
        {found ? (
          <button class="btn wide" type="submit" data-af>
            Continue
          </button>
        ) : (
          <Busy class="btn wide" type="submit" busy={busy} label="Checking server…">
            Check server
          </Busy>
        )}
        <button type="button" class="btn ghost wide" onClick={() => setStep('cloud')}>
          I use Bitwarden cloud
        </button>
        <p class="small">No analytics, no telemetry. Free and open source under GPLv3.</p>
      </form>
    );

  if (step === 'login')
    return (
      <form class="fr" onSubmit={(e) => (e.preventDefault(), void signIn())}>
        {top}
        <h2>Sign in</h2>
        <p class="lead">to {host(server)}</p>
        <label class="field">
          <span class="l">Email</span>
          <span class="inp">
            <input id="em" type="email" autocomplete="username" value={email} data-af={!email || undefined} onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)} />
          </span>
        </label>
        <label class={`field${loginErr ? ' err' : ''}`}>
          <span class="l">Master password</span>
          <span class="inp">
            <input
              id="pw"
              {...({ type: reveal ? 'text' : 'password' } as { type: 'password' })}
              autocomplete="current-password"
              value={pw}
              data-af={!!email || undefined}
              onInput={(e) => setPw((e.currentTarget as HTMLInputElement).value)}
            />
            <button type="button" class="ib" aria-label={reveal ? 'Hide password' : 'Show password'} onClick={() => setReveal(!reveal)}>
              {reveal ? <EyeOff /> : <Eye />}
            </button>
          </span>
          <span class="f-msg">
            {loginErr ? <CircleAlert /> : <LockKeyhole />}
            <span>{loginErr ?? 'Your master password is never sent to the server, only a hash of it.'}</span>
          </span>
        </label>
        <div class="grow" />
        <Busy class="btn wide" type="submit" busy={busy} label="Signing in…">
          Sign in
        </Busy>
        <button type="button" class="btn ghost wide" onClick={() => (setStep('url'), setLoginErr(null))}>
          Change server
        </button>
      </form>
    );

  if (step === 'twofa')
    return (
      <form class="fr" onSubmit={(e) => (e.preventDefault(), void signIn({ provider: 0, token: code, remember }))}>
        {top}
        <h2>Two-step login</h2>
        <p class="lead">Enter the 6-digit code from your authenticator app for {email.trim()}.</p>
        <div class={`field${loginErr ? ' err' : ''}`}>
          <CodeBoxes cls="code6" label="Code" value={code} onChange={setCode} autoFocus onComplete={(c) => void signIn({ provider: 0, token: c, remember })} />
          {loginErr && (
            <span class="f-msg">
              <CircleAlert />
              <span>{loginErr}</span>
            </span>
          )}
        </div>
        <label class="chk">
          Remember this browser for 30 days
          <span class="sw">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.currentTarget as HTMLInputElement).checked)} />
            <i />
          </span>
        </label>
        <div class="grow" />
        <Busy class="btn wide" type="submit" busy={busy} label="Verifying…" disabled={code.length < 6}>
          Verify
        </Busy>
        <button type="button" class="btn ghost wide" onClick={() => (setStep('login'), setLoginErr(null))}>
          Back
        </button>
      </form>
    );

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div class="fr">
      <div class="fr-top">
        <Keep />
        Litewarden
      </div>
      <div class="fr-done">
        <span class="big">
          <Check />
        </span>
        <h2>You're in</h2>
        <p class="lead" id="syncmsg">
          {final ??
            (progress?.phase === 'decrypt'
              ? `Decrypting ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} items`
              : 'Downloading your vault…')}
        </p>
        <div class="prog">
          <i style={{ width: `${final ? 100 : pct}%` }} />
        </div>
        {loginErr && <p class="lead" style={{ color: 'var(--low)' }}>{loginErr}</p>}
      </div>
      <button class="btn wide" id="open" disabled={!ready} onClick={onDone} data-af={ready || undefined}>
        Open Litewarden
      </button>
      <p class="small">Tip: press Ctrl Shift L on any page to open Litewarden with search ready.</p>
    </div>
  );
}
