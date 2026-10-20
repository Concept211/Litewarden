// SPDX-License-Identifier: GPL-3.0-only
// "Northwind", a made-up work-planning app, as a stand-in sign-in page for the demo shots. It is served from
// memory through Playwright's request routing, so the browser really is on https://northwind.io/login and the
// demo vault's logins match it like they would on a real site.
export const HOST = 'northwind.io';
export const ORIGIN = `https://${HOST}`;

const css = `
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font:15px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:#17231f;background:#fff;-webkit-font-smoothing:antialiased}
a{color:#0f6b5c;text-decoration:none}
.split{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);min-height:100%}
.brand{background:#0f6b5c;color:#fff;padding:44px 56px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;letter-spacing:-.01em}
.logo svg{width:30px;height:30px}
.brand h2{font:600 34px/1.15 Georgia,"Times New Roman",serif;letter-spacing:-.01em;margin:0 0 14px;max-width:420px}
.brand p.lede{margin:0 0 30px;color:#cfe9e2;max-width:400px;font-size:16px}
.board{background:#fff;color:#17231f;border-radius:14px;padding:18px 20px;box-shadow:0 18px 40px rgba(6,40,34,.35);max-width:410px}
.board h4{margin:0 0 12px;font-size:13px;color:#52625c;font-weight:600;display:flex;justify-content:space-between}
.board h4 span{font-weight:500}
.task{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid #e6ece9;font-size:14px}
.task:first-of-type{border-top:0}
.chk{width:18px;height:18px;border-radius:5px;border:1.6px solid #9bb0a8;flex:none}
.chk.on{background:#0f6b5c;border-color:#0f6b5c;position:relative}
.chk.on::after{content:"";position:absolute;left:5px;top:1.5px;width:4px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.task em{margin-left:auto;font-style:normal;font-size:12px;color:#52625c}
.task.done b{color:#7a8b84;text-decoration:line-through;font-weight:500}
.task b{font-weight:500}
.task .av{margin-left:auto}
.av{width:24px;height:24px;border-radius:50%;color:#fff;font-size:11px;font-weight:600;display:grid;place-items:center;flex:none}
.bar{height:6px;border-radius:3px;background:#e6ece9;margin-top:14px;overflow:hidden}
.bar i{display:block;height:100%;width:68%;background:#0f6b5c}
.foot-l{font-size:13px;color:#a9d3c9}
.formside{display:flex;flex-direction:column;padding:44px 56px}
.top-r{text-align:right;font-size:14px;color:#52625c}
.center{flex:1;display:flex;align-items:center;justify-content:flex-start;padding-left:max(0px,calc(4vw - 20px))}
form{width:380px}
h1{font-size:28px;line-height:1.2;margin:0 0 6px;letter-spacing:-.02em}
.sub{margin:0 0 26px;color:#52625c}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
.f{position:relative;margin-bottom:18px}
input[type=email],input[type=text],input[type=password]{width:100%;height:46px;border:1.5px solid #c5d1cc;border-radius:10px;padding:0 14px;font:inherit;color:inherit;background:#fff;outline:0}
input:focus{border-color:#0f6b5c;box-shadow:0 0 0 3px rgba(15,107,92,.16)}
.eye{position:absolute;right:6px;top:6px;height:34px;width:38px;border:0;background:transparent;border-radius:8px;color:#52625c;cursor:pointer;display:grid;place-items:center}
.eye svg{width:20px;height:20px}
.row{display:flex;justify-content:space-between;align-items:center;margin:2px 0 22px;font-size:14px}
.row label{display:flex;gap:8px;align-items:center;font-weight:400;margin:0}
.row input{width:16px;height:16px;accent-color:#0f6b5c;margin:0}
button.go{width:100%;height:48px;border:0;border-radius:10px;background:#0f6b5c;color:#fff;font:600 16px inherit;font-family:inherit;cursor:pointer}
button.go:hover{background:#0c5a4d}
.or{display:flex;align-items:center;gap:14px;color:#7a8b84;font-size:13px;margin:22px 0}
.or::before,.or::after{content:"";flex:1;height:1px;background:#e0e8e4}
.sso{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sso a{height:44px;border:1.5px solid #c5d1cc;border-radius:10px;display:flex;align-items:center;justify-content:center;gap:8px;color:#17231f;font-weight:600;font-size:14px}
.legal{text-align:center;font-size:12.5px;color:#7a8b84}
.legal a{color:#52625c}
/* dashboard */
.app{display:grid;grid-template-columns:230px 1fr;min-height:100%}
.side{background:#0f6b5c;color:#fff;padding:26px 18px}
.side .logo{padding:0 8px 26px}
.side a{display:block;color:#cfe9e2;padding:9px 12px;border-radius:8px;font-size:14.5px;margin-bottom:2px}
.side a.on{background:rgba(255,255,255,.14);color:#fff;font-weight:600}
.main{background:#f6f8f7;padding:34px 44px}
.wrap{max-width:620px}
.wrap .sub{margin:0 0 6px}
.main h1{font-size:26px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
.card{background:#fff;border:1px solid #e0e8e4;border-radius:12px;padding:18px}
.card small{color:#52625c;font-size:13px}
.card strong{display:block;font-size:30px;letter-spacing:-.02em;margin-top:4px}
`;

const NW = `<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fff"/><path d="M32 11 L47 52 L32 43 L17 52 Z" fill="#0F6B5C"/><path d="M32 11 L32 43 L17 52 Z" fill="#9fd1c4"/></svg>`;
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const G = `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.3 1.7l3.1-3.1A11 11 0 0 0 2.1 7.1l3.6 2.8C6.6 7.4 9.1 5.4 12 5.4z"/></svg>`;
const KEY = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;

const head = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>${css}</style></head>`;

/** Sign-in page. `?next` etc. are ignored; the form posts to /login and gets sent to /dashboard. */
export const loginPage =
  head('Sign in to Northwind') +
  `<body><div class="split">
<aside class="brand">
  <div class="logo">${NW}Northwind</div>
  <div>
    <h2>Plan the work. Ship on time.</h2>
    <p class="lede">Tasks, timelines and team updates in one calm place, so Monday starts with a plan.</p>
    <div class="board">
      <h4>Launch week <span>6 of 9 done</span></h4>
      <div class="task done"><span class="chk on"></span><b>Final copy review</b><span class="av" style="background:#c2410c">JR</span></div>
      <div class="task done"><span class="chk on"></span><b>Update pricing page</b><span class="av" style="background:#2563eb">KT</span></div>
      <div class="task"><span class="chk"></span><b>Record the walkthrough video</b><span class="av" style="background:#7c3aed">MS</span></div>
      <div class="task"><span class="chk"></span><b>Email the beta list</b><span class="av" style="background:#0f766e">AM</span></div>
      <div class="bar"><i></i></div>
    </div>
  </div>
  <div class="foot-l">Trusted by 12,000 small teams</div>
</aside>
<section class="formside">
  <div class="top-r">New to Northwind? <a href="/signup">Create an account</a></div>
  <div class="center">
    <form id="f" method="post" action="/login">
      <h1>Welcome back</h1>
      <p class="sub">Sign in to pick up where you left off.</p>
      <label for="email">Email</label>
      <div class="f"><input id="email" name="email" type="email" autocomplete="username" placeholder="you@company.com"></div>
      <label for="pw">Password</label>
      <div class="f"><input id="pw" name="password" type="password" autocomplete="current-password" placeholder="Your password"><button type="button" class="eye" aria-label="Show password" onclick="var p=document.getElementById('pw');p.type=p.type==='password'?'text':'password'">${EYE}</button></div>
      <div class="row"><label><input type="checkbox" checked> Keep me signed in</label><a href="/forgot">Forgot password?</a></div>
      <button class="go" type="submit">Sign in</button>
      <div class="or">or continue with</div>
      <div class="sso"><a href="/sso/google">${G} Google</a><a href="/sso">${KEY} Single sign-on</a></div>
      <p class="legal" style="margin-top:26px">By signing in you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
    </form>
  </div>
</section></div></body></html>`;

export const dashboardPage =
  head('Northwind') +
  `<body><div class="app"><aside class="side"><div class="logo">${NW}Northwind</div><a class="on" href="#">Home</a><a href="#">My tasks</a><a href="#">Projects</a><a href="#">Timeline</a><a href="#">Team</a><a href="#">Settings</a></aside>
<main class="main"><div class="wrap"><h1>Good morning, Alex</h1><p class="sub">You have 4 tasks due today.</p>
<div class="cards"><div class="card"><small>Due today</small><strong>4</strong></div><div class="card"><small>In progress</small><strong>11</strong></div><div class="card"><small>Done this week</small><strong>23</strong></div></div>
<div class="card"><small>Launch week</small>
<div class="task" style="border:0"><span class="chk"></span><b>Record the walkthrough video</b><span class="av" style="background:#7c3aed">MS</span></div>
<div class="task"><span class="chk"></span><b>Email the beta list</b><span class="av" style="background:#0f766e">AM</span></div>
<div class="task"><span class="chk on"></span><b style="color:#7a8b84;text-decoration:line-through">Update pricing page</b><span class="av" style="background:#2563eb">KT</span></div>
<div class="bar"><i></i></div></div></div></main></div></body></html>`;

export const signupPage = loginPage.replace('Welcome back', 'Create your account').replace('Sign in to pick up where you left off.', 'Free for teams of up to five.').replace('Sign in</button>', 'Create account</button>').replace('autocomplete="current-password"', 'autocomplete="new-password"');

/** Route the whole origin to the in-memory pages. */
export async function installDemoSite(context) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const html = (b) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: b });
    if (u.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (route.request().method() === 'POST') return route.fulfill({ status: 303, headers: { location: '/dashboard' }, body: '' });
    if (u.pathname === '/dashboard') return html(dashboardPage);
    if (u.pathname === '/signup') return html(signupPage);
    return html(loginPage);
  });
}
