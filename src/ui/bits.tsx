// SPDX-License-Identifier: GPL-3.0-only
// Small shared UI pieces: the Keep mark, site tiles (favicons from the user's own server), the toast with an
// honest clipboard countdown, busy buttons and the 6-box code input.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CreditCard, IdCard, StickyNote, Wallet } from 'lucide-preact';
import { brandKey } from '../core/cards';
import { serverUrls } from '../core/api';
import { parseLoose } from '../core/uri';
import { networkById } from '../core/wallet';
import type { IndexItem } from '../shared/store';
import { mem } from '../shared/store';

export function Keep({ class: cls = 'keep' }: { class?: string }) {
  return (
    <svg class={cls} viewBox="56.4 3.4 87.2 178.2" aria-hidden="true">
      <path
        fill="currentColor"
        fill-rule="evenodd"
        d="M65 10L79.667 10A2 2 0 0 1 81.667 12L81.667 24A2 2 0 0 0 83.667 26L88.667 26A2 2 0 0 0 90.667 24L90.667 12A2 2 0 0 1 92.667 10L107.333 10A2 2 0 0 1 109.333 12L109.333 24A2 2 0 0 0 111.333 26L116.333 26A2 2 0 0 0 118.333 24L118.333 12A2 2 0 0 1 120.333 10L135 10A2 2 0 0 1 137 12L137 53.172A2 2 0 0 1 136.414 54.586L114.101 76.899A14 14 0 0 0 110 86.799L110 99.431A14 14 0 0 0 117 111.555A34 34 0 1 1 83 111.555A14 14 0 0 0 90 99.431L90 86.799A14 14 0 0 0 85.899 76.899L63.586 54.586A2 2 0 0 1 63 53.172L63 12A2 2 0 0 1 65 10ZM81 141A19 19 0 1 0 119 141A19 19 0 1 0 81 141Z"
      />
    </svg>
  );
}

// ---------- favicons ----------

type IconMap = Record<string, string>;
let icons: IconMap = {};
let iconServer = '';
let fallback: Promise<string> | null = null;
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

async function toDataUrl(r: Response): Promise<string> {
  const b = await r.blob();
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.readAsDataURL(b);
  });
}

let markReady: () => void;
// Tiles can mount before initIcons has the server and the cache; their loads wait for this.
const ready = new Promise<void>((r) => (markReady = r));

/** Call once per popup open with the cached icons and the account's server. */
export async function initIcons(server: string) {
  // Self-hosted: <server>/icons; Bitwarden cloud: its icons host.
  iconServer = serverUrls(server).icons;
  const cached = (await mem.get('iconCache')).iconCache ?? {};
  // Keep anything fetched while the cache was being read.
  icons = { ...cached, ...icons };
  listeners.forEach((l) => l());
  markReady();
}

let saveTimer = 0;
function remember(domain: string, url: string) {
  icons = { ...icons, [domain]: url };
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void mem.set({ iconCache: icons }), 400);
}

/** The server answers unknown domains with the same fallback image; that one counts as "no icon". */
function fallbackIcon(): Promise<string> {
  fallback ??= icons.__fallback
    ? Promise.resolve(icons.__fallback)
    : fetch(`${iconServer}/invalid.invalid/icon.png`, { credentials: 'omit' })
        .then((r) => (r.ok ? toDataUrl(r) : ''))
        .then((u) => (remember('__fallback', u), u))
        .catch(() => '');
  return fallback;
}

function loadIcon(domain: string) {
  if (domain in icons || inflight.has(domain)) return;
  inflight.set(
    domain,
    (async () => {
      try {
        await ready;
        if (domain in icons || !iconServer) return;
        const r = await fetch(`${iconServer}/${encodeURIComponent(domain)}/icon.png`, { credentials: 'omit' });
        const url = r.ok && /^image\//.test(r.headers.get('content-type') ?? '') ? await toDataUrl(r) : '';
        remember(domain, url && url !== (await fallbackIcon()) ? url : '');
      } catch {
        remember(domain, '');
      } finally {
        inflight.delete(domain);
      }
    })(),
  );
}

function useIcon(domain: string | null): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (!domain) return;
    const l = () => force((n) => n + 1);
    listeners.add(l);
    loadIcon(domain);
    return () => void listeners.delete(l);
  }, [domain]);
  return domain ? (icons[domain] ?? '') : '';
}

/** A card's brand, drawn (no image files): Visa, Mastercard, Amex, Discover, a short name for the rest. */
export function BrandMark({ brand, class: cls = '' }: { brand: string | null | undefined; class?: string }) {
  const k = brandKey(brand);
  const text: Partial<Record<string, string>> = { visa: 'VISA', amex: 'AMEX', diners: 'DC', jcb: 'JCB', unionpay: 'UP' };
  if (k === 'other')
    return (
      <span class={`tile ${cls}`} aria-hidden="true">
        <CreditCard />
      </span>
    );
  return (
    <span class={`tile bt bt-${k} ${cls}`} title={brand ?? ''} aria-hidden="true">
      {text[k] ? <b>{text[k]}</b> : <i />}
    </span>
  );
}

/** A wallet's network logo (bundled with the extension), or a wallet icon for a network we don't know. */
export function Coin({ network, class: cls = '' }: { network: string | null | undefined; class?: string }) {
  const n = networkById(network);
  return n ? (
    <span class={`tile coin ${cls}`} title={n.name} aria-hidden="true">
      <img src={`/coins/${n.id}.svg`} alt="" />
    </span>
  ) : (
    <span class={`tile ${cls}`} aria-hidden="true">
      <Wallet />
    </span>
  );
}

export function Tile({ item }: { item: IndexItem }) {
  const src = useIcon(item.type === 1 ? item.domain : null);
  if (item.type === 3) return <BrandMark brand={item.brand} />;
  if (item.wallet) return <Coin network={item.wallet.network} />;
  if (src)
    return (
      <span class="tile fav">
        <img src={src} alt="" />
      </span>
    );
  return (
    <span class="tile" aria-hidden="true">
      {item.type === 2 ? <StickyNote /> : item.type === 4 ? <IdCard /> : (item.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A site's name with its favicon in front, wherever a site is named. Just the name until the icon loads, or if
 * the server has none. */
export function Site({ host }: { host: string | null | undefined }) {
  const domain = host ? (parseLoose(host)?.hostname.toLowerCase() ?? null) : null;
  const src = useIcon(domain);
  return (
    <span class="site">
      {src && <img src={src} alt="" />}
      {host}
    </span>
  );
}

/** Just the favicon, or `fallback` until it loads or when the server has none. */
export function Favicon({ host, fallback }: { host: string; fallback: ComponentChildren }) {
  const src = useIcon(parseLoose(host)?.hostname.toLowerCase() ?? null);
  return src ? <img class="favicon" src={src} alt="" /> : <>{fallback}</>;
}

/** The account's picture: its email domain's favicon (Vaultwarden has no avatars), else its first letter. */
export function Avatar({ email }: { email: string }) {
  const src = useIcon(email.split('@')[1]?.toLowerCase() || null);
  return (
    <span class={`av${src ? ' fav' : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : (email[0] ?? '?').toUpperCase()}
    </span>
  );
}

// ---------- toast ----------

export interface ToastState {
  msg: ComponentChildren;
  secs: number;
  key: number;
}

export function useToast() {
  const [t, setT] = useState<ToastState | null>(null);
  const show = (msg: ComponentChildren, secs = 0) => setT({ msg, secs, key: Date.now() });
  return { toast: t, show, hide: () => setT(null) };
}

export function Toast({ t, onDone }: { t: ToastState | null; onDone: () => void }) {
  const [left, setLeft] = useState(0);
  const [cleared, setCleared] = useState(false);
  useEffect(() => {
    if (!t) return;
    setLeft(t.secs);
    setCleared(false);
    if (!t.secs) {
      const h = setTimeout(onDone, 2600);
      return () => clearTimeout(h);
    }
    const start = Date.now();
    const h = setInterval(() => {
      const l = t.secs - Math.floor((Date.now() - start) / 1000);
      setLeft(Math.max(0, l));
      if (l <= 0) {
        clearInterval(h);
        setCleared(true);
        setTimeout(onDone, 1500);
      }
    }, 250);
    return () => clearInterval(h);
  }, [t?.key]);
  if (!t) return <div id="toast" role="status" />;
  return (
    <div id="toast" class="show" role="status">
      <span class="t-msg">{cleared ? 'Clipboard cleared' : t.msg}</span>
      {!cleared && t.secs > 0 && <span class="t-time">Clears in {left} s</span>}
    </div>
  );
}

// ---------- busy button ----------

export function Busy({ busy, label, children, ...rest }: { busy: boolean; label: string; children: ComponentChildren } & Omit<JSX.IntrinsicElements['button'], 'children' | 'label'>) {
  return (
    <button {...rest} disabled={busy || rest.disabled} aria-busy={busy}>
      {busy ? (
        <>
          <span class="spinner" aria-hidden="true" />
          {label}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ---------- 6-box code input (PIN, two-step code) ----------

export function CodeBoxes({
  value,
  onChange,
  onComplete,
  cls,
  label,
  autoFocus,
  disabled,
  mask,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  cls: string;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** A PIN: each digit shows briefly as it's typed, then turns into a dot. */
  mask?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const [shown, setShown] = useState(-1);
  const shownTimer = useRef(0);
  useEffect(() => () => clearTimeout(shownTimer.current), []);
  // Focus on mount, and again when the boxes come back from disabled (a wrong PIN clears and re-enables them).
  useEffect(() => {
    if (autoFocus && !disabled) refs.current[Math.min(value.length, 5)]?.focus();
  }, [autoFocus, disabled]);
  // After a wrong code the boxes are cleared: start again from the first one.
  useEffect(() => {
    if (autoFocus && !disabled && value === '') refs.current[0]?.focus();
  }, [value === '']);
  const set = (v: string) => {
    const clean = v.replace(/\D/g, '').slice(0, 6);
    if (mask) {
      clearTimeout(shownTimer.current);
      setShown(clean.length > value.length ? clean.length - 1 : -1);
      shownTimer.current = window.setTimeout(() => setShown(-1), 800);
    }
    onChange(clean);
    refs.current[Math.min(clean.length, 5)]?.focus();
    if (clean.length === 6) onComplete?.(clean);
  };
  return (
    <div class={cls}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          class={mask && i !== shown ? 'masked' : undefined}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autocomplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={6}
          aria-label={`${label} digit ${i + 1}`}
          value={value[i] ?? ''}
          disabled={disabled}
          onInput={(e) => {
            const typed = (e.currentTarget as HTMLInputElement).value.replace(/\D/g, '');
            // Typing or pasting into box i replaces from i onward.
            set(value.slice(0, i) + typed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) {
              e.preventDefault();
              set(value.slice(0, i - 1));
            }
          }}
          onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
      ))}
    </div>
  );
}

export function ago(ms: number | undefined | null): string {
  if (!ms) return 'Not synced yet';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'Synced just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Synced ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Synced ${h} h ago`;
  return `Synced ${Math.round(h / 24)} d ago`;
}
