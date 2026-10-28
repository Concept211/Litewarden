// SPDX-License-Identifier: GPL-3.0-only
// Fill engine. Injected on demand into the tab's frames when the user asks to fill (popup, in-page menu,
// shortcut); it never runs on page load and never reads or sends anything by itself. Fields are found at fill
// time, so pages that re-render their form (SPAs) still work. A "teach this site" rule wins over detection.
import { plan, setValue, type Plan } from '../shared/fields';
import { resolve, type SiteRule } from '../shared/rules';

type Filled = Array<'username' | 'password' | 'totp'>;

type Rules = Record<string, SiteRule> | null;

function fields(rules: Rules): Plan & { totp: HTMLInputElement | null } {
  const rule = rules?.[location.hostname];
  if (rule) {
    const u = resolve(rule.username);
    const p = resolve(rule.password);
    if (u || p) return { username: u, password: p, totp: resolve(rule.totp) };
  }
  return { ...plan(), totp: null };
}

function probe(rules: Rules = null) {
  const p = fields(rules);
  return { score: p.password ? 2 : p.username ? 1 : 0, origin: location.origin, top: window === window.top };
}

function fill(username: string | null, password: string | null, rules: Rules = null, code: string | null = null): Filled {
  const p = fields(rules);
  const done: Filled = [];
  if (p.username && username) {
    setValue(p.username, username);
    done.push('username');
  }
  if (p.password && password) {
    setValue(p.password, password);
    done.push('password');
  }
  if (p.totp && code) {
    setValue(p.totp, code);
    done.push('totp');
  }
  // Leave focus where the user would press Enter next.
  (p.password ?? p.username)?.focus({ preventScroll: true });
  return done;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    (window as unknown as { __lwProbe: typeof probe }).__lwProbe = probe;
    (window as unknown as { __lwFill: typeof fill }).__lwFill = fill;
  },
});
