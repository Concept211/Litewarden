// SPDX-License-Identifier: GPL-3.0-only
// Settings, r4 variant B: a list of categories, then one page per category. Every setting has an icon and a
// one-line description, and takes effect the moment it changes.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowLeft,
  Bug,
  BellOff,
  Crosshair,
  EyeOff,
  MousePointerClick,
  Save,
  TextCursorInput,
  X,
  ChevronRight,
  ClipboardX,
  Clock,
  CodeXml,
  ExternalLink,
  Frame,
  Globe,
  Grid3x3,
  Info,
  Keyboard,
  List,
  Lock,
  LogOut,
  PencilLine,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Rows3,
  Scaling,
  ShieldAlert,
  ShieldCheck,
  SunMoon,
  Timer,
  UserRound,
} from 'lucide-preact';
import { RemoteError, send } from '../../shared/messages';
import type { SiteRule } from '../../shared/rules';
import { POPUP_SIZES, type LiveState, type Settings } from '../../shared/store';
import { Busy, CodeBoxes, ago } from '../../ui/bits';
import { HelpRows } from '../../ui/help';
import type { Boot } from './boot';

export const SOURCE_URL = 'https://github.com/Concept211/Litewarden';

type Page = 'home' | 'autofill' | 'security' | 'keyboard' | 'shortcuts' | 'appearance' | 'sync' | 'account' | 'about' | 'iconsites' | 'neversites' | 'rules';
const SUB: Partial<Record<Page, Page>> = { shortcuts: 'keyboard', iconsites: 'autofill', neversites: 'autofill', rules: 'autofill' };

function Row({ icon, title, desc, children, onClick }: { icon: ComponentChildren; title: string; desc: ComponentChildren; children?: ComponentChildren; onClick?: () => void }) {
  return (
    <div
      class={`set${onClick ? ' link-row' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
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

function Seg<T extends string>({ value, options, label, onChange }: { value: T; options: Array<[T, string]>; label: string; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" role="radio" aria-checked={v === value} aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

const mins = (m: number) => (m === 0 ? 'Never' : m < 60 ? `${m} min` : `${m / 60} hour${m > 60 ? 's' : ''}`);
const LIVE_TEXT: Record<LiveState['status'], string> = {
  connected: 'Connected. Changes from your other devices arrive within seconds.',
  connecting: 'Connecting…',
  unavailable: "Your server didn't accept a live connection, so Litewarden checks on the timer below.",
  error: 'The connection dropped. Litewarden retries on its own and checks on the timer meanwhile.',
  off: 'Off. Litewarden checks on the timer below.',
};

export function SettingsView({ boot: b, onBack, onLoggedOut }: { boot: Boot; onBack: () => void; onChanged?: () => void; onLoggedOut: () => void }) {
  const [page, setPage] = useState<Page>('home');
  const [s, setS] = useState(b.settings);
  const [pinOn, setPinOn] = useState(b.pinEnabled);
  const [sheet, setSheet] = useState<'pin' | 'logout' | null>(null);
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [lastSync, setLastSync] = useState(b.lastSync);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [defUser, setDefUser] = useState(b.settings.defaultUsername);
  const [rules, setRules] = useState<Record<string, SiteRule> | null>(null);
  useEffect(() => void send('siteRules').then(setRules).catch(() => setRules({})), [page === 'rules' || page === 'autofill']);

  const toast = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved((m) => (m === msg ? null : m)), 1800);
  };
  const save = async (patch: Partial<Settings>, msg = 'Saved') => {
    setS((cur) => ({ ...cur, ...patch }));
    try {
      setS(await send('setSettings', patch));
      toast(msg);
    } catch (e) {
      toast((e as RemoteError).message);
    }
  };

  useEffect(() => {
    void send('liveState').then(setLive).catch(() => {});
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && ch.live) setLive((ch.live.newValue as LiveState) ?? null);
      if (area === 'local' && ch.lastSync?.newValue) setLastSync(ch.lastSync.newValue as number);
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);

  // Esc goes up one level; from the category list it goes back to the vault. Reads the latest page through a
  // ref so two quick presses walk up two levels.
  const at = useRef({ page, sheet });
  at.current = { page, sheet };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const { page, sheet } = at.current;
      const up = (p: Page) => {
        at.current = { page: p, sheet: null };
        setPage(p);
      };
      if (sheet) {
        at.current = { page, sheet: null };
        return setSheet(null);
      }
      if (SUB[page]) return up(SUB[page]!);
      if (page !== 'home') return up('home');
      onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Keyboard users land on the first control of a new page, unless something already has focus.
  useEffect(() => {
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a)) return;
    (document.querySelector('.body .link-row, .body input, .body select, .body .seg button') as HTMLElement | null)?.focus();
  }, [page]);

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
      toast('PIN unlock is on');
    } catch (e) {
      setPinErr((e as RemoteError).message);
    }
  }

  async function syncNow() {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const r = await send('sync');
      setLastSync(Date.now());
      setSyncMsg(`${r.count.toLocaleString()} items. ${r.changed ? `${r.changed} changed.` : 'Nothing changed.'}`);
    } catch (e) {
      setSyncMsg(`Didn't work: ${(e as RemoteError).message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  const hostName = b.account?.server.replace(/^https?:\/\//, '') ?? '';
  const ver = b.account?.serverInfo.version ? `${b.account.serverInfo.name} ${b.account.serverInfo.version}` : (b.account?.serverInfo.name ?? '');
  const { version, version_name } = chrome.runtime.getManifest();
  // "0.1.0-beta" reads as "0.1.0 beta".
  const shownVersion = (version_name ?? version).replace('-', ' ');
  const liveWord = !s.liveSync ? 'Live updates off' : live?.status === 'connected' ? 'Live' : live?.status === 'connecting' ? 'Connecting' : 'Timer only';

  const CATS: Array<[Exclude<Page, 'home' | 'shortcuts'>, string, ComponentChildren, string]> = [
    ['autofill', 'Autofill', <PencilLine />, `Field icon ${s.fieldIcon ? 'on' : 'off'}, save prompts ${s.savePrompt ? 'on' : 'off'}, 2FA copy ${s.copyTotpAfterFill ? 'on' : 'off'}`],
    ['security', 'Security', <ShieldCheck />, `Locks after ${mins(s.lockMinutes)}${s.lockOnClose ? ' and on close' : ''}, PIN ${pinOn ? 'on' : 'off'}`],
    ['keyboard', 'Keyboard', <Keyboard />, 'Shortcuts and how to change them'],
    ['appearance', 'Appearance', <SunMoon />, `${s.theme === 'system' ? 'System' : s.theme === 'dark' ? 'Dark' : 'Light'} theme, ${POPUP_SIZES[s.popupSize].label.toLowerCase()} size, ${s.density}`],
    ['sync', 'Sync', <RefreshCw />, `${ago(lastSync)}. ${liveWord}`],
    ['account', 'Account', <UserRound />, `${b.account?.email ?? ''} on ${hostName}`],
    ['about', 'About', <Info />, `Version ${shownVersion}, GPLv3`],
  ];
  const SUBTITLE: Partial<Record<Page, string>> = { shortcuts: 'All shortcuts', iconsites: 'Sites without the icon', neversites: 'Never asks to save', rules: 'Site rules' };
  const title = page === 'home' ? 'Settings' : (SUBTITLE[page] ?? CATS.find(([k]) => k === page)![1]);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const ruleCount = Object.keys(rules ?? {}).length;
  const NOTE = <p class="about">Works with Vaultwarden and Bitwarden servers. Not affiliated with Bitwarden, Inc. or the Vaultwarden project.</p>;

  let body: ComponentChildren;
  if (page === 'home')
    body = (
      <>
        <div class="group">
          {CATS.map(([k, t, ic, d]) => (
            <div class="set link-row cat" role="button" tabIndex={0} data-cat={k} onClick={() => setPage(k)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setPage(k))}>
              <span class="si">{ic}</span>
              <span class="st-t">
                <b>{t}</b>
                <span>{d}</span>
              </span>
              <span class="chev">
                <ChevronRight />
              </span>
            </div>
          ))}
        </div>
        {NOTE}
      </>
    );
  else if (page === 'iconsites' || page === 'neversites') {
    const key = page === 'iconsites' ? 'iconOffSites' : 'neverSaveSites';
    const list = s[key];
    body = list.length ? (
      <div class="group" data-list={key}>
        {list.map((h) => (
          <Row icon={<Globe />} title={h} desc={page === 'iconsites' ? 'No icon in its login fields' : 'Litewarden never offers to save here'}>
            <button class="ib" aria-label={`Remove ${h}`} title="Remove" onClick={() => void save({ [key]: list.filter((x) => x !== h) } as Partial<Settings>, 'Removed')}>
              <X />
            </button>
          </Row>
        ))}
      </div>
    ) : (
      <p class="about">{page === 'iconsites' ? 'Every site shows the icon. Use "Hide here" in the in-page menu to turn it off for one site.' : 'No sites. "Never for this site" on a save prompt adds one here.'}</p>
    );
  } else if (page === 'rules')
    body = ruleCount ? (
      <div class="group" data-list="rules">
        {Object.entries(rules!).map(([h, r]) => (
          <Row icon={<Crosshair />} title={h} desc={[r.username && `username ${r.username.label}`, r.password && `password ${r.password.label}`, r.totp && `2FA ${r.totp.label}`].filter(Boolean).join(', ')}>
            <button
              class="ib"
              aria-label={`Remove the rule for ${h}`}
              title="Remove"
              onClick={async () => {
                await send('removeRule', { host: h });
                setRules(await send('siteRules'));
                toast('Rule removed');
              }}
            >
              <X />
            </button>
          </Row>
        ))}
      </div>
    ) : (
      <p class="about">No rules yet. When Litewarden can't find a site's login fields, "Teach this site" lets you point at them once.</p>
    );
  else if (page === 'autofill')
    body = (
      <div class="group">
        <Row icon={<TextCursorInput />} title="Icon in login fields" desc="Click it to open the menu. Turn off to use only Alt+Shift+L and the toolbar button.">
          <Switch on={s.fieldIcon} label="Icon in login fields" onChange={(v) => void save({ fieldIcon: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<EyeOff />} title="Sites without the icon" desc={s.iconOffSites.length ? `${n(s.iconOffSites.length, 'site', 'sites')}. Remove one to bring the icon back there.` : 'None. "Hide here" in the menu adds a site.'} onClick={() => setPage('iconsites')}>
          <span class="chev">
            <ChevronRight />
          </span>
        </Row>
        <Row icon={<MousePointerClick />} title="Open the menu when a field gets focus" desc="Off: the menu opens only from the icon or Alt+Shift+L.">
          <Switch on={s.menuOnFocus} label="Open the menu when a field gets focus" onChange={(v) => void save({ menuOnFocus: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<Save />} title="Offer to save logins" desc="After you sign in with a new login or a changed password.">
          <Switch on={s.savePrompt} label="Offer to save logins" onChange={(v) => void save({ savePrompt: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<BellOff />} title="Sites that never ask to save" desc={s.neverSaveSites.length ? n(s.neverSaveSites.length, 'site', 'sites') : 'None'} onClick={() => setPage('neversites')}>
          <span class="chev">
            <ChevronRight />
          </span>
        </Row>
        <Row icon={<Crosshair />} title="Site rules" desc={ruleCount ? `${n(ruleCount, 'site', 'sites')} taught by hand: ${Object.keys(rules!).slice(0, 2).join(', ')}${ruleCount > 2 ? '…' : ''}` : 'None. Taught with "Teach this site".'} onClick={() => setPage('rules')}>
          <span class="chev">
            <ChevronRight />
          </span>
        </Row>
        <Row icon={<Timer />} title="Copy the 2FA code after filling" desc="Ready to paste on the next page. Cleared with the clipboard.">
          <Switch on={s.copyTotpAfterFill} label="Copy the 2FA code after filling" onChange={(v) => void save({ copyTotpAfterFill: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<Frame />} title="Ask before filling embedded forms" desc="For login forms loaded from another site inside the page.">
          <Switch on={s.askFrames} label="Ask before filling embedded forms" onChange={(v) => void save({ askFrames: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <div class="set stack">
          <span class="si">
            <UserRound />
          </span>
          <span class="st-t">
            <b>Default username</b>
            <span>New logins start with this. Empty uses {b.account?.email ?? 'your account email'}.</span>
            <span class="inp sm">
              <input
                aria-label="Default username"
                value={defUser}
                placeholder={b.account?.email ?? ''}
                spellcheck={false}
                onInput={(e) => setDefUser((e.currentTarget as HTMLInputElement).value)}
                onBlur={() => defUser !== s.defaultUsername && void save({ defaultUsername: defUser.trim() })}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              />
            </span>
          </span>
        </div>
      </div>
    );
  else if (page === 'security')
    body = (
      <div class="group">
        <Row icon={<Lock />} title="Lock after" desc="How long Litewarden can sit unused before it locks.">
          <select class="sel" aria-label="Lock after" value={s.lockMinutes} onChange={(e) => void save({ lockMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {[1, 5, 15, 30, 60, 240].map((m) => (
              <option value={m}>{mins(m)}</option>
            ))}
            <option value={0}>Never</option>
          </select>
        </Row>
        <Row icon={<Power />} title="Lock when the browser closes" desc="Works on its own, separate from the timer. Off keeps the key on this device across restarts.">
          <Switch on={s.lockOnClose} label="Lock when the browser closes" onChange={(v) => void save({ lockOnClose: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<ClipboardX />} title="Clear the clipboard after" desc="Copied passwords and codes get wiped.">
          <select class="sel" aria-label="Clear the clipboard after" value={s.clipboardSeconds} onChange={(e) => void save({ clipboardSeconds: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {[10, 30, 60, 120, 300].map((n) => (
              <option value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>
            ))}
            <option value={0}>Never</option>
          </select>
        </Row>
        <Row icon={<Grid3x3 />} title="Unlock with a PIN" desc="6 digits instead of the master password.">
          <Switch
            on={pinOn}
            label="Unlock with a PIN"
            onChange={async (v) => {
              if (v) {
                setPin1('');
                setPin2('');
                setPinErr(null);
                setSheet('pin');
              } else {
                await send('setPin', { pin: null });
                setPinOn(false);
                toast('PIN unlock is off');
              }
            }}
          />
        </Row>
        <Row icon={<RotateCcw />} title="Keep the PIN after a restart" desc="Off: after the browser restarts, use the master password once. On: the PIN-wrapped key is stored on this device.">
          <Switch on={s.pinSurvivesRestart} label="Keep the PIN after a restart" disabled={!pinOn} onChange={(v) => void save({ pinSurvivesRestart: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
      </div>
    );
  else if (page === 'keyboard')
    body = (
      <div class="group">
        <Row icon={<Keyboard />} title="Change shortcuts" desc="Open: Ctrl Shift L. Chrome keeps the list; change it there." onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
          <span class="chev">
            <ExternalLink />
          </span>
        </Row>
        <Row icon={<List />} title="All shortcuts" desc="Fill, copy username, password and code, open an item." onClick={() => setPage('shortcuts')}>
          <span class="chev">
            <ChevronRight />
          </span>
        </Row>
      </div>
    );
  else if (page === 'shortcuts')
    body = (
      <div class="group pad">
        <HelpRows />
      </div>
    );
  else if (page === 'appearance')
    body = (
      <div class="group">
        <Row icon={<SunMoon />} title="Theme" desc="System follows your computer.">
          <Seg
            label="Theme"
            value={s.theme}
            options={[
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ]}
            onChange={(v) => void save({ theme: v })}
          />
        </Row>
        <Row icon={<Scaling />} title="Popup size" desc="Wider shows longer names.">
          <select class="sel" aria-label="Popup size" value={s.popupSize} onChange={(e) => void save({ popupSize: (e.currentTarget as HTMLSelectElement).value as Settings['popupSize'] })}>
            {(Object.keys(POPUP_SIZES) as Array<Settings['popupSize']>).map((k) => (
              <option value={k}>{POPUP_SIZES[k].label}</option>
            ))}
          </select>
        </Row>
        <Row icon={<Rows3 />} title="Density" desc="Compact fits more logins on screen.">
          <Seg
            label="Density"
            value={s.density}
            options={[
              ['roomy', 'Roomy'],
              ['compact', 'Compact'],
            ]}
            onChange={(v) => void save({ density: v })}
          />
        </Row>
      </div>
    );
  else if (page === 'sync')
    body = (
      <div class="group">
        <Row icon={<RefreshCw />} title="Last synced" desc={<span id="ls">{syncMsg ?? ago(lastSync).replace('Synced ', '')}</span>}>
          <Busy busy={syncBusy} label="Syncing" class="btn sec" onClick={syncNow}>
            Sync now
          </Busy>
        </Row>
        <Row icon={<Radio />} title="Live updates" desc={<span data-live={s.liveSync ? (live?.status ?? 'off') : 'off'}>{LIVE_TEXT[s.liveSync ? (live?.status ?? 'connecting') : 'off']}</span>}>
          <Switch on={s.liveSync} label="Live updates" onChange={(v) => void save({ liveSync: v }, v ? 'Turned on' : 'Turned off')} />
        </Row>
        <Row icon={<Clock />} title="Check for changes every" desc="Also catches anything live updates missed.">
          <select class="sel" aria-label="Check for changes every" value={s.syncMinutes} onChange={(e) => void save({ syncMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {[5, 15, 30, 60].map((m) => (
              <option value={m}>{mins(m)}</option>
            ))}
            <option value={0}>Never</option>
          </select>
        </Row>
      </div>
    );
  else if (page === 'account')
    body = (
      <div class="group">
        <Row icon={<UserRound />} title={b.account?.email ?? ''} desc={`${hostName}${ver ? ` · ${ver}` : ''}`}>
          <button class="btn sec" onClick={() => setSheet('logout')}>
            Log out
          </button>
        </Row>
        {b.kdfWeak.length > 0 && (
          <Row icon={<ShieldAlert />} title="Weak encryption settings" desc={`${b.kdfWeak.join('. ')}. Raise them in the web vault under Account security. Your master password stays the same.`} />
        )}
        <Row icon={<Globe />} title="Open the web vault" desc="For things Litewarden doesn't do yet: attachments, sharing, two-step setup." onClick={() => void chrome.tabs.create({ url: b.account?.server ?? '' })}>
          <span class="chev">
            <ExternalLink />
          </span>
        </Row>
      </div>
    );
  else if (page === 'about')
    body = (
      <>
        <div class="group">
          <Row icon={<Info />} title={`Litewarden ${shownVersion}`} desc="What changed in this version" onClick={() => void chrome.tabs.create({ url: `${SOURCE_URL}/releases` })}>
            <span class="chev">
              <ExternalLink />
            </span>
          </Row>
          <Row icon={<Bug />} title="Report a bug" desc="Litewarden is in beta. Tell us what broke on GitHub." onClick={() => void chrome.tabs.create({ url: `${SOURCE_URL}/issues/new/choose` })}>
            <span class="chev">
              <ExternalLink />
            </span>
          </Row>
          <Row icon={<CodeXml />} title="Free and open source" desc="GPLv3. Read the code on GitHub." onClick={() => void chrome.tabs.create({ url: SOURCE_URL })}>
            <span class="chev">
              <ExternalLink />
            </span>
          </Row>
        </div>
        {NOTE}
      </>
    );

  return (
    <div class="scr settings">
      <div class="hdr">
        <button class="ib" aria-label="Back" title="Back (Esc)" onClick={() => (page === 'home' ? onBack() : setPage(SUB[page] ?? 'home'))}>
          <ArrowLeft />
        </button>
        <h1>{title}</h1>
      </div>
      <div class="body" data-page={page}>
        {body}
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
                <CodeBoxes cls="pin" mask label="New PIN" value={pin1} onChange={(v) => (setPin1(v), setPinErr(null))} autoFocus />
              ) : (
                <CodeBoxes key="again" cls="pin" mask label="Repeat PIN" value={pin2} onChange={(v) => (setPin2(v), setPinErr(null))} autoFocus />
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
            <p>This removes the encrypted vault copy and your PIN from this browser. Your items stay on {hostName}. You'll need your master password to sign back in.</p>
            <div class="c-actions">
              <button class="btn sec" onClick={() => setSheet(null)}>
                Cancel
              </button>
              <button
                class="btn danger"
                onClick={async () => {
                  await send('logout');
                  onLoggedOut();
                }}
              >
                <LogOut />
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
