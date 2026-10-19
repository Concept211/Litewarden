// SPDX-License-Identifier: GPL-3.0-only
// Placeholder popup. The real Slip UI arrives in M2b.
import { render } from 'preact';

function App() {
  return (
    <main style={{ width: '380px', padding: '16px', font: '14px system-ui, sans-serif' }}>
      <strong>Litewarden</strong>
      <p>Scaffold build. The popup lands in M2b.</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
