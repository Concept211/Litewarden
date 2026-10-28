// SPDX-License-Identifier: GPL-3.0-only
// Item view and editor (r4/item): live 2FA code, password strength, websites with their match type, notes;
// edit with the generator inline; new logins start with the default username and a generated password.
// A failed save never loses the edit: the form stays open with an error that says what to do.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Copy, CornerDownLeft, ExternalLink, Eye, EyeOff, Plus, RefreshCw, ScanLine, Trash2, TriangleAlert, WandSparkles, X } from 'lucide-preact';
import { CipherType, type FullItem, type ListUri } from '../../core/vault';
import { autoName, CARD_KEYS, IDENTITY_KEYS, type Draft } from '../../core/edit';
import { generatePassword, strength, GEN_MAX, GEN_MIN, type GenOptions } from '../../core/generator';
import { secondsRemaining, totp } from '../../core/totp';
import { iconDomain, launchUrl, parseLoose } from '../../core/uri';
import { validateDraft } from '../../core/edit';
import { CardForm, CardView, FieldsForm, FieldsView, IdentityForm, IdentityView, Kv, Switch } from './ItemForms';
import { RemoteError, send, type Folder, type ItemDetail } from '../../shared/messages';
import { clipHash } from '../../shared/cliphash';
import { mem, type IndexItem, type PopupScreen } from '../../shared/store';
import { Busy, Site, Tile, Toast, useToast } from '../../ui/bits';
import type { Boot } from './boot';
import type { NewPrefill } from './MainView';
import { scanTab } from './scanqr';
import { here } from './where';

const MATCH: Array<[number | null, string]> = [
  [null, 'Base domain (default)'],
  [1, 'Exact host'],
  [2, 'Starts with'],
  [3, 'Exact URL'],
  [4, 'Regular expression'],
  [5, 'Never'],
];
const matchLabel = (m: number | null) => (m == null || m === 0 ? 'Base domain' : (MATCH.find(([k]) => k === m)?.[1] ?? 'Base domain'));

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);
const host = (u: string) => u.replace(/^https?:\/\//, '');

function toDraft(it: FullItem): Draft {
  return {
    type: it.type,
    name: it.name,
    notes: it.notes,
    folderId: it.folderId,
    login: it.login ? { username: it.login.username, password: it.login.password, totp: it.login.totp, uris: it.login.uris.map((u) => ({ ...u })) } : undefined,
    ...(it.type === CipherType.Card && { card: pick(CARD_KEYS, it.card) }),
    ...(it.type === CipherType.Identity && { identity: pick(IDENTITY_KEYS, it.identity) }),
    fields: (it.fields ?? []).map((f) => ({ name: f.name ?? '', value: f.value ?? '', type: f.type, linkedId: f.linkedId ?? null })),
  };
}

const pick = (keys: readonly string[], o: Record<string, string | null> | undefined) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null])) as Record<string, string | null>;
const NOUN: Record<number, string> = { [CipherType.Login]: 'login', [CipherType.SecureNote]: 'note', [CipherType.Card]: 'card', [CipherType.Identity]: 'identity' };
/** Where the cursor goes when a form opens: the first thing you'd type. */
const FIRST: Record<number, string> = { [CipherType.Card]: 'f-number', [CipherType.Identity]: 'f-firstName' };

/** Just enough of an index entry for the header tile (favicon from the user's server, else a letter). */
function tileItem(d: { type: number; name: string; uris: ListUri[]; brand?: string | null }): IndexItem {
  return { brand: d.brand ?? null, id: '', type: d.type, orgId: null, folderId: null, name: d.name || '?', username: null, uris: d.uris, hasTotp: false, favorite: false, reprompt: 0, revisionDate: null, domain: d.type === CipherType.Login ? iconDomain(d.uris) : null, hosts: [] };
}

export function ItemView({
  boot: b,
  id: initialId,
  prefill,
  startEdit,
  resume,
  onBack,
  onLocked,
}: {
  boot: Boot;
  id: string | null;
  prefill?: NewPrefill;
  startEdit?: boolean;
  /** Where the user was on this item when the popup closed: view or edit, and the unsaved edit. */
  resume?: Extract<PopupScreen, { item: string | null }>;
  onBack: (flash?: string) => void;
  onLocked: () => void;
}) {
  const [id, setId] = useState(initialId);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>(resume?.mode ?? (initialId && !startEdit ? 'view' : 'edit'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [reveal, setReveal] = useState(false);
    const [genOpen, setGenOpen] = useState(false);
  const [gen, setGen] = useState<GenOptions>(b.settings.gen);
  const [genPw, setGenPw] = useState(() => generatePassword(b.settings.gen));
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'delete' | 'discard' | 'site' | null>(null);
  const [code, setCode] = useState('');
  const [secs, setSecs] = useState(secondsRemaining());
  const { toast, show, hide } = useToast();
  const bodyRef = useRef<HTMLDivElement>(null);
  const tab = b.tab;
  const tabHost = tab && /^https?:/i.test(tab.url) ? new URL(tab.url).hostname : null;

  async function load(which: string, edits?: Draft) {
    try {
      const d = await send('getItem', { id: which });
      setDetail(d);
      const dr = toDraft(d.item);
      setDraft(edits ?? dr);
      setBaseline(JSON.stringify(dr));
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as RemoteError).message);
    }
  }

  useEffect(() => {
    if (initialId) void load(initialId, resume?.draft);
    else if (resume?.draft) {
      setDraft(resume.draft);
      setBaseline(resume.baseline ?? '');
    } else {
      const type = prefill?.type ?? CipherType.Login;
      const base = { name: '', notes: null, folderId: prefill?.folderId ?? null, fields: [] };
      const dr: Draft =
        type === CipherType.Login
          ? { ...base, type, name: prefill?.host ?? '', login: { username: b.settings.defaultUsername || b.account?.email || '', password: generatePassword(b.settings.gen), totp: null, uris: [{ uri: prefill?.origin ?? '', match: null }] } }
          : type === CipherType.Card
            ? { ...base, type, card: pick(CARD_KEYS, undefined) }
            : type === CipherType.Identity
              ? { ...base, type, identity: pick(IDENTITY_KEYS, undefined) }
              : { ...base, type: CipherType.SecureNote };
      setDraft(dr);
      setBaseline(JSON.stringify(dr));
    }
    void send('folders').then(setFolderList).catch(() => {});
    const onStore = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && ch.session && !ch.session.newValue) onLocked();
    };
    chrome.storage.onChanged.addListener(onStore);
    return () => chrome.storage.onChanged.removeListener(onStore);
  }, []);

  // Live 2FA code in the view.
  const secret = mode === 'view' ? detail?.item.login?.totp : null;
  useEffect(() => {
    if (!secret) return;
    let live = true;
    const tick = async () => {
      const c = await totp(secret).catch(() => '');
      if (live) {
        setCode(c);
        setSecs(secondsRemaining());
      }
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [secret]);

  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  const isNew = !id;

  // Remember this place (and the edit in progress) for when the popup closes and opens again.
  useEffect(() => {
    if (!draft) return;
    here({ item: id, ...(id ? {} : { prefill: prefill ?? { host: null, origin: null } }), mode, ...(mode === 'edit' ? { draft, baseline } : {}) });
  }, [id, mode, draft, baseline]);

  // ----- actions -----
  async function copy(value: string | null | undefined, what: string, sensitive: boolean) {
    if (!value) return show(`Nothing to copy: the ${what.toLowerCase()} is empty.`);
    await navigator.clipboard.writeText(value);
    if (!sensitive) return show(`${what} copied`);
    await send('clipboardCopied', { hash: await clipHash(value) });
    show(`${what} copied`, b.settings.clipboardSeconds);
  }

  async function fill(force = false) {
    if (!tab || !id) return;
    try {
      const r = await send('fill', { tabId: tab.id, id, force });
      if (r.outcome === 'confirm-site') return setSheet('site');
      setSheet(null);
      if (r.outcome === 'confirm-frame') return show('The form is inside a frame from another site. Fill it from the main list to confirm.');
      if (r.outcome === 'blocked-page') return show("Litewarden can't fill on this page.");
      if (r.outcome === 'no-fields') return show('No login form found on this page. Use the copy buttons instead.');
      if (b.popout) return show(`Filled ${detail?.item.login?.username ?? ''}`);
      window.close();
    } catch (e) {
      show((e as RemoteError).message);
    }
  }

  /** Open the login's site in a new tab; the background fills it when the form shows up. */
  async function launch() {
    if (!id) return;
    try {
      const r = await send('launch', { id, tabId: tab?.id });
      setSheet(null);
      if (b.popout) return show(`Opening ${r.host}`);
      window.close();
    } catch (e) {
      show((e as RemoteError).message);
    }
  }

  /** Read the 2FA setup QR code showing on the page into the 2FA field. */
  async function scan() {
    const r = await scanTab(tab).catch(() => ({ ok: false as const, message: "Couldn't read the page. Try again." }));
    if (!r.ok) return show(r.message);
    setLogin({ totp: r.uri });
    show(r.label ? `2FA key added: ${r.label}` : '2FA key added');
  }

  async function save() {
    if (!draft || busy) return;
    const draft_ = { ...draft, name: autoName(draft) };
    const bad = validateDraft(draft_);
    if (bad) {
      if (!draft.name.trim()) {
        setNameErr(bad);
        document.getElementById('f-name')?.focus();
      } else setErr(bad);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await send('saveItem', { id, draft: draft_ });
      const host = b.account?.server ? b.account.server.replace(/^https?:\/\//, '') : 'the server';
      setId(r.id);
      await load(r.id);
      setMode('view');
      setGenOpen(false);
      setReveal(false);
      show(`Saved to ${host}`);
    } catch (e) {
      setErr((e as RemoteError).message);
      bodyRef.current?.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function trash() {
    if (!id || busy) return;
    setBusy(true);
    try {
      await send('trashItem', { id });
      onBack(`Moved “${draft?.name ?? 'the item'}” to the trash`);
    } catch (e) {
      setSheet(null);
      setErr((e as RemoteError).message);
    } finally {
      setBusy(false);
    }
  }

  function leaveEdit() {
    if (dirty) return setSheet('discard');
    if (isNew) return onBack();
    if (detail) setDraft(toDraft(detail.item));
    setErr(null);
    setNameErr(null);
    setGenOpen(false);
    setMode('view');
  }

  const setLogin = (patch: Partial<NonNullable<Draft['login']>>) => setDraft((d) => (d && d.login ? { ...d, login: { ...d.login, ...patch } } : d));
  const setUri = (i: number, patch: Partial<ListUri>) => setLogin({ uris: draft!.login!.uris.map((u, k) => (k === i ? { ...u, ...patch } : u)) });

  let genSaveTimer = 0;
  function changeGen(patch: Partial<GenOptions>) {
    const next = { ...gen, ...patch };
    setGen(next);
    setGenPw(generatePassword(next));
    clearTimeout(genSaveTimer);
    genSaveTimer = window.setTimeout(() => void send('setSettings', { gen: next }).catch(() => {}), 300);
  }

  // ----- keyboard -----
  const live = useRef({ mode, sheet, dirty, save, leaveEdit, onBack });
  live.current = { mode, sheet, dirty, save, leaveEdit, onBack };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (L.sheet) return setSheet(null);
        return L.mode === 'edit' ? L.leaveEdit() : L.onBack();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (L.mode === 'edit') void L.save();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setReveal((r) => !r);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    // Focus the name, unless the user already went to another field (typing must never land in the wrong one).
    if (mode === 'edit' && draft)
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.closest('.body')) (document.getElementById((isNew && FIRST[draft?.type ?? 0]) || 'f-name') as HTMLInputElement | null)?.focus();
      }, 0);
  }, [mode, !!draft]);

  const pwStrength = useMemo(() => strength((mode === 'edit' ? draft?.login?.password : detail?.item.login?.password) ?? ''), [draft?.login?.password, detail, mode]);

  // ----- render -----
  if (loadErr)
    return (
      <div class="scr">
        <div class="hdr">
          <button class="ib" aria-label="Back" title="Back" onClick={() => onBack()}>
            <ArrowLeft />
          </button>
          <h1>Item</h1>
        </div>
        <div class="body">
          <div class="note warn" role="alert">
            <TriangleAlert />
            <div>{loadErr}</div>
          </div>
        </div>
      </div>
    );
  if (!draft)
    return (
      <div class="scr" aria-busy="true">
        <div class="hdr">
          <button class="ib" aria-label="Back" title="Back" onClick={() => onBack()}>
            <ArrowLeft />
          </button>
          <h1 class="muted">Opening…</h1>
        </div>
      </div>
    );

  const isLogin = draft.type === CipherType.Login;
  const it = detail?.item;

  if (mode === 'view' && it) {
    const l = it.login;
    const meta = [detail!.folderName ? `Folder: ${detail!.folderName}` : 'No folder', detail!.revisionDate && `Edited ${fmtDate(detail!.revisionDate)}`, detail!.creationDate && `Created ${fmtDate(detail!.creationDate)}`].filter(Boolean).join(' · ');
    const canFill = isLogin && !!tab && !!tabHost;
    const go = l ? launchUrl(l.uris)?.hostname.replace(/^www\./, '') : undefined;
    return (
      <div class="scr item">
        <div class="hdr">
          <button class="ib" aria-label="Back" title="Back (Esc)" onClick={() => onBack()}>
            <ArrowLeft />
          </button>
          <Tile item={tileItem({ type: it.type, name: it.name, uris: l?.uris ?? [], brand: it.card?.brand })} />
          <h1>{it.name}</h1>
          {detail!.canEdit && (
            <button class="btn sec" onClick={() => setMode('edit')}>
              Edit
            </button>
          )}
        </div>
        <div class="body" ref={bodyRef}>
          {detail!.orgName && (
            <div class="note">
              <div>
                In <b>{detail!.orgName}</b>.{detail!.canEdit ? ' Changes are shared with the organization.' : " You can view it but not change it."}
              </div>
            </div>
          )}
          {l && (
            <>
              <div class="group">
                <Kv label="Username" actions={<button class="ib" aria-label="Copy username" title="Copy username" onClick={() => copy(l.username, 'Username', false)}><Copy /></button>}>
                  <div>{l.username || <span class="muted">None</span>}</div>
                </Kv>
                <Kv
                  label="Password"
                  actions={
                    <>
                      <button class="ib" aria-label={reveal ? 'Hide password' : 'Show password'} title={`${reveal ? 'Hide' : 'Show'} password (Alt R)`} onClick={() => setReveal(!reveal)}>
                        {reveal ? <EyeOff /> : <Eye />}
                      </button>
                      <button class="ib" aria-label="Copy password" title="Copy password" onClick={() => copy(l.password, 'Password', true)}>
                        <Copy />
                      </button>
                    </>
                  }
                >
                  <div class="mono pw">{l.password ? (reveal ? l.password : '•'.repeat(Math.min(24, l.password.length))) : <span class="muted">None</span>}</div>
                  {l.password && (
                    <div class={`meter s${pwStrength.score}`} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                </Kv>
                {l.totp && (
                  <Kv
                    label="2FA code"
                    actions={
                      <>
                        <span class="secs">{secs}</span>
                        <span class={`ring big-ring${secs <= 5 ? ' low' : ''}`} style={{ '--t': secs / 30 }} />
                        <button class="ib" aria-label="Copy 2FA code" title="Copy 2FA code" onClick={() => copy(code, '2FA code', true)}>
                          <Copy />
                        </button>
                      </>
                    }
                  >
                    <div class="code-big">{code ? `${code.slice(0, code.length / 2)} ${code.slice(code.length / 2)}` : '··· ···'}</div>
                  </Kv>
                )}
              </div>
              {l.password && (
                <p class="meta">
                  {pwStrength.label} password: {l.password.length} characters{detail!.passwordHistoryCount ? `. ${detail!.passwordHistoryCount} older ${detail!.passwordHistoryCount === 1 ? 'password' : 'passwords'} kept in the history.` : '.'}
                </p>
              )}
              {l.uris.length > 0 && (
                <>
                  <div class="g-title">Websites</div>
                  <div class="group">
                    {l.uris.map((u) => {
                      const p = parseLoose(u.uri);
                      return (
                        <Kv
                          label={
                            <>
                              Website<span class="pill">{matchLabel(u.match)}</span>
                            </>
                          }
                          actions={
                            p && (
                              <button class="ib" aria-label={`Open ${p.host}`} title={`Open ${p.host} in a new tab`} onClick={() => void chrome.tabs.create({ url: p.href })}>
                                <ExternalLink />
                              </button>
                            )
                          }
                        >
                          <div>{parseLoose(u.uri) ? <Site host={u.uri} /> : u.uri}</div>
                        </Kv>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
          {it.type === CipherType.Card && it.card && <CardView card={it.card} copy={(v, w, sens) => void copy(v, w, sens)} />}
          {it.type === CipherType.Identity && it.identity && <IdentityView identity={it.identity} copy={(v, w, sens) => void copy(v, w, sens)} />}
          {it.notes && (
            <>
              <div class="g-title">Notes</div>
              <div class="group">
                <div class="kv">
                  <div class="k">
                    <div class="notes-text">{it.notes}</div>
                  </div>
                  <button class="ib" aria-label="Copy notes" title="Copy notes" onClick={() => copy(it.notes, 'Notes', false)}>
                    <Copy />
                  </button>
                </div>
              </div>
            </>
          )}
          {it.fields && it.fields.length > 0 && <FieldsView fields={it.fields} copy={(v, w, sens) => void copy(v, w, sens)} />}
          <p class="meta">{meta}</p>
        </div>
        {canFill && (
          <div class="dock">
            <button class="btn wide" onClick={() => fill()}>
              <CornerDownLeft />
              Fill on {tabHost}
            </button>
          </div>
        )}
        <Toast t={toast} onDone={hide} />
        {sheet === 'site' && (
          <div class="sheet" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
            <div class="h-card" role="dialog" aria-label="Confirm fill">
              <div class="h-head">
                <b>
                  Fill on <Site host={tabHost} />?
                </b>
              </div>
              <p>
                This login is saved for {l?.uris[0] ? <Site host={host(l.uris[0].uri)} /> : 'another site'}, not <Site host={tabHost} />.
              </p>
              {go ? (
                <div class="c-actions three">
                  <button class="c-cancel" onClick={() => setSheet(null)}>
                    Cancel
                  </button>
                  <button onClick={() => fill(true)}>Fill here</button>
                  <button class="c-ok c-go" title={`Open ${go} in a new tab and fill it`} onClick={() => void launch()}>
                    Open {go}
                  </button>
                </div>
              ) : (
                <div class="c-actions">
                  <button onClick={() => setSheet(null)}>Cancel</button>
                  <button class="c-ok" onClick={() => fill(true)}>
                    Fill anyway
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ----- edit / new -----
  const l = draft.login;
  const noun = NOUN[draft.type] ?? 'item';
  const title = `${isNew ? 'New' : 'Edit'} ${noun}`;
  const setName = (v: string) => (setDraft({ ...draft, name: v }), setNameErr(null));
  const isCard = draft.type === CipherType.Card && !!draft.card;
  const isId = draft.type === CipherType.Identity && !!draft.identity;
  return (
    <div class="scr item">
      <form
        class="scr"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div class="hdr">
          <button type="button" class="ib" aria-label="Cancel" title="Cancel (Esc)" onClick={leaveEdit}>
            <X />
          </button>
          <h1>{title}</h1>
          <Busy busy={busy} label="Saving" class="btn" type="submit">
            Save
          </Busy>
        </div>
        <div class="body" ref={bodyRef}>
          {err && (
            <div class="note warn" role="alert">
              <TriangleAlert />
              <div>{err}</div>
            </div>
          )}
          {isCard ? (
            <CardForm card={draft.card!} name={draft.name} nameErr={nameErr} onName={setName} onCard={(p) => setDraft((d) => (d?.card ? { ...d, card: { ...d.card, ...p } } : d))} />
          ) : isId ? (
            <IdentityForm identity={draft.identity!} name={draft.name} nameErr={nameErr} onName={setName} onId={(p) => setDraft((d) => (d?.identity ? { ...d, identity: { ...d.identity, ...p } } : d))} />
          ) : (
            <label class={`field${nameErr ? ' err' : ''}`}>
              <span class="l">Name</span>
              <span class="inp">
                <input id="f-name" value={draft.name} maxLength={1000} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
              </span>
              {nameErr && <span class="f-msg">{nameErr}</span>}
            </label>
          )}
          {l && (
            <>
              <label class="field">
                <span class="l">Username</span>
                <span class="inp">
                  <input id="f-user" value={l.username ?? ''} autocomplete="off" spellcheck={false} onInput={(e) => setLogin({ username: (e.currentTarget as HTMLInputElement).value })} />
                </span>
              </label>
              <div class="field">
                <span class="l">
                  Password<small>{l.password ? `${pwStrength.label}, ${l.password.length} characters` : ''}</small>
                </span>
                <span class="inp">
                  <input
                    id="f-pw"
                    class="mono"
                    {...({ type: reveal ? 'text' : 'password' } as Record<string, string>)}
                    aria-label="Password"
                    value={l.password ?? ''}
                    autocomplete="new-password"
                    spellcheck={false}
                    onInput={(e) => setLogin({ password: (e.currentTarget as HTMLInputElement).value })}
                  />
                  <button type="button" class="ib" aria-label={reveal ? 'Hide password' : 'Show password'} title={`${reveal ? 'Hide' : 'Show'} password (Alt R)`} onClick={() => setReveal(!reveal)}>
                    {reveal ? <EyeOff /> : <Eye />}
                  </button>
                  <button type="button" class={`ib${genOpen ? ' on' : ''}`} aria-label="Generate a password" aria-expanded={genOpen} title="Generate a password" onClick={() => (setGenOpen(!genOpen), setGenPw(generatePassword(gen)))}>
                    <WandSparkles />
                  </button>
                </span>
                {genOpen && (
                  <div class="gen" role="group" aria-label="Password generator">
                    <div class="pv" aria-live="polite">
                      {genPw}
                    </div>
                    <div class="r">
                      <label for="g-len">Length</label>
                      <input type="range" id="g-len" min={GEN_MIN} max={GEN_MAX} value={gen.length} onInput={(e) => changeGen({ length: Number((e.currentTarget as HTMLInputElement).value) })} />
                      <span class="n">{gen.length}</span>
                    </div>
                    <div class="r">
                      <span>Symbols ! # $ %</span>
                      <Switch on={gen.symbols} label="Symbols" onChange={(v) => changeGen({ symbols: v })} />
                    </div>
                    <div class="r">
                      <span>Avoid look-alikes (l 1 I 0 O)</span>
                      <Switch on={gen.avoidAmbiguous} label="Avoid look-alikes" onChange={(v) => changeGen({ avoidAmbiguous: v })} />
                    </div>
                    <div class="acts">
                      <button type="button" class="btn sec" onClick={() => setGenPw(generatePassword(gen))}>
                        <RefreshCw />
                        New
                      </button>
                      <button
                        type="button"
                        class="btn"
                        onClick={() => {
                          setLogin({ password: genPw });
                          setGenOpen(false);
                          show('New password set. Save to keep it');
                        }}
                      >
                        Use this password
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <label class="field">
                <span class="l">
                  2FA secret<small>Key or otpauth:// link</small>
                </span>
                <span class="inp">
                  <input id="f-totp" class="mono" value={l.totp ?? ''} autocomplete="off" spellcheck={false} placeholder="Optional" onInput={(e) => setLogin({ totp: (e.currentTarget as HTMLInputElement).value })} />
                  <button type="button" class="ib" aria-label="Scan the QR code on the page" title="Scan the 2FA QR code showing on the page" onClick={() => void scan()}>
                    <ScanLine />
                  </button>
                </span>
              </label>
              <div class="field">
                <span class="l">Websites</span>
                <div class="group">
                  {l.uris.map((u, i) => (
                    <div class="uri">
                      <span class="inp">
                        <input aria-label={`Website ${i + 1}`} value={u.uri} placeholder="https://example.com" spellcheck={false} onInput={(e) => setUri(i, { uri: (e.currentTarget as HTMLInputElement).value })} />
                      </span>
                      <select class="sel" aria-label={`Match for website ${i + 1}`} value={u.match == null ? '' : String(u.match)} onChange={(e) => setUri(i, { match: (e.currentTarget as HTMLSelectElement).value === '' ? null : Number((e.currentTarget as HTMLSelectElement).value) })}>
                        {MATCH.map(([k, label]) => (
                          <option value={k == null ? '' : String(k)}>{label.replace(' (default)', '')}</option>
                        ))}
                        {u.match === 0 && <option value="0">Base domain</option>}
                      </select>
                      <button type="button" class="ib" aria-label={`Remove website ${i + 1}`} title="Remove" onClick={() => setLogin({ uris: l.uris.filter((_, k) => k !== i) })}>
                        <X />
                      </button>
                    </div>
                  ))}
                  {!l.uris.length && <div class="uri muted">No websites. Litewarden only offers this login where you add one.</div>}
                </div>
                <button type="button" class="btn ghost add" onClick={() => setLogin({ uris: [...l.uris, { uri: !l.uris.length && tab && /^https?:/.test(tab.url) ? new URL(tab.url).origin : '', match: null }] })}>
                  <Plus />
                  Add website
                </button>
              </div>
            </>
          )}
          <label class="field">
            <span class="l">Folder</span>
            <select class="sel full" id="f-folder" value={draft.folderId ?? ''} onChange={(e) => setDraft({ ...draft, folderId: (e.currentTarget as HTMLSelectElement).value || null })}>
              <option value="">No folder</option>
              {folderList.map((f) => (
                <option value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="l">Notes</span>
            <span class="inp ta">
              <textarea id="f-notes" value={draft.notes ?? ''} rows={draft.type === CipherType.SecureNote ? 10 : 4} onInput={(e) => setDraft({ ...draft, notes: (e.currentTarget as HTMLTextAreaElement).value })} />
            </span>
          </label>
          {draft.fields && <FieldsForm fields={draft.fields} onChange={(fields) => setDraft((d) => (d ? { ...d, fields } : d))} />}
          {!isNew && (
            <button type="button" class="danger-link" onClick={() => setSheet('delete')}>
              <Trash2 />
              Delete this {noun}
            </button>
          )}
        </div>
      </form>
      <Toast t={toast} onDone={hide} />
      {sheet === 'delete' && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div class="h-card" role="dialog" aria-label="Delete">
            <div class="h-head">
              <b>Delete {draft.name || 'this item'}?</b>
            </div>
            <p>It moves to the trash on {b.account ? host(b.account.server) : 'your server'}. You can restore it from the web vault for 30 days.</p>
            <div class="c-actions">
              <button class="btn sec" onClick={() => setSheet(null)}>
                Cancel
              </button>
              <Busy busy={busy} label="Deleting" class="btn danger" onClick={trash}>
                Delete
              </Busy>
            </div>
          </div>
        </div>
      )}
      {sheet === 'discard' && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setSheet(null)}>
          <div class="h-card" role="dialog" aria-label="Discard changes">
            <div class="h-head">
              <b>Discard your changes?</b>
            </div>
            <p>{isNew ? `This ${noun} hasn’t been saved yet.` : 'The item stays as it was before you opened the editor.'}</p>
            <div class="c-actions">
              <button class="btn sec" onClick={() => setSheet(null)}>
                Keep editing
              </button>
              <button
                class="btn danger"
                onClick={() => {
                  setSheet(null);
                  if (isNew) return onBack();
                  if (detail) setDraft(toDraft(detail.item));
                  setErr(null);
                  setGenOpen(false);
                  setMode('view');
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
