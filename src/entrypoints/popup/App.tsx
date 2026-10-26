// SPDX-License-Identifier: GPL-3.0-only
import type { FunctionComponent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyLook, boot, type Boot } from './boot';
import { FirstRun } from './FirstRun';
import { Main, type MainKeep, type NewPrefill } from './MainView';
import { Unlock } from './Unlock';
import { here } from './where';
import type { PopupScreen } from '../../shared/store';

type Resume = Extract<PopupScreen, { item: string | null }>;
type View = Boot['view'] | 'settings' | { item: string; resume?: Resume } | { new: NewPrefill; resume?: Resume };

/** The view to open on: the remembered screen, if the vault is open and there is one. */
function firstView(b: Boot): View {
  const w = b.where;
  if (b.view !== 'main' || !w) return b.view;
  if ('settings' in w) return 'settings';
  return w.item ? { item: w.item, resume: w } : { new: w.prefill ?? { host: null, origin: null }, resume: w };
}

// The item editor and Settings load on first use, so opening the popup only parses the main list.
type ItemViewT = typeof import('./ItemView').ItemView;
type SettingsT = typeof import('./Settings').SettingsView;
let ItemViewC: ItemViewT | null = null;
let SettingsC: SettingsT | null = null;
const loadItem = () => import('./ItemView').then((m) => (ItemViewC = m.ItemView));
const loadSettings = () => import('./Settings').then((m) => (SettingsC = m.SettingsView));

function useLoaded<T>(get: () => T | null, load: () => Promise<unknown>, when: boolean): T | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (when && !get()) void load().then(() => force((n) => n + 1));
  }, [when]);
  return get();
}

const Shell: FunctionComponent = () => <div class="scr" aria-busy="true" />;

export function App({ boot: initial }: { boot: Boot }) {
  const [b, setB] = useState(initial);
  const [view, setView] = useState<View>(() => firstView(initial));
  const [flash, setFlash] = useState<string | null>(null);
  const keep = useRef<MainKeep>({ query: '' });
  // The remembered Settings page applies to the first Settings view only.
  const settings0 = useRef(initial.where && 'settings' in initial.where ? initial.where.settings : undefined);
  const ItemView = useLoaded(() => ItemViewC, loadItem, typeof view === 'object');
  const SettingsView = useLoaded(() => SettingsC, loadSettings, view === 'settings');
  // Warm both after the first paint so the first click doesn't wait.
  useEffect(() => {
    const t = setTimeout(() => void loadItem().then(loadSettings), 400);
    return () => clearTimeout(t);
  }, []);
  // Back on the list (or locked): nothing to come back to. Settings and items report their own place.
  useEffect(() => {
    if (view === 'main' || view === 'unlock' || view === 'firstrun') {
      here(null);
      settings0.current = undefined;
    }
  }, [view]);
  const reload = async (next?: 'main' | 'settings', msg?: string) => {
    const nb = await boot();
    applyLook(nb.settings);
    setB(nb);
    setFlash(msg ?? null);
    setView(nb.view === 'main' && next ? next : nb.view);
  };
  if (view === 'firstrun') return <FirstRun onDone={() => reload()} />;
  if (view === 'unlock') return <Unlock boot={b} onUnlocked={() => reload()} onLoggedOut={() => reload()} />;
  if (view === 'settings') return SettingsView ? <SettingsView boot={b} page0={settings0.current} onPage={(page) => here({ settings: page })} onBack={() => reload('main')} onLoggedOut={() => reload()} /> : <Shell />;
  if (typeof view === 'object')
    return ItemView ? (
      <ItemView
        key={'item' in view ? view.item : 'new'}
        boot={b}
        id={'item' in view ? view.item : null}
        prefill={'new' in view ? view.new : undefined}
        resume={view.resume}
        onBack={(msg) => reload('main', msg)}
        onLocked={() => reload()}
      />
    ) : (
      <Shell />
    );
  return (
    <Main
      boot={b}
      keep={keep.current}
      flashMsg={flash}
      onLocked={() => reload()}
      onSettings={() => setView('settings')}
      onOpen={(id) => setView({ item: id })}
      onNew={(p) => setView({ new: p })}
    />
  );
}
