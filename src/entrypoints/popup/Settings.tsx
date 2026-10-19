// SPDX-License-Identifier: GPL-3.0-only
// Settings, first slice: security, autofill and account. Every setting has an icon and a one-line description.
// (The full category layout from r4, variant B, replaces this page in M2b part 2.)
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ArrowLeft, ClipboardX, Clock, Grid3x3, LogOut, Power, RotateCcw, Server, Timer } from 'lucide-preact';
import { RemoteError, send } from '../../shared/messages';
import type { Settings } from '../../shared/store';
import { CodeBoxes } from '../../ui/bits';
import type { Boot } from './boot';

function Row({ icon, title, desc, children, onClick }: { icon: ComponentChildren; title: string; desc: string; children?: ComponentChildren; onClick?: () => void }) {
  return (
    <div class={`set${onClick ? ' link-row' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
      <span class="si">{icon}</span>
      <span class="st-t">
        <b>{title}</b>
        <span>{desc}</span>
      </span>
      {children}
    </div>
  );
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="sw">
      <input type="checkbox" role="switch" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <i />
    </label>
  );
}

export function SettingsView({ boot: b, onBack, onChanged, onLoggedOut }: { boot: Boot; onBack: () => void; onChanged: () => void; onLoggedOut: () => void }) {
  const [s, setS] = useState(b.settings);
  const [pinOn, setPinOn] = useState(b.pinEnabled);
  const [sheet, setSheet] = useState<'pin' | 'logout' | null>(null);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (patch: Partial<Settings>, msg = 'Saved') => {
    setS({ ...s, ...patch });
    await send('setSettings', patch);
    setSaved(msg);
    setTimeout(() => setSaved(null), 1600);
    if ('theme' in patch) onChanged();
  };

  async function savePin() {
    if (pin1.length !== 6) return setPinErr('Enter 6 digits.');
    if (pin1 !== pin2) {
      setPin2('');
      return setPinErr("The two PINs don't match. Enter it again.");
    }
    try {
      await send('setPin', { pin: pin1 });
      setPinOn(true);
      setSheet(null);
      setSaved('PIN unlock is on');
      setTimeout(() => setSaved(null), 1600);
    } catch (e) {
      setPinErr((e as RemoteError).message);
    }
  }

  const ver = b.account?.serverInfo.version ? `${b.account.serverInfo.name} ${b.account.serverInfo.version}` : (b.account?.serverInfo.name ?? '');
  return (
    <div class="scr">
      <div class="hdr">
        <button class="ib" aria-label="Back" title="Back" onClick={onBack}>
          <ArrowLeft />
        </button>
        <h1>Settings</h1>
      </div>
      <div class="body">
        <div class="g-title">Security</div>
        <div class="group">
          <Row icon={<Grid3x3 />} title="PIN unlock" desc="Unlock with a 6-digit PIN instead of the master password.">
            <Switch
              on={pinOn}
              label="PIN unlock"
              onChange={async (v) => {
                if (v) {
                  setPin1('');
                  setPin2('');
                  setPinErr(null);
                  setSheet('pin');
                } else {
                  await send('setPin', { pin: null });
                  setPinOn(false);
                }
              }}
            />
          </Row>
          <Row icon={<RotateCcw />} title="Keep the PIN after a restart" desc="Off: after the browser restarts, use the master password once. On: the PIN-wrapped key is stored on this device.">
            <Switch on={s.pinSurvivesRestart} label="Keep the PIN after a restart" disabled={!pinOn} onChange={(v) => void save({ pinSurvivesRestart: v })} />
          </Row>
          <Row icon={<Timer />} title="Lock after" desc="How long Litewarden can sit unused before it locks.">
            <select class="sel" aria-label="Lock after" value={s.lockMinutes} onChange={(e) => void save({ lockMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
              {[1, 5, 15, 30, 60, 240].map((m) => (
                <option value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>
              ))}
              <option value={0}>Never</option>
            </select>
          </Row>
          <Row icon={<Power />} title="Lock when the browser closes" desc="Off keeps you unlocked across restarts. Less safe: the key then stays on this device.">
            <Switch on={s.lockOnClose} label="Lock when the browser closes" onChange={(v) => void save({ lockOnClose: v })} />
          </Row>
          <Row icon={<ClipboardX />} title="Clear the clipboard" desc="Copied passwords and codes are wiped from the clipboard after this long.">
            <select class="sel" aria-label="Clear the clipboard after" value={s.clipboardSeconds} onChange={(e) => void save({ clipboardSeconds: Number((e.currentTarget as HTMLSelectElement).value) })}>
              {[30, 60, 120, 300].map((n) => (
                <option value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>
              ))}
              <option value={0}>Never</option>
            </select>
          </Row>
        </div>
        <div class="g-title">Autofill</div>
        <div class="group">
          <Row icon={<Clock />} title="Copy the 2FA code after filling" desc="Ready to paste on the next page. Cleared with the clipboard.">
            <Switch on={s.copyTotpAfterFill} label="Copy the 2FA code after filling" onChange={(v) => void save({ copyTotpAfterFill: v })} />
          </Row>
        </div>
        <div class="g-title">Account</div>
        <div class="group">
          <Row icon={<Server />} title={b.account?.email ?? ''} desc={`${b.account?.server.replace(/^https?:\/\//, '') ?? ''}${ver ? ` · ${ver}` : ''}`} />
          <Row icon={<LogOut />} title="Log out" desc="Removes the vault copy and PIN from this browser." onClick={() => setSheet('logout')} />
        </div>
      </div>
      <div id="toast" class={saved ? 'show' : ''} role="status">
        {saved && <span class="t-msg">{saved}</span>}
      </div>
      {sheet === 'pin' && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <form class="h-card" aria-label="Set a PIN" onSubmit={(e) => (e.preventDefault(), void savePin())}>
            <div class="h-head">
              <b>Set a 6-digit PIN</b>
            </div>
            <p>{pin1.length < 6 ? 'Pick a PIN you don’t use anywhere else.' : 'Type it once more.'}</p>
            <div class={`field${pinErr ? ' err' : ''}`}>
              {pin1.length < 6 ? (
                <CodeBoxes cls="pin" label="New PIN" value={pin1} onChange={(v) => (setPin1(v), setPinErr(null))} autoFocus />
              ) : (
                <CodeBoxes key="again" cls="pin" label="Repeat PIN" value={pin2} onChange={(v) => (setPin2(v), setPinErr(null))} autoFocus />
              )}
              {pinErr && <span class="f-msg">{pinErr}</span>}
            </div>
            <div class="c-actions" style={{ marginTop: '12px' }}>
              <button type="button" onClick={() => setSheet(null)}>
                Cancel
              </button>
              <button type="submit" class="c-ok" disabled={pin2.length < 6}>
                Turn on PIN
              </button>
            </div>
          </form>
        </div>
      )}
      {sheet === 'logout' && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div class="h-card" role="dialog" aria-label="Log out">
            <div class="h-head">
              <b>Log out of {b.account?.email}?</b>
            </div>
            <p>This removes the encrypted vault copy and your PIN from this browser. You'll need your master password to sign in again.</p>
            <div class="c-actions">
              <button onClick={() => setSheet(null)}>Cancel</button>
              <button
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
