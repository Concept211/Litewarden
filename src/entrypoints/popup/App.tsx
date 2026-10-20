// SPDX-License-Identifier: GPL-3.0-only
import type { FunctionComponent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyLook, boot, type Boot } from './boot';
import { FirstRun } from './FirstRun';
import { Main, type MainKeep, type NewPrefill } from './MainView';
import { Unlock } from './Unlock';

type View = Boot['view'] | 'settings' | { item: string } | { new: NewPrefill };

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
  const [view, setView] = useState<View>(initial.view);
  const [flash, setFlash] = useState<string | null>(null);
  const keep = useRef<MainKeep>({ query: '' });
  const ItemView = useLoaded(() => ItemViewC, loadItem, typeof view === 'object');
  const SettingsView = useLoaded(() => SettingsC, loadSettings, view === 'settings');
  // Warm both after the first paint so the first click doesn't wait.
  useEffect(() => {
    const t = setTimeout(() => void loadItem().then(loadSettings), 400);
    return () => clearTimeout(t);
  }, []);
  const reload = async (next?: 'main' | 'settings', msg?: string) => {
    const nb = await boot();
    applyLook(nb.settings);
    setB(nb);
    setFlash(msg ?? null);
    setView(nb.view === 'main' && next ? next : nb.view);
  };
  if (view === 'firstrun') return <FirstRun onDone={() => reload()} />;
  if (view === 'unlock') return <Unlock boot={b} onUnlocked={() => reload()} onLoggedOut={() => reload()} />;
  if (view === 'settings') return SettingsView ? <SettingsView boot={b} onBack={() => reload('main')} onLoggedOut={() => reload()} /> : <Shell />;
  if (typeof view === 'object')
    return ItemView ? (
      <ItemView
        key={'item' in view ? view.item : 'new'}
        boot={b}
        id={'item' in view ? view.item : null}
        prefill={'new' in view ? view.new : undefined}
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
