// SPDX-License-Identifier: GPL-3.0-only
import { useState } from 'preact/hooks';
import { applyTheme, boot, type Boot } from './boot';
import { FirstRun } from './FirstRun';
import { Main } from './MainView';
import { SettingsView } from './Settings';
import { Unlock } from './Unlock';

export function App({ boot: initial }: { boot: Boot }) {
  const [b, setB] = useState(initial);
  const [view, setView] = useState<Boot['view'] | 'settings'>(initial.view);
  const reload = async (next?: Boot['view'] | 'settings') => {
    const nb = await boot();
    applyTheme(nb.settings.theme);
    setB(nb);
    setView(nb.view === 'main' && next ? next : nb.view);
  };
  if (view === 'firstrun') return <FirstRun onDone={() => reload()} />;
  if (view === 'unlock') return <Unlock boot={b} onUnlocked={() => reload()} onLoggedOut={() => reload()} />;
  if (view === 'settings') return <SettingsView boot={b} onBack={() => reload('main')} onChanged={() => reload('settings')} onLoggedOut={() => reload()} />;
  return <Main boot={b} onLocked={() => reload()} onSettings={() => setView('settings')} />;
}
