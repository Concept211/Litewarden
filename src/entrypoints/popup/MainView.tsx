// SPDX-License-Identifier: GPL-3.0-only
// Main popup (Slip): this site's logins as cards on top, recents below, search over everything.
// Enter fills the selected login, a click fills, the stubs copy. Edit is a separate control.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AppWindow, CloudOff, Keyboard, KeyRound, Lock, NotebookText, Pencil, Plus, RefreshCw, Search, Settings, Timer, User, X } from 'lucide-preact';
import { SearchIndex, type Range, type SearchHit } from '../../core/search';
import { secondsRemaining, totp } from '../../core/totp';
import { RemoteError, send, type FillResult } from '../../shared/messages';
import { mem, type IndexItem } from '../../shared/store';
import { Keep, Tile, Toast, ago, initIcons, useToast } from '../../ui/bits';
import { HelpRows } from '../../ui/help';
import { VList } from '../../ui/vlist';
import { targetTab, type Boot, type Tab } from './boot';

interface Doc {
  id: string;
  name: string;
  username: string | null;
  urls: string[];
  notes: string | null;
  favorite: boolean;
  item: IndexItem;
}

type Entry = { item: IndexItem; hit?: SearchHit<Doc> };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

function Hl({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ComponentChildren[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** A short window of the notes around the first match, so a notes hit is readable on one line. */
function notesSnippet(notes: string, ranges: Range[]): { text: string; ranges: Range[] } {
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, notes.lastIndexOf('\n', first) + 1, first - 24);
  // Begin on a whole word so the snippet doesn't open mid-word.
  if (start > 0 && notes[start - 1] !== '\n') {
    const sp = notes.indexOf(' ', start);
    if (sp >= 0 && sp < first) start = sp + 1;
  }
  const line = notes.slice(start).split('\n')[0] ?? '';
  return { text: (start > 0 ? '…' : '') + line, ranges: ranges.map(([a, b]) => [a - start + (start > 0 ? 1 : 0), b - start + (start > 0 ? 1 : 0)] as Range).filter(([a]) => a >= 0 && a < line.length + 1) };
}

/** What the new-login form starts from: the site in the tab, if any. */
export interface NewPrefill {
  host: string | null;
  origin: string | null;
}

/** Kept by App while an item or Settings is open, so coming back lands where you were. */
export interface MainKeep {
  query: string;
}

export function Main({
  boot: b,
  keep,
  flashMsg,
  onLocked,
  onSettings,
  onOpen,
  onNew,
}: {
  boot: Boot;
  keep: MainKeep;
  flashMsg?: string | null;
  onLocked: () => void;
  onSettings: () => void;
  onOpen: (id: string) => void;
  onNew: (p: NewPrefill) => void;
}) {
  const [index, setIndex] = useState<IndexItem[] | null>(null);
  const [count, setCount] = useState(b.count);
  const [site0, setSite0] = useState<IndexItem[] | null>(b.siteItems);
  const [query, setQueryRaw] = useState(keep.query);
  const setQuery = (q: string) => {
    keep.query = q;
    setQueryRaw(q);
  };
  const [sel, setSel] = useState(0);
  const [moved, setMoved] = useState(false);
  const [help, setHelp] = useState(false);
  const [confirm, setConfirm] = useState<{ item: IndexItem; kind: 'site' | 'frame'; origin?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [secs, setSecs] = useState(secondsRemaining());
  const [sync, setSync] = useState({ at: b.lastSync, err: b.lastSyncError, busy: false });
  const [notes, setNotes] = useState<Record<string, string> | null>(null);
  const { toast, show, hide } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const secrets = useRef<Record<string, string>>({});
  const [tab, setTab] = useState<Tab | null>(b.tab);
  const site = tab && /^https?:/i.test(tab.url) ? hostOf(tab.url) : null;
  const origin = site && tab ? new URL(tab.url).origin : null;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // ----- start-up: focus, icons, auto-lock touch, matches when the worker hadn't computed them -----
  useEffect(() => {
    inputRef.current?.focus();
    if (b.account) void initIcons(b.account.server);
    void send('touch').catch(() => {});
    if (site0 == null && tab && site) void send('matchTab', { tabId: tab.id, url: tab.url }).then((r) => setSite0(r.items)).catch(() => setSite0([]));
    else if (!site) setSite0([]);
    performance.mark('lw-interactive');
    if (flashMsg) show(flashMsg);
    // The full index (search, counts) loads right after the first paint.
    setTimeout(() => void mem.get('index').then((r) => setIndex(r.index ?? [])), 0);
    const onStore = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && ch.index?.newValue) {
        setIndex(ch.index.newValue as IndexItem[]);
        setCount((ch.index.newValue as IndexItem[]).length);
        // The vault changed (sync, a live update, an edit): re-match this page. The worker does the same for the
        // active tab, but the pop-out's page and a test's target tab aren't always the active one.
        const t = tabRef.current;
        if (t && /^https?:/i.test(t.url)) void send('matchTab', { tabId: t.id, url: t.url }).then((r) => tabRef.current?.id === t.id && setSite0(r.items)).catch(() => {});
      }
      if (area === 'session' && ch.tabMatches?.newValue) {
        const t = tabRef.current;
        const m = t && (ch.tabMatches.newValue as Record<string, { url: string; items?: IndexItem[] }>)[t.id];
        if (t && m && m.url === t.url && m.items) setSite0(m.items);
      }
      if (area === 'session' && ch.session && !ch.session.newValue) onLocked();
      if (area === 'session' && ch.notes?.newValue && notes) setNotes(ch.notes.newValue as Record<string, string>);
      if (area === 'local' && ch.lastSync) setSync((s) => ({ ...s, at: (ch.lastSync!.newValue as number) ?? s.at }));
    };
    chrome.storage.onChanged.addListener(onStore);
    return () => chrome.storage.onChanged.removeListener(onStore);
  }, []);

  // The pop-out stays open: follow whichever tab is active in the browser window behind it.
  useEffect(() => {
    if (!b.popout) return;
    let t = 0;
    const follow = () => {
      clearTimeout(t);
      t = window.setTimeout(async () => {
        const next = await targetTab();
        const cur = tabRef.current;
        if (!next || (cur && next.id === cur.id && next.url === cur.url)) return;
        setTab(next);
        setSel(0);
        if (!/^https?:/i.test(next.url)) return setSite0([]);
        const { tabMatches } = await mem.get('tabMatches');
        const m = tabMatches?.[next.id];
        if (m && m.url === next.url) setSite0(m.items);
        else setSite0(await send('matchTab', { tabId: next.id, url: next.url }).then((r) => r.items).catch(() => []));
      }, 120);
    };
    chrome.tabs.onActivated.addListener(follow);
    chrome.tabs.onUpdated.addListener(follow);
    chrome.windows.onFocusChanged.addListener(follow);
    return () => {
      chrome.tabs.onActivated.removeListener(follow);
      chrome.tabs.onUpdated.removeListener(follow);
      chrome.windows.onFocusChanged.removeListener(follow);
    };
  }, []);

  const matches = site0;
  const siteItems = site0 ?? [];
  const recentItems = useMemo(() => {
    const skip = new Set(siteItems.map((i) => i.id));
    return b.recentItems.filter((x) => !skip.has(x.id)).slice(0, 5);
  }, [siteItems]);

  // ----- search (built on first keystroke; notes load then too) -----
  const searchIndex = useMemo(() => {
    if (!query.trim() || !index) return null;
    const docs: Doc[] = index.map((it) => ({ id: it.id, name: it.name, username: it.username ?? it.subtitle ?? null, urls: it.hosts, notes: notes?.[it.id] ?? null, favorite: it.favorite, item: it }));
    return new SearchIndex(docs);
  }, [index, notes, !!query.trim()]);
  useEffect(() => {
    if (query.trim() && notes == null) void mem.get('notes').then((r) => setNotes(r.notes ?? {}));
  }, [query]);
  const hits = useMemo(() => (searchIndex && query.trim() ? searchIndex.search(query) : []), [searchIndex, query]);

  // Below this site's cards and the recents: every item A to Z (virtualized), so the popup is never a void.
  const allItems = index ?? [];
  const flat: Entry[] = query.trim() ? hits.slice(0, 60).map((h) => ({ item: h.doc.item, hit: h })) : [...siteItems, ...recentItems, ...allItems].map((item) => ({ item }));
  const selIdx = Math.min(sel, flat.length - 1);

  // ----- live 2FA codes for the visible cards -----
  const totpIds = useMemo(() => (query.trim() ? [] : siteItems.filter((i) => i.hasTotp).map((i) => i.id)), [siteItems, query]);
  useEffect(() => {
    if (!totpIds.length) return;
    let live = true;
    const missing = totpIds.filter((id) => !secrets.current[id]);
    const tick = async () => {
      const out: Record<string, string> = {};
      for (const id of totpIds) if (secrets.current[id]) out[id] = await totp(secrets.current[id]!).catch(() => '');
      if (live) {
        setCodes(out);
        setSecs(secondsRemaining());
      }
    };
    void (missing.length ? send('getTotpSecrets', { ids: missing }).then((s) => Object.assign(secrets.current, s)) : Promise.resolve()).then(tick);
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [totpIds.join()]);

  // ----- actions -----
  const flash = (key: string) => {
    setDone(key);
    setTimeout(() => setDone((d) => (d === key ? null : d)), 1200);
  };

  async function copy(item: IndexItem, field: 'username' | 'password' | 'totp') {
    try {
      let value: string | null;
      if (field === 'totp') {
        const secret = secrets.current[item.id] ?? (await send('getSecret', { id: item.id, field: 'totp' })).value;
        if (!secret) return show('This login has no 2FA code.');
        secrets.current[item.id] = secret;
        value = await totp(secret);
      } else value = (await send('getSecret', { id: item.id, field })).value;
      if (!value) return show(field === 'username' ? 'This login has no username.' : 'This login has no password.');
      await navigator.clipboard.writeText(value);
      flash(`${item.id}:${field}`);
      if (field === 'username') return show('Username copied');
      await send('clipboardCopied', {});
      const s = b.settings.clipboardSeconds;
      show(field === 'password' ? 'Password copied' : `Code ${value.slice(0, 3)} ${value.slice(3)} copied`, s);
    } catch (e) {
      show((e as Error).message);
    }
  }

  async function fill(item: IndexItem, opts: { force?: boolean; allowFrame?: boolean } = {}) {
    if (!tab) return show('No page to fill. Open the site first.');
    if (item.type !== 1) return show('Only logins can be filled. Use the copy buttons instead.');
    let r: FillResult;
    try {
      r = await send('fill', { tabId: tab.id, id: item.id, ...opts });
    } catch (e) {
      return show((e as RemoteError).message);
    }
    if (r.outcome === 'confirm-site') return setConfirm({ item, kind: 'site' });
    if (r.outcome === 'confirm-frame') return setConfirm({ item, kind: 'frame', origin: r.frameOrigin! });
    setConfirm(null);
    if (r.outcome === 'blocked-page') return show("Litewarden can't fill on this page. Browser pages and the Chrome Web Store are off limits.");
    if (r.outcome === 'no-fields') return show('No login form found on this page. Use the copy buttons instead.');
    let copied = false;
    if (item.hasTotp && b.settings.copyTotpAfterFill) {
      try {
        const secret = secrets.current[item.id] ?? (await send('getSecret', { id: item.id, field: 'totp' })).value;
        if (secret) {
          await navigator.clipboard.writeText(await totp(secret));
          await send('clipboardCopied', {});
          copied = true;
        }
      } catch {
        // filling worked; the code copy is a bonus
      }
    }
    if (b.popout) return show(`Filled ${item.username ?? item.name}${copied ? '. 2FA code copied' : ''}`, copied ? b.settings.clipboardSeconds : 0);
    window.close();
  }

  function open(item: IndexItem) {
    keep.query = query;
    onOpen(item.id);
  }

  async function popOut() {
    try {
      await send('popout', {});
      window.close();
    } catch (e) {
      show((e as Error).message);
    }
  }

  async function doSync() {
    setSync((s) => ({ ...s, busy: true }));
    try {
      const r = await send('sync');
      setSync({ at: Date.now(), err: null, busy: false });
      show(`Vault synced. ${r.count.toLocaleString()} items, ${r.changed ? `${r.changed} changed` : 'nothing changed'}`);
    } catch (e) {
      setSync((s) => ({ ...s, err: (e as Error).message, busy: false }));
      show("Sync didn't work. Your vault on this device is unchanged.");
    }
  }

  async function lockNow() {
    await send('lock');
    onLocked();
  }

  // ----- keyboard -----
  // One listener for the popup's life; it reads the latest render through a ref, so a fast second key press
  // (Enter on the confirm sheet) never lands on a stale handler.
  const live = useRef({ help, confirm, flat, selIdx, query, fill, copy, open });
  live.current = { help, confirm, flat, selIdx, query, fill, copy, open };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { help, confirm, flat, selIdx, query, fill, copy, open } = live.current;
      if (help && (e.key === 'Escape' || e.key === '?')) {
        e.preventDefault();
        return setHelp(false);
      }
      if (confirm) {
        if (e.key === 'Enter') {
          e.preventDefault();
          return void fill(confirm.item, confirm.kind === 'site' ? { force: true } : { force: true, allowFrame: true });
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          return setConfirm(null);
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!flat.length) return;
        setMoved(true);
        setSel((s) => (e.key === 'ArrowDown' ? Math.min(flat.length - 1, Math.max(0, s) + 1) : Math.max(0, s - 1)));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const it = flat[selIdx]?.item;
        if (it) void fill(it);
        return;
      }
      if (e.altKey && /^e$/i.test(e.key)) {
        e.preventDefault();
        const it = flat[selIdx]?.item;
        if (it) open(it);
        return;
      }
      if (e.altKey && /^[upt]$/i.test(e.key)) {
        e.preventDefault();
        const it = flat[selIdx]?.item;
        if (it) void copy(it, ({ u: 'username', p: 'password', t: 'totp' } as const)[e.key.toLowerCase() as 'u' | 'p' | 't']);
        return;
      }
      if (e.key === '?' && !query) {
        e.preventDefault();
        return setHelp(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (query) {
          setQuery('');
          setSel(0);
        } else if (!b.popout) window.close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // Rows in the virtual list scroll themselves into view (VList); the rest are always in the DOM.
    if (moved && (query.trim() || selIdx < siteItems.length + recentItems.length)) document.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [selIdx, moved]);

  // ----- render -----
  const isSel = (i: number) => i === selIdx;
  const card = (item: IndexItem, i: number) => (
    <div class={`card${isSel(i) ? ' is-sel' : ''}`} data-row data-id={item.id} onClick={() => (setSel(i), void fill(item))}>
      <div class="c-top">
        <Tile item={item} />
        <div class="who">
          <div class="nm">{item.name}</div>
          <div class="un">{item.username}</div>
        </div>
        <span class="go">↵ Fill</span>
        <button
          class="ib"
          title="Open and edit (Alt E)"
          aria-label={`Open ${item.name}`}
          onClick={(e) => {
            e.stopPropagation();
            open(item);
          }}
        >
          <Pencil />
        </button>
      </div>
      <div class="stubs" onClick={(e) => e.stopPropagation()}>
        <button class={`stub${done === `${item.id}:username` ? ' done' : ''}`} onClick={() => copy(item, 'username')}>
          <span>User</span>
        </button>
        <button class={`stub${done === `${item.id}:password` ? ' done' : ''}`} onClick={() => copy(item, 'password')}>
          <span>Password</span>
        </button>
        {item.hasTotp ? (
          <button class={`stub${done === `${item.id}:totp` ? ' done' : ''}`} title="Copy 2FA code" onClick={() => copy(item, 'totp')}>
            <span class="code">{codes[item.id] ? `${codes[item.id]!.slice(0, 3)} ${codes[item.id]!.slice(3)}` : '··· ···'}</span>
            <span class={`ring${secs <= 5 ? ' low' : ''}`} style={{ '--t': secs / 30 }} />
          </button>
        ) : (
          <span class="stub none">No 2FA</span>
        )}
      </div>
    </div>
  );

  const row = (e: Entry, i: number, style?: Record<string, string>) => {
    const { item, hit } = e;
    const login = item.type === 1;
    const sub = login ? [item.username, item.hosts[0]].filter(Boolean) : [item.subtitle ?? (item.type === 3 ? 'Card' : item.type === 2 ? 'Note' : 'Identity')];
    const r = hit?.ranges;
    const notesOnly = !!(r && r.notes.length && !r.name.length && !r.username.length && !r.url.size && notes?.[item.id]);
    const snip = notesOnly ? notesSnippet(notes![item.id]!, r!.notes) : null;
    return (
      <div class={`row${isSel(i) ? ' is-sel' : ''}`} data-row data-id={item.id} style={style} onClick={() => (setSel(i), login ? void fill(item) : open(item))}>
        <Tile item={item} />
        <div class="who">
          <div class="nm">
            <Hl text={item.name} ranges={r?.name} />
          </div>
          <div class="un">
            {login ? (
              <>
                {item.username && <Hl text={item.username} ranges={r?.username} />}
                {item.username && item.hosts[0] && ' · '}
                {item.hosts[0] && <Hl text={item.hosts[0]} ranges={r?.url.get(0)} />}
              </>
            ) : (
              sub[0]
            )}
          </div>
          {snip && (
            <div class="un nt">
              <NotebookText />
              <Hl text={snip.text} ranges={snip.ranges} />
            </div>
          )}
        </div>
        {login && (
          <span style={{ display: 'contents' }} onClick={(ev) => ev.stopPropagation()}>
            <button class={`ib${done === `${item.id}:username` ? ' done' : ''}`} title="Copy username" aria-label="Copy username" onClick={() => copy(item, 'username')}>
              <User />
            </button>
            <button class={`ib${done === `${item.id}:password` ? ' done' : ''}`} title="Copy password" aria-label="Copy password" onClick={() => copy(item, 'password')}>
              <KeyRound />
            </button>
            {item.hasTotp && (
              <button class={`ib${done === `${item.id}:totp` ? ' done' : ''}`} title="Copy 2FA code" aria-label="Copy 2FA code" onClick={() => copy(item, 'totp')}>
                <Timer />
              </button>
            )}
          </span>
        )}
        <button
          class="ib"
          title="Open and edit (Alt E)"
          aria-label={`Open ${item.name}`}
          onClick={(ev) => {
            ev.stopPropagation();
            open(item);
          }}
        >
          <Pencil />
        </button>
      </div>
    );
  };

  const server = b.account?.server.replace(/^https?:\/\//, '') ?? '';
  let body: ComponentChildren;
  if (!count && !query.trim()) {
    body = (
      <div class="empty">
        <h3>Your vault is empty</h3>
        <p>Logins you save on {server} show up here, with the ones for the current site on top.</p>
        <div class="nm-acts">
          <button class="btn" onClick={() => onNew({ host: site, origin })}>
            <Plus />
            {site ? `Save a login for ${site}` : 'Add a login'}
          </button>
        </div>
      </div>
    );
  } else if (query.trim()) {
    body = hits.length ? (
      <>
        <div class="sec">
          <span>
            {hits.length.toLocaleString()} {hits.length === 1 ? 'match' : 'matches'} <span class="q">for “{query.trim()}”</span>
          </span>
          <span>{hits.length > 60 ? 'top 60' : ''}</span>
        </div>
        <div class="list">{flat.map((e, i) => row(e, i))}</div>
      </>
    ) : (
      <div class="empty nomatch">
        <h3>No match for “{query.trim()}”</h3>
        <p>Searched names, usernames, sites{notes ? ' and notes' : ''} in {count.toLocaleString()} items. Check the spelling.</p>
        <div class="nm-acts">
          <button class="btn sec" onClick={() => (setQuery(''), inputRef.current?.focus())}>
            Clear search
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {site && (
          <>
            <div class="sec">
              <span>{site}</span>
              <span>{matches == null ? '' : `${siteItems.length} ${siteItems.length === 1 ? 'login' : 'logins'}`}</span>
            </div>
            {matches != null && !siteItems.length && (
              <div class="empty">
                <h3>Nothing saved for this site</h3>
                <p>Save one now with your default username and a new password, or search the vault and fill from there.</p>
                <button class="btn" onClick={() => onNew({ host: site, origin })}>
                  <Plus />
                  Save a login for this site
                </button>
              </div>
            )}
            {siteItems.map((it, i) => card(it, i))}
          </>
        )}
        {recentItems.length > 0 && (
          <>
            <div class="sec">
              <span>Recently used</span>
            </div>
            <div class="list">{recentItems.map((item, k) => row({ item }, siteItems.length + k))}</div>
          </>
        )}
        {allItems.length > 0 && (
          <>
            <div class="sec">
              <span>All items</span>
              <span>{allItems.length.toLocaleString()}</span>
            </div>
            <VList
              count={allItems.length}
              offset={siteItems.length + recentItems.length}
              sel={selIdx}
              moved={moved}
              scroller="list"
              render={(k, style) => row({ item: allItems[k]! }, siteItems.length + recentItems.length + k, style)}
            />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div class="top">
        <label>
          <Search />
          <input
            id="q"
            ref={inputRef}
            placeholder={count ? `Search ${count.toLocaleString()} items` : 'Search'}
            aria-label="Search vault"
            autocomplete="off"
            spellcheck={false}
            value={query}
            onInput={(e) => {
              setQuery((e.currentTarget as HTMLInputElement).value);
              setSel(0);
            }}
          />
          {query && (
            <button class="ib" style={{ width: '24px', height: '24px' }} aria-label="Clear search" onClick={() => (setQuery(''), inputRef.current?.focus())}>
              <X />
            </button>
          )}
        </label>
        <button class="ib" title="New login" aria-label="New login" onClick={() => onNew({ host: site, origin })}>
          <Plus />
        </button>
        {!b.popout && (
          <button class="ib" title="Pop out (stays open)" aria-label="Pop out" onClick={popOut}>
            <AppWindow />
          </button>
        )}
      </div>
      <div id="list">
        {sync.err && (
          <div class="warn">
            <CloudOff />
            <div>
              <b>Can't reach {server}</b>
              <p>Showing what was synced {ago(sync.at).replace('Synced ', '')}.</p>
            </div>
            <button class="btn" onClick={doSync}>
              Retry
            </button>
          </div>
        )}
        {b.failures > 0 && (
          <div class="warn">
            <div>
              <b>{b.failures} items couldn't be decrypted</b>
              <p>They're unchanged on the server. Open the web vault to check them.</p>
            </div>
          </div>
        )}
        {body}
      </div>
      <div class="foot">
        <span class="brand">
          <Keep />
          Litewarden
        </span>
        <span class="st">
          <button class={`ib${sync.busy ? ' spin' : ''}`} aria-label="Sync now" title="Sync now" onClick={doSync} disabled={sync.busy}>
            <RefreshCw />
          </button>
          <span data-sync-label>{sync.busy ? 'Syncing…' : ago(sync.at)}</span>
        </span>
        <button class="ib" title="Lock" aria-label="Lock" onClick={lockNow}>
          <Lock />
        </button>
        <button class="ib" title="Settings" aria-label="Settings" onClick={onSettings}>
          <Settings />
        </button>
        <button class="ib" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
          <Keyboard />
        </button>
      </div>
      <Toast t={toast} onDone={hide} />
      {confirm && (
        <div id="confirm" class="show" role="dialog">
          <p>
            {confirm.kind === 'site' ? (
              <>
                Fill a <b>{confirm.item.hosts[0] ?? 'non-web'}</b> login on <b>{site}</b>? The sites don't match.
              </>
            ) : (
              <>
                The login form on this page comes from <b>{confirm.origin?.replace(/^https?:\/\//, '')}</b>, not <b>{site}</b>. Fill it anyway?
              </>
            )}
          </p>
          <div class="c-actions">
            <button class="c-cancel" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button class="c-ok" onClick={() => void fill(confirm.item, confirm.kind === 'site' ? { force: true } : { force: true, allowFrame: true })}>
              Fill anyway
            </button>
          </div>
        </div>
      )}
      {help && (
        <div id="help" class="open" onClick={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div class="h-card" role="dialog" aria-label="Keyboard shortcuts">
            <div class="h-head">
              <b>Keyboard shortcuts</b>
              <button class="h-x ib" aria-label="Close" onClick={() => setHelp(false)}>
                <X />
              </button>
            </div>
            <HelpRows />
            <p class="h-foot">Change the Chrome shortcut at chrome://extensions/shortcuts. Press Esc or ? to close.</p>
          </div>
        </div>
      )}
    </>
  );
}
