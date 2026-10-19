# Generates the login-form corpus pages (run once; the HTML files are committed). python -I tests/pages/make.py
import pathlib

here = pathlib.Path(__file__).parent
HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>{t}</title><link rel="stylesheet" href="_base.css">{s}</head><body>\n<header>{h}</header><main>{b}</main>{j}</body></html>\n'
EYE = '<button type="button" class="eye" aria-label="Show password" onclick="p.type=p.type===\'password\'?\'text\':\'password\'">o</button>'

pages = {
    'stacked.html': dict(t='Stacked login', h='Harbor Point Credit Union', b='''<form id="f" onsubmit="event.preventDefault();out.textContent='submitted'">
<h1 style="font-size:20px">Sign in to online banking</h1>
<label for="u">Username</label><div class="f"><input id="u" name="username" autocomplete="username"></div>
<label for="p">Password</label><div class="f"><input id="p" name="password" type="password" autocomplete="current-password">''' + EYE + '''</div>
<label style="display:flex;gap:6px;align-items:center"><input type="checkbox"> Remember this device</label><br>
<button type="submit">Sign in</button><pre id="out"></pre></form>'''),
    'unlabeled.html': dict(t='No autocomplete hints', h='Old portal', b='''<form onsubmit="event.preventDefault()">
<input type="text" name="q" placeholder="Search the site"><br><br>
<div class="f"><input type="text" name="login_id" id="u" placeholder="Login ID"></div>
<div class="f"><input type="password" name="pass" id="p"></div>
<button type="submit">Log in</button></form>'''),
    'step1.html': dict(t='Two-step: email', h='Two-step sign in', b='''<form action="step2.html" method="get">
<label for="e">Email</label><div class="f"><input id="e" name="email" type="email" autocomplete="username"></div>
<button type="submit">Next</button></form>'''),
    'step2.html': dict(t='Two-step: password', h='Two-step sign in', b='''<form onsubmit="event.preventDefault()"><p id="who"></p><input type="hidden" name="username" autocomplete="username" id="hu">
<label for="p">Password</label><div class="f"><input id="p" type="password" autocomplete="current-password"></div>
<button type="submit">Sign in</button></form>''', j='''<script>const e=new URLSearchParams(location.search).get('email')||'';who.textContent='Signing in as '+e;hu.value=e;</script>'''),
    'frame-login.html': dict(t='Embedded login', h='', s='<style>body{background:#fff}header{display:none}main{padding:8px}</style>', b='''<form onsubmit="event.preventDefault()"><label for="u">Email or username</label><div class="f"><input id="u" autocomplete="username"></div>
<label for="p">Password</label><div class="f"><input id="p" type="password" autocomplete="current-password"></div><button type="submit">Sign in</button></form>'''),
    'iframe.html': dict(t='Login in a same-origin frame', h='Portal with an embedded login', b='''<div class="card"><p>The form below is in an iframe from this same site.</p>
<iframe id="fr" src="frame-login.html" style="width:100%;height:280px;border:1px solid #ccc"></iframe></div>'''),
    'cross.html': dict(t='Login in a cross-origin frame', h='Portal with a third-party login', b='''<div class="card"><p>The form below is served by another site.</p>
<iframe id="fr" style="width:100%;height:280px;border:1px solid #ccc"></iframe></div>''', j='''<script>fr.src=location.protocol+'//frames.example-lw.test:'+location.port+'/frame-login.html'</script>'''),
    'shadow.html': dict(t='Shadow DOM login', h='Web components portal', b='<x-login></x-login>', j='''<script>
const css='<style>input{display:block;width:300px;height:36px;margin:4px 0 12px}</style>';
customElements.define('x-login',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});
r.innerHTML=css+'<form><label>User<input id="u" name="user" autocomplete="username"></label><x-pass></x-pass><button>Sign in</button></form>'}});
customElements.define('x-pass',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML=css+'<label>Password<input id="p" type="password" autocomplete="current-password"></label>'}});
</script>'''),
    'spa.html': dict(t='SPA re-render', h='Single-page app', b='<div id="root" class="card">Loading...</div>', j='''<script>
// Renders late, then throws the form away and renders fresh elements, like a framework re-mount.
let n=0;function render(){n++;root.innerHTML='<form onsubmit="event.preventDefault()"><p>render '+n+'</p><label>Email</label><div class="f"><input name="email" type="email" autocomplete="email"></div><label>Password</label><div class="f"><input name="pw" type="password"></div><button type="submit">Sign in</button></form>';document.body.dataset.render=n;}
setTimeout(render,300);setTimeout(render,900);
</script>'''),
    'react.html': dict(t='Controlled inputs (React-style)', h='Controlled inputs', b='''<form id="f" onsubmit="event.preventDefault()"><label>Username</label><div class="f"><input id="u" autocomplete="username"></div>
<label>Password</label><div class="f"><input id="p" type="password" autocomplete="current-password"></div><button type="submit">Sign in</button><pre id="out">{}</pre></form>''', j='''<script>
// Mimics React: state only changes on input events that its value tracker sees as a real change, and every
// render writes state back into the DOM. A fill that skips the events, or goes through the element's own
// (tracked) value setter, gets reverted on the next render.
const state={u:'',p:''};
function track(el){const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');let last=el.value;
 Object.defineProperty(el,'value',{configurable:true,get(){return d.get.call(this)},set(v){last=String(v);d.set.call(this,v)}});
 el._t={get:()=>last,set:(v)=>{last=v}};}
for(const el of [u,p]){track(el);el.addEventListener('input',()=>{const now=el.value;if(now===el._t.get())return;el._t.set(now);state[el.id]=now;render();});}
function render(){u.value=state.u;p.value=state.p;out.textContent=JSON.stringify(state);}
setInterval(render,250);
</script>'''),
    'password-only.html': dict(t='Confirm your password', h='Confirm it is you', b='''<form onsubmit="event.preventDefault()"><p>Enter your password to continue.</p>
<label for="p">Password</label><div class="f"><input id="p" type="password" autocomplete="current-password"></div><button type="submit">Continue</button></form>'''),
    'signup.html': dict(t='Create an account', h='Create an account', b='''<form onsubmit="event.preventDefault()">
<label for="e">Email</label><div class="f"><input id="e" type="email" autocomplete="email"></div>
<label for="n1">Choose a password</label><div class="f"><input id="n1" type="password" autocomplete="new-password"></div>
<label for="n2">Repeat it</label><div class="f"><input id="n2" type="password" autocomplete="new-password"></div><button type="submit">Create account</button></form>'''),
    'change-password.html': dict(t='Change password', h='Account settings', b='''<form onsubmit="event.preventDefault()">
<input type="text" autocomplete="username" value="alice@corpus.test" hidden>
<label for="c">Current password</label><div class="f"><input id="c" type="password" autocomplete="current-password"></div>
<label for="n1">New password</label><div class="f"><input id="n1" type="password" autocomplete="new-password"></div>
<label for="n2">Repeat new password</label><div class="f"><input id="n2" type="password" autocomplete="new-password"></div><button type="submit">Change password</button></form>'''),
    'none.html': dict(t='No form here', h='Article', b='<div class="card"><p>Just text. <input type="search" placeholder="Search"></p></div>'),
}

for name, p in pages.items():
    (here / name).write_text(HEAD.format(t=p['t'], h=p['h'], b=p['b'], s=p.get('s', ''), j=p.get('j', '')), encoding='utf8')
print(len(pages), 'pages')
