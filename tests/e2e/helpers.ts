// SPDX-License-Identifier: GPL-3.0-only
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { ROOT, serverUrl } from '../../scripts/testserver/env';
import { expect } from './fixtures';

export const VERSION = (process.env.E2E_VERSIONS ?? '1.37.4').split(',')[0]!;
export const SHOTS = path.join(ROOT, '_testserver', 'shots', VERSION);
fs.mkdirSync(SHOTS, { recursive: true });

/** Fail the test on any console error or uncaught exception in a page. */
export function watchErrors(p: Page, sink: string[]) {
  p.on('console', (m) => m.type() === 'error' && sink.push(`${p.url().slice(0, 60)}: ${m.text()}`));
  p.on('pageerror', (e) => sink.push(`${p.url().slice(0, 60)}: ${String(e)}`));
}

export async function shot(p: Page, name: string, scale = 2) {
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  // A device-scale copy for checking 1px edges (lessons.md): CDP renders the same page at `scale`.
  if (scale > 1) {
    const cdp = await p.context().newCDPSession(p);
    const vp = p.viewportSize()!;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale } });
    fs.writeFileSync(path.join(SHOTS, `${name}@${scale}x.png`), Buffer.from(data, 'base64'));
    await cdp.detach();
  }
}

export async function signIn(p: Page, email: string, password: string, version = VERSION) {
  await p.waitForSelector('#url');
  await p.fill('#url', serverUrl(version));
  await p.keyboard.press('Enter');
  await p.waitForSelector('.found');
  await p.keyboard.press('Enter');
  await p.fill('#em', email);
  await p.fill('#pw', password);
  await p.keyboard.press('Enter');
}

/** Spec files share one browser per worker: start each file signed out, like a fresh install. */
export async function signOut(open: () => Promise<Page>) {
  const p = await open();
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'logout' }));
  await p.close();
}

export async function finishFirstRun(p: Page) {
  await expect(p.locator('#open')).toBeEnabled({ timeout: 90_000 });
  await p.click('#open');
  await p.waitForSelector('#q');
}

/** Read the system clipboard from a loopback page (a secure context the test can grant clipboard access to). */
export async function clipboard(ctx: BrowserContext, _extId?: string): Promise<string> {
  const origin = 'http://127.0.0.1:8411';
  let reader = ctx.pages().find((pg) => pg.url().startsWith(origin + '/none.html?reader'));
  if (!reader) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    reader = await ctx.newPage();
    await reader.goto(origin + '/none.html?reader');
  }
  await reader.bringToFront();
  return reader.evaluate(() => navigator.clipboard.readText());
}

/**
 * Stop or start the test server (the "server goes away" tests). Locally: the Windows scripts. In Docker (CI): set
 * LW_DOCKER_<version with dots as underscores> to the container id, and this uses `docker stop/start`.
 */
export function testServer(action: 'start' | 'stop', version = VERSION) {
  const container = process.env[`LW_DOCKER_${version.replace(/\./g, '_')}`];
  if (container) {
    execFileSync('docker', [action, container], { stdio: 'pipe' });
    if (action === 'start') waitAlive(version);
    return;
  }
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'testserver', `${action}.ps1`), '-Versions', version], { stdio: 'pipe' });
}

/** Block until the server answers /alive (up to 60 s). Synchronous on purpose, like the Windows start script. */
function waitAlive(version: string) {
  const url = serverUrl(version) + '/alive';
  for (let i = 0; i < 120; i++) {
    try {
      execFileSync('curl', ['-fsS', '-o', '/dev/null', '--max-time', '2', url], { stdio: 'pipe' });
      return;
    } catch {
      execFileSync('sleep', ['0.5']);
    }
  }
  throw new Error(`${version} did not come back at ${url}`);
}

/**
 * A performance budget. The targets are product targets for real hardware and are enforced as-is locally. CI's
 * shared runners are slower and noisier, so CI sets LW_PERF_SLACK (see .github/workflows/ci.yml) to scale them:
 * a real regression still fails, a busy runner doesn't.
 */
export function budget(ms: number): number {
  const k = Number(process.env.LW_PERF_SLACK ?? '1');
  return ms * (Number.isFinite(k) && k >= 1 ? k : 1);
}
