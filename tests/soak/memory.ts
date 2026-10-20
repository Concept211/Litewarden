// SPDX-License-Identifier: GPL-3.0-only
// Memory sampling for the soak test: JS heap of the service worker and of long-lived pages (after a forced GC),
// plus the browser's total process memory. Heap numbers are after garbage collection, so growth means retained
// memory, not garbage that hasn't been collected yet.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

export interface HeapSample {
  usedMB: number;
  totalMB: number;
}

const MB = 1024 * 1024;
const round = (n: number) => Math.round(n * 100) / 100;

/** Heap of a Playwright page (popup or tab; content scripts run in the tab's isolate, so they're counted here). */
export async function pageHeap(p: Page): Promise<HeapSample> {
  const cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const h = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number };
    return { usedMB: round(h.usedSize / MB), totalMB: round(h.totalSize / MB) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Heap of the extension's service worker, through the browser's remote-debugging port (Playwright doesn't expose
 * CDP sessions for workers). Returns null when the worker isn't running at that moment.
 */
export async function workerHeap(debugPort: number, extId: string): Promise<HeapSample | null> {
  const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
  const t = list.find((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`) && x.webSocketDebuggerUrl);
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl!);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('worker debugger socket failed'));
  });
  let id = 0;
  const call = (method: string) =>
    new Promise<Record<string, number>>((res, rej) => {
      const my = ++id;
      const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 15_000);
      ws.addEventListener('message', function on(ev) {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, number>; error?: { message: string } };
        if (m.id !== my) return;
        clearTimeout(timer);
        ws.removeEventListener('message', on);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result ?? {});
      });
      ws.send(JSON.stringify({ id: my, method }));
    });
  try {
    await call('HeapProfiler.collectGarbage');
    const h = await call('Runtime.getHeapUsage');
    return { usedMB: round(h.usedSize! / MB), totalMB: round(h.totalSize! / MB) };
  } finally {
    ws.close();
  }
}

/**
 * Total resident memory (MB) of every browser process started with `profileDir` on its command line, or null if
 * the OS query failed this time (a sampler hiccup is recorded as a gap, never a failed run).
 */
export function processMemoryMB(profileDir: string): number | null {
  try {
    return processMemoryOnce(profileDir);
  } catch {
    return null;
  }
}

function processMemoryOnce(profileDir: string): number {
  if (process.platform === 'win32') {
    const needle = profileDir.replace(/'/g, "''");
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | Measure-Object WorkingSetSize -Sum).Sum`],
      { encoding: 'utf8' },
    );
    return round(Number(out.trim() || 0) / MB);
  }
  const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8', maxBuffer: 16 * MB });
  let kb = 0;
  for (const line of out.split('\n')) if (line.includes(profileDir)) kb += Number(line.trim().split(/\s+/)[0]) || 0;
  return round(kb / 1024);
}

/** Least-squares slope of y over x. */
export function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den ? num / den : 0;
}

export const median = (ys: number[]) => {
  const s = [...ys].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * Pass rule for one series (heap MB over hours). Skip the warm-up, fit a line, and take the fitted growth over the
 * measured window. It passes when that growth stays under max(5 MB, 25% of the post-warm-up median). For the
 * 12-hour run the window is the session itself; a short run can only rule out a leak big enough to show in its own
 * window, so the 12-hour projection is reported for information, not judged.
 */
export function judge(hours: number[], mb: number[], warmupHours: number) {
  const keep = hours.map((h, i) => [h, mb[i]!] as const).filter(([h]) => h >= warmupHours);
  const xs = keep.map(([h]) => h);
  const ys = keep.map(([, m]) => m);
  const s = slope(xs, ys);
  const base = median(ys);
  const windowH = xs.length ? xs[xs.length - 1]! - xs[0]! : 0;
  const growth = s * windowH;
  const limit = Math.max(5, base * 0.25);
  return {
    samples: ys.length,
    start: ys[0] ?? null,
    end: ys[ys.length - 1] ?? null,
    min: ys.length ? Math.min(...ys) : null,
    max: ys.length ? Math.max(...ys) : null,
    slopeMBperHour: round(s),
    fittedGrowthMB: round(growth),
    projected12hMB: round(s * 12),
    limitMB: round(limit),
    pass: ys.length >= 3 ? growth < limit : null,
  };
}
