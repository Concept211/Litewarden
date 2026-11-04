// SPDX-License-Identifier: GPL-3.0-only
// Share by secure link: the list of links, the New link screen (a message, a file or a saved item) and a link's page.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, Clock, Copy, Eye, FileUp, Link as LinkIcon, Lock, MailX, MessageSquareText, Paperclip, Plus, Trash2, X } from 'lucide-preact';
import { serverMessage } from '../../core/errors';
import { b64decode } from '../../core/bytes';
import { SHARE_LASTS, MAX_SHARE_BYTES, composeShare, encryptSendFile, sendContentKey, shareFields, titleFromMessage, type ShareField, type ShareLasts, type ShareOptions, type SharePolicy, type ShareRow } from '../../core/send';
import { clipHash } from '../../shared/cliphash';
import { RemoteError, send, type ShareMade } from '../../shared/messages';
import { mem, type PopupScreen, type ShareDraft } from '../../shared/store';
import { Busy, Toast, useToast } from '../../ui/bits';
import type { Boot } from './boot';
import { here } from './where';

export type ShareScreen = Extract<PopupScreen, { share: string }>;

const NOUN: Record<number, string> = { 1: 'login', 2: 'note', 3: 'card', 4: 'identity' };

export const newDraft = (b: Boot, extra: Partial<ShareDraft> = {}): ShareDraft => ({
  kind: 'text',
  text: '',
  title: '',
  oneView: false,
  password: null,
  hideEmail: false,
  lasts: b.settings.shareLasts in SHARE_LASTS ? b.settings.shareLasts : '7d',
  ...extra,
});

const fmtDate = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function timeLeft(ms: number, now = Date.now()): string {
  const min = Math.max(1, Math.round((ms - now) / 60_000));
  if (min < 60) return `${min} min left`;
  const h = Math.round(min / 60);
  if (h < 48) return `${plural(h, 'hour')} left`;
  return `${plural(Math.round(h / 24), 'day')} left`;
}

function viewsText(r: ShareRow): string {
  if (r.maxViews != null) return `${r.views} of ${plural(r.maxViews, 'view')}`;
  return r.views ? plural(r.views, 'view') : 'Not viewed yet';
}

function rowLine(r: ShareRow): string {
  if (r.closed) return r.maxViews != null && r.views >= r.maxViews ? 'Viewed, link closed' : `Expired ${fmtDay(r.endsAt)}`;
  return [timeLeft(r.endsAt), viewsText(r), r.hasPassword && 'password'].filter(Boolean).join(' · ');
}

/** The recipient's page refuses to run over plain HTTP, so a link from such a server won't open for anyone. */
function HttpNote({ b }: { b: Boot }) {
  if (!/^http:/i.test(b.account?.server ?? '')) return null;
  return (
    <div class="note warn" id="share-http" role="status">
      <div>Links from this server won't open: it uses plain HTTP, and the page people land on only runs over HTTPS.</div>
    </div>
  );
}

const KindIcon = ({ r }: { r: Pick<ShareRow, 'kind'> }) => (r.kind === 'file' ? <Paperclip /> : <MessageSquareText />);

export function ShareView({
  boot: b,
  start,
  onBack,
  onItem,
  onLocked,
}: {
  boot: Boot;
  start: ShareScreen;
  onBack: () => void;
  /** Back to the item a share started from. */
  onItem: (id: string) => void;
  onLocked: () => void;
}) {
  const [screen, setScreen] = useState<ShareScreen>(start);
  // The boot's settings date from when the popup opened; a link made since then moves this on.
  const [lasts, setLasts] = useState(b.settings.shareLasts);
  const toast = useToast();

  useEffect(() => here(screen), [screen]);
  useEffect(() => {
    const l = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && ch.session && !ch.session.newValue) onLocked();
    };
    chrome.storage.onChanged.addListener(l);
    return () => chrome.storage.onChanged.removeListener(l);
  }, []);

  /** A link is as good as the secret behind it, so the clipboard clears on the usual timer. */
  async function copyLink(link: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      toast.show("Couldn't reach the clipboard. Copy the link by hand.");
      return false;
    }
    await send('clipboardCopied', { hash: await clipHash(link) });
    toast.show('Link copied', b.settings.clipboardSeconds);
    return true;
  }

  const common = { b, copyLink, show: toast.show };
  return (
    <>
      {screen.share === 'list' && <LinkList {...common} onBack={onBack} go={setScreen} newOne={() => newDraft(b, { lasts })} />}
      {screen.share === 'new' && (
        <NewLink
          {...common}
          key={screen.draft.fromItem ?? 'new'}
          draft={screen.draft}
          onDraft={(draft) => setScreen({ share: 'new', draft })}
          onClose={() => (screen.draft.fromItem ? onItem(screen.draft.fromItem) : setScreen({ share: 'list' }))}
          onMade={(id) => {
            setLasts(screen.draft.lasts);
            setScreen({ share: 'link', id, fresh: true });
          }}
        />
      )}
      {screen.share === 'link' && <LinkPage {...common} id={screen.id} fresh={!!screen.fresh} onDone={() => setScreen({ share: 'list' })} />}
      <Toast t={toast.toast} onDone={toast.hide} />
    </>
  );
}

interface Common {
  b: Boot;
  copyLink: (link: string) => Promise<boolean>;
  show: (msg: string, secs?: number) => void;
}

/** Redraw when a link changes (someone opened one, another device made one). */
function useSharesChanged(fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const l = (m: { event?: string }) => {
      if (m?.event === 'shares') latest.current();
    };
    chrome.runtime.onMessage.addListener(l);
    return () => chrome.runtime.onMessage.removeListener(l);
  }, []);
}

function useEsc(fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

function DeleteSheet({ busy, onCancel, onDelete }: { busy: boolean; onCancel: () => void; onDelete: () => void }) {
  return (
    <div class="sheet" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div class="h-card" role="dialog" aria-label="Delete link">
        <div class="h-head">
          <b>Delete this link?</b>
        </div>
        <p>It stops working right away. Anyone who opens it after this is told it no longer exists.</p>
        <div class="c-actions">
          <button class="btn sec" onClick={onCancel}>
            Cancel
          </button>
          <Busy busy={busy} label="Deleting" class="btn danger" onClick={onDelete}>
            Delete
          </Busy>
        </div>
      </div>
    </div>
  );
}

// ---------- the list ----------

function LinkList({ b, copyLink, show, onBack, go, newOne }: Common & { onBack: () => void; go: (s: ShareScreen) => void; newOne: () => ShareDraft }) {
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [policy, setPolicy] = useState<SharePolicy>({ disabled: false, noHideEmail: false });
  const [del, setDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (fresh: boolean) =>
    send('shares', { fresh }).then(
      (r) => {
        setRows(r.rows);
        setPolicy(r.policy);
      },
      (e: RemoteError) => show(e.message),
    );
  useEffect(() => {
    // What's on this device first, then the server's view counts.
    void load(false).then(() => load(true));
  }, []);
  useSharesChanged(() => void load(false));
  useEsc(() => (del ? setDel(null) : onBack()));

  async function copy(id: string) {
    try {
      await copyLink((await send('shareLink', { id })).link);
    } catch (e) {
      show((e as Error).message);
    }
  }
  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await send('shareDelete', { id: del });
      setRows((list) => list?.filter((r) => r.id !== del) ?? null);
      show('Link deleted');
    } catch (e) {
      show((e as Error).message);
    }
    setBusy(false);
    setDel(null);
  }

  const open = rows?.filter((r) => !r.closed) ?? [];
  const finished = rows?.filter((r) => r.closed) ?? [];
  const row = (r: ShareRow) => (
    <div class={`row${r.closed ? ' gone' : ''}`} key={r.id} onClick={() => go({ share: 'link', id: r.id })}>
      <span class="tile" aria-hidden="true">
        <KindIcon r={r} />
      </span>
      <div class="who">
        <div class="nm">{r.title}</div>
        <div class="un">{rowLine(r)}</div>
      </div>
      {!r.closed && (
        <button
          class="ib"
          aria-label={`Copy link: ${r.title}`}
          title="Copy link"
          onClick={(e) => {
            e.stopPropagation();
            void copy(r.id);
          }}
        >
          <LinkIcon />
        </button>
      )}
      <button
        class="ib"
        aria-label={`Delete link: ${r.title}`}
        title="Delete link"
        onClick={(e) => {
          e.stopPropagation();
          setDel(r.id);
        }}
      >
        <Trash2 />
      </button>
    </div>
  );

  return (
    <div class="scr share">
      <div class="hdr">
        <button class="ib" aria-label="Back" title="Back (Esc)" onClick={onBack}>
          <ArrowLeft />
        </button>
        <h1>Shared links</h1>
        {!policy.disabled && (
          <button class="btn" onClick={() => go({ share: 'new', draft: newOne() })}>
            <Plus />
            New link
          </button>
        )}
      </div>
      <div class="body">
        <HttpNote b={b} />
        {policy.disabled && (
          <div class="note warn" role="status">
            <div>Your organization's policy doesn't allow new shared links. You can still delete the ones you've made.</div>
          </div>
        )}
        {rows && !rows.length && (
          <div class="s-empty">
            <b>No links yet</b>
            <p>Share a message, a login or a file. Only people with the link can read it, and they don't need an account.</p>
          </div>
        )}
        {open.length > 0 && <div class="list">{open.map(row)}</div>}
        {finished.length > 0 && (
          <>
            <div class="sec">
              <span>Finished</span>
            </div>
            <div class="list">{finished.map(row)}</div>
          </>
        )}
      </div>
      {del && <DeleteSheet busy={busy} onCancel={() => setDel(null)} onDelete={() => void remove()} />}
    </div>
  );
}

// ---------- New link ----------

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/** The page encrypts and uploads a file itself (see shareFileStart). A failure removes the half-made link. */
async function uploadFile(file: File, options: ShareOptions, phase: (label: string) => void): Promise<ShareMade> {
  const up = await send('shareFileStart', { options, fileName: file.name, size: file.size });
  try {
    phase('Encrypting');
    const { webCrypto } = await import('../../core/crypto');
    const key = await sendContentKey(webCrypto, b64decode(up.material));
    const sealed = await encryptSendFile(new Uint8Array(await file.arrayBuffer()), key);
    phase('Uploading');
    const form = new FormData();
    form.append('data', new Blob([sealed as Uint8Array<ArrayBuffer>]), up.encName);
    const r = await fetch(up.url, { method: 'POST', headers: { Authorization: `Bearer ${up.token}` }, body: form, credentials: 'omit', cache: 'no-store' });
    if (!r.ok) {
      const body = await r.text();
      let said = '';
      try {
        said = serverMessage(JSON.parse(body));
      } catch {
        // not JSON: a proxy's error page, say
      }
      throw new Error(r.status === 413 ? "That's more than the server accepts. Share something smaller." : `The server didn't take the file${said ? `: ${said.replace(/\.+$/, '')}` : ` (HTTP ${r.status})`}. No link was made.`);
    }
  } catch (e) {
    await send('shareFileEnd', { id: up.id, ok: false }).catch(() => {});
    throw e instanceof TypeError ? new Error("Couldn't reach the server, so no link was made. Try again when it's back.") : e;
  }
  await send('shareFileEnd', { id: up.id, ok: true });
  return send('shareLink', { id: up.id });
}

function NewLink({
  b,
  copyLink,
  show,
  draft,
  onDraft,
  onClose,
  onMade,
}: Common & { draft: ShareDraft; onDraft: (d: ShareDraft) => void; onClose: () => void; onMade: (id: string) => void }) {
  const [fields, setFields] = useState<ShareField[]>([]);
  const [noun, setNoun] = useState<string | null>(null);
  const [policy, setPolicy] = useState<SharePolicy>({ disabled: false, noHideEmail: false });
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState(false);
  const [discard, setDiscard] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ShareDraft>) => onDraft({ ...draft, ...patch });

  useEffect(() => {
    void send('shares', {}).then((r) => setPolicy(r.policy)).catch(() => {});
    if (!draft.fromItem) return void textRef.current?.focus();
    // Sharing a saved item: its fields, opened through the same check as its page (a re-prompt item stays shut).
    void send('getItem', { id: draft.fromItem }).then(
      (d) => {
        if (d.locked) return show('Type your master password on the item first.'), onClose();
        const list = shareFields(d.item);
        setFields(list);
        setNoun(NOUN[d.item.type] ?? 'item');
        if (draft.picked) return; // came back to this screen: what was typed stays
        const picked = list.filter((f) => f.on).map((f) => f.key);
        onDraft({ ...draft, picked, title: d.item.name, text: composeShare(list, new Set(picked)) });
      },
      (e: RemoteError) => {
        show(e.message);
        onClose();
      },
    );
  }, []);

  const isFile = draft.kind === 'file';
  const suggested = useMemo(() => (isFile ? (file?.name ?? '') : (titleFromMessage(draft.text) ?? 'Shared message')), [isFile, file, draft.text]);
  const ready = isFile ? !!file : !!draft.text.trim();
  const dirty = !!draft.text.trim() && !draft.fromItem;

  const close = () => (dirty ? setDiscard(true) : onClose());
  useEsc(() => {
    if (busy) return;
    if (discard) return setDiscard(false);
    close();
  });

  function toggleField(key: string) {
    const next = new Set(draft.picked ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ picked: [...next], text: composeShare(fields, next) });
  }

  function pick(f: File | null | undefined) {
    setErr(null);
    if (!f) return;
    if (!f.size) return setFileErr('That file is empty.');
    if (f.size > MAX_SHARE_BYTES) return setFileErr(`That file is ${fmtSize(f.size)}. The limit is 100 MB.`);
    setFileErr(null);
    setFile(f);
  }

  /**
   * The toolbar popup closes when the file picker takes the focus, on some systems, and that would lose the file. The
   * pop-out window stays open, so files are chosen there. It opens on this same screen with what's been typed so far.
   */
  async function toWindow() {
    await mem.set({ popupWhere: { screen: { share: 'new', draft }, at: Date.now() } });
    try {
      await send('popout', {});
      void chrome.runtime.sendMessage({ event: 'openShare', draft }).catch(() => {});
      window.close();
    } catch (e) {
      show((e as Error).message);
    }
  }

  async function create() {
    if (!ready || busy) return;
    setErr(null);
    if (draft.password != null && !draft.password) {
      setPwErr(true);
      return pwRef.current?.focus();
    }
    const options: ShareOptions = {
      title: draft.title.trim() || suggested,
      lasts: draft.lasts,
      oneView: draft.oneView,
      password: draft.password || null,
      hideEmail: draft.hideEmail && !policy.noHideEmail,
    };
    setBusy('Creating');
    try {
      const made = isFile ? await uploadFile(file!, options, setBusy) : await send('shareText', { options, text: draft.text });
      void send('setSettings', { shareLasts: draft.lasts }).catch(() => {});
      await copyLink(made.link);
      onMade(made.row.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void create();
    }
  };

  return (
    <div class="scr share" onKeyDown={onKey}>
      <div class="hdr">
        <button class="ib" aria-label="Close" title="Close (Esc)" onClick={close}>
          <X />
        </button>
        <h1>{draft.fromItem ? `Share ${noun ?? 'item'}` : 'New link'}</h1>
      </div>
      <div class="body">
        {!draft.fromItem && (
          <div class="seg full" role="group" aria-label="What to share">
            <button aria-pressed={!isFile} onClick={() => set({ kind: 'text' })}>
              Message
            </button>
            <button aria-pressed={isFile} onClick={() => set({ kind: 'file' })}>
              File
            </button>
          </div>
        )}
        {draft.fromItem && fields.length > 0 && (
          <div class="pickf" role="group" aria-label="What to include">
            {fields.map((f) => {
              const on = !!draft.picked?.includes(f.key);
              return (
                <button key={f.key} class={on ? 'on' : ''} aria-pressed={on} onClick={() => toggleField(f.key)}>
                  {on && <Check />}
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
        {isFile ? (
          <div>
            <p class="lbl-row">
              <span>File</span>
              <small>Up to 100 MB</small>
            </p>
            {file ? (
              <div class="file-sel">
                <Paperclip />
                <span class="fn" title={file.name}>
                  {file.name}
                </span>
                <small>{fmtSize(file.size)}</small>
                <button class="ib" aria-label="Remove file" title="Remove file" disabled={!!busy} onClick={() => setFile(null)}>
                  <X />
                </button>
              </div>
            ) : b.popout ? (
              <label
                class={`drop${drag ? ' over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  pick(e.dataTransfer?.files[0]);
                }}
              >
                <FileUp />
                <b>Choose a file</b>
                or drop it here
                <input id="share-file" class="vh" type="file" onChange={(e) => pick((e.currentTarget as HTMLInputElement).files?.[0])} />
              </label>
            ) : (
              <button class="drop" onClick={() => void toWindow()}>
                <FileUp />
                <b>Choose a file</b>
                Opens in its own window, so the file picker can't close it
              </button>
            )}
            {fileErr && (
              <p class="f-msg" role="alert">
                {fileErr}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p class="lbl-row">
              <label for="share-text">Message</label>
            </p>
            <div class="inp ta">
              <textarea id="share-text" class="mono" ref={textRef} rows={draft.fromItem ? 4 : 6} spellcheck={false} value={draft.text} placeholder="Type or paste what you want to share" onInput={(e) => set({ text: (e.currentTarget as HTMLTextAreaElement).value })} />
            </div>
          </div>
        )}
        <label class="field">
          <span class="l">
            Title<small>The person sees this</small>
          </span>
          <span class="inp">
            <input id="share-title" autocomplete="off" value={draft.title} placeholder={suggested || "The file's name"} onInput={(e) => set({ title: (e.currentTarget as HTMLInputElement).value })} />
          </span>
        </label>
        <div>
          <p class="lbl-row">
            <span>Link lasts</span>
          </p>
          <div class="seg full" role="group" aria-label="Link lasts">
            {(Object.keys(SHARE_LASTS) as ShareLasts[]).map((k) => (
              <button key={k} aria-pressed={draft.lasts === k} onClick={() => set({ lasts: k })}>
                {SHARE_LASTS[k].label}
              </button>
            ))}
          </div>
        </div>
        <div class="tgl">
          <span>
            Only one view
            <span class="sub">The link closes after it's opened once</span>
          </span>
          <label class="sw">
            <input type="checkbox" aria-label="Only one view" checked={draft.oneView} onChange={(e) => set({ oneView: (e.currentTarget as HTMLInputElement).checked })} />
            <i />
          </label>
        </div>
        <div class="add-chips">
          {draft.password == null && (
            <button
              class="add-chip"
              onClick={() => {
                set({ password: '' });
                requestAnimationFrame(() => pwRef.current?.focus());
              }}
            >
              <Plus />
              Password
            </button>
          )}
          {!policy.noHideEmail && (
            <button class={`add-chip${draft.hideEmail ? ' on' : ''}`} aria-pressed={draft.hideEmail} onClick={() => set({ hideEmail: !draft.hideEmail })}>
              {draft.hideEmail ? <Check /> : <Plus />}
              Hide my email
            </button>
          )}
        </div>
        {draft.password != null && (
          <div class={`field${pwErr ? ' err' : ''}`}>
            <span class="l">Password</span>
            <span class="inp">
              <input
                id="share-password"
                ref={pwRef}
                aria-label="Link password"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={draft.password}
                onInput={(e) => {
                  setPwErr(false);
                  set({ password: (e.currentTarget as HTMLInputElement).value });
                }}
              />
              <button class="ib" aria-label="Remove password" title="Remove password" onClick={() => (setPwErr(false), set({ password: null }))}>
                <X />
              </button>
            </span>
            <p class="f-msg">{pwErr ? 'Type a password, or remove it.' : "Send the password another way, not in the same message as the link."}</p>
          </div>
        )}
        {draft.hideEmail && <p class="f-msg">The page will warn the person that the sender hid their email, and to check they trust the link.</p>}
      </div>
      <div class="body-foot">
        {err && (
          <div class="note warn" role="alert">
            <div>{err}</div>
          </div>
        )}
        <Busy busy={!!busy} label={busy ?? ''} class="btn wide" id="share-create" disabled={!ready} onClick={() => void create()}>
          Create and copy link
        </Busy>
      </div>
      {discard && (
        <div class="sheet" onClick={(e) => e.target === e.currentTarget && setDiscard(false)}>
          <div class="h-card" role="dialog" aria-label="Discard message">
            <div class="h-head">
              <b>Discard this message?</b>
            </div>
            <p>No link has been made yet.</p>
            <div class="c-actions">
              <button class="btn sec" onClick={() => setDiscard(false)}>
                Keep writing
              </button>
              <button class="btn danger" onClick={onClose}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- one link ----------

function LinkPage({ b, id, fresh, copyLink, show, onDone }: Common & { id: string; fresh: boolean; onDone: () => void }) {
  const [made, setMade] = useState<ShareMade | null>(null);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    send('shareLink', { id }).then(setMade, (e: RemoteError) => {
      show(e.message);
      onDone();
    });
  useEffect(() => void load(), [id]);
  useSharesChanged(() => void load());
  useEsc(() => (del ? setDel(false) : onDone()));

  async function remove() {
    setBusy(true);
    try {
      await send('shareDelete', { id });
      show('Link deleted');
      onDone();
    } catch (e) {
      show((e as Error).message);
      setBusy(false);
      setDel(false);
    }
  }

  const r = made?.row;
  return (
    <div class="scr share">
      <div class="hdr">
        <button class="ib" aria-label="Back" title="Back (Esc)" onClick={onDone}>
          <ArrowLeft />
        </button>
        <h1>{fresh ? 'Link ready' : (r?.title ?? '')}</h1>
      </div>
      {made && r && (
        <div class="body">
          <HttpNote b={b} />
          {fresh && (
            <>
              <div class="done-ic" aria-hidden="true">
                <Check />
              </div>
              <p class="done-t">Link copied</p>
            </>
          )}
          <p class="done-s">
            {r.closed
              ? "This link no longer opens."
              : r.hasPassword
                ? 'Paste it into Slack or email, and send the password another way. Anyone with both can read this until it expires.'
                : 'Paste it into Slack or email. Anyone with the link can read this until it expires.'}
          </p>
          {!r.closed && (
            <div class="linkbox">
              <span id="share-link" title={made.link}>
                {made.link}
              </span>
              <button class="ib" aria-label="Copy link" title="Copy link" onClick={() => void copyLink(made.link)}>
                <Copy />
              </button>
            </div>
          )}
          <div class="facts">
            <div>
              <KindIcon r={r} />
              <span class="fn">{r.title}</span>
            </div>
            <div>
              <Clock />
              {r.closed && !(r.maxViews != null && r.views >= r.maxViews) ? 'Expired' : 'Expires'} {fmtDate(r.endsAt)}
            </div>
            <div>
              <Eye />
              {r.maxViews != null ? viewsText(r) : r.views ? plural(r.views, 'view') : 'Any number of views'}
            </div>
            {r.hasPassword && (
              <div>
                <Lock />
                Needs a password
              </div>
            )}
            {r.hideEmail && (
              <div>
                <MailX />
                Your email is hidden
              </div>
            )}
          </div>
          <div class="two-btn">
            <button class="btn sec" onClick={() => setDel(true)}>
              Delete link
            </button>
            <button class="btn" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      )}
      {del && <DeleteSheet busy={busy} onCancel={() => setDel(false)} onDelete={() => void remove()} />}
    </div>
  );
}
