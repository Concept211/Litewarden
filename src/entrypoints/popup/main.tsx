// SPDX-License-Identifier: GPL-3.0-only
import { render } from 'preact';
import '@fontsource/hanken-grotesk/latin-400.css';
import '@fontsource/hanken-grotesk/latin-500.css';
import '@fontsource/hanken-grotesk/latin-600.css';
import '@fontsource/hanken-grotesk/latin-700.css';
import '@fontsource/hanken-grotesk/latin-800.css';
import '@fontsource/fragment-mono/latin-400.css';
import '../../ui/slip.css';
import { App } from './App';
import { applyTheme, boot } from './boot';

performance.mark('lw-start');
// A popup opened as a normal tab (tests, pop-out later) fills the window instead of the 380x600 frame.
if (new URLSearchParams(location.search).has('wide')) document.documentElement.classList.add('wide');
boot().then((b) => {
  performance.mark('lw-booted');
  applyTheme(b.settings.theme);
  render(<App boot={b} />, document.getElementById('app')!);
});
