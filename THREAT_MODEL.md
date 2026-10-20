# Litewarden threat model

Litewarden is a browser extension that keeps a copy of your Vaultwarden vault and fills logins into web pages. This
document says what it protects, who it protects against, what it does today, and what it doesn't cover.

**There has been no paid security audit.** Everything here is our own analysis. If you find a mistake or a way
around any of it, please open an issue at https://github.com/Concept211/litewarden/issues (or, for something serious, contact the maintainer privately first). Review
is very welcome.

File references point at the source as of version 0.1.0.

## What we protect

| Asset | Where it lives | Notes |
|---|---|---|
| Master password | Typed into the popup, used once to derive keys, then dropped | Never stored, never sent. Only the derived hash goes to the server at login. |
| User key (decrypts the vault) and organization keys | `chrome.storage.session` while unlocked (`Session` in `src/shared/store.ts`) | Memory only by default. See "Lock when the browser closes" below for the one setting that puts it on disk. |
| Decrypted list index (names, usernames, URLs, notes for search) | `chrome.storage.session` (`index`, `notes`, `recentItems`, `tabMatches`) | Memory only. Passwords and 2FA secrets are not in the index; they're decrypted one at a time when you fill or copy. |
| Encrypted vault copy | `chrome.storage.local` (`vault`) | Encrypted exactly as the server stores it. |
| Access and refresh tokens | `chrome.storage.local` (`tokens`) | Let the extension talk to your server without your password. |
| PIN-wrapped user key | `chrome.storage.session` by default; `chrome.storage.local` only if "Keep the PIN after a restart" is on | Wrapped with a key derived from the PIN through your account's KDF (`pinKey` in `src/entrypoints/background/session.ts`). |
| Two-step "remember this browser" token, device id | `chrome.storage.local` | Same as any Bitwarden-compatible client. |
| Clipboard contents | The system clipboard | Cleared after 30 seconds by default (`src/entrypoints/background/clipboard.ts`). |
| "Teach this site" rules | `chrome.storage.local` (`siteRules`) | CSS selectors for a site's fields. No secrets. |

## Trust boundaries

1. **Service worker** (`src/entrypoints/background/`). Holds the session, talks to the server, decides what may be
   filled where. The most trusted part.
2. **Extension pages**: the popup, the pop-out window, the offscreen document, and the three pages framed into sites
   (`menu.html`, `prompt.html`, `teach.html`). They run on the extension's own origin. A web page can show them but
   can't read or script them.
3. **Content scripts** (`src/entrypoints/lw.content.ts`, `src/entrypoints/fill.content.ts`). Run inside web pages.
   We treat everything they report as untrusted input from a possibly hostile page.
4. **Web pages**, including any iframes inside them. Untrusted.
5. **Your Vaultwarden server.** Trusted with ciphertext and the login hash, not with plaintext. Vault contents are
   end-to-end encrypted the same way the official clients do it.
6. **The network** between the browser and your server.

## Who we defend against

### A malicious or compromised web page (including XSS on a site you trust)

What it wants: your passwords for this site or, worse, other sites.

What Litewarden does:
- **Fills only on request.** Nothing is filled when a page loads. Filling happens after you press Enter or click in
  the popup, or pick a login in the in-page menu (`src/entrypoints/background/fill.ts`).
- **Fills only matching sites.** A login fills only on a page that matches one of its saved websites, with the
  match type you chose (base domain, host, starts with, exact, regex). The public suffix list keeps
  `alice.github.io` and `bob.github.io` apart (`src/core/urlmatch.ts`). Filling a login on a site it doesn't match
  needs an explicit "Fill anyway".
- **Asks before filling into a frame from another site.** If the login form sits in an iframe whose origin differs
  from the page's, you get a confirmation naming that origin (setting "Ask before filling embedded forms", on by
  default).
- **Refuses non-web pages.** No filling on `chrome://`, the Web Store, `file://` or other non-http(s) pages.
- **Content scripts get a short, fixed message list.** They can say "a field exists", "a form was submitted", "open
  the menu", "save this teach rule" and a few more (`CsApi` in `src/shared/messages.ts`). They can't ask for a
  password, a 2FA secret or the vault. Every message is tied to the tab and frame it came from, and the worker
  rejects messages from anything that isn't an http(s) frame of a real tab (`src/entrypoints/background/index.ts`).
- **Our in-page UI is out of the page's reach.** The field icons live in a closed shadow root, and the menu, save
  prompt and teach panel are extension pages in iframes. The page can't read their contents, can't click their
  buttons through script (`isTrusted` checks), and can't see your logins listed in the menu.
- **Framed pages can't be preloaded or guessed.** `menu.html`, `prompt.html` and `teach.html` are the only
  web-accessible resources, served with `use_dynamic_url`, so their address changes per browser session
  (`wxt.config.ts`). Each frame also needs a one-time token the worker issued for that tab.
- **Save prompts can't be forged into saving.** The page can submit a form that triggers the prompt, but saving
  needs your trusted click or key press inside the prompt frame.

Residual risk:
- A page that you have unlocked Litewarden on and asked to fill gets that site's username and password. That's the
  point of filling. XSS on that site can read them from the form afterward.
- The save prompt sees what you typed into a login form (that's how it offers to save). A hostile page could fake a
  "login form" to get a prompt shown; it still can't save without you.
- Content scripts can technically read `chrome.storage.local`. Chrome doesn't offer a way to fence that area off from
  content scripts (it does for `chrome.storage.session`, which content scripts can't read). Litewarden's content
  scripts never read storage; they only use the message list above. But if a page found a way to run code inside
  the content script's world (a browser bug), it could read what's in `chrome.storage.local`: the encrypted vault,
  the tokens, and, only if you turned those settings on, the persisted session or the disk copy of the PIN-wrapped
  key. Planned: move secrets that must persist into an encrypted form keyed by something content scripts can't
  reach, and keep the defaults (memory only).

### Clickjacking

What it wants: trick you into clicking "Fill" or "Save" in our framed UI while it's hidden or covered.

What Litewarden does (`useGuard` in `src/ui/frame.ts`):
- Pointer actions in the menu and prompt count only while Chrome reports the frame as fully visible and unobstructed
  (IntersectionObserver v2 `isVisible`), and only after it has been visible for 250 ms.
- Where that API isn't available, the click must be a real (trusted) one with the frame's page focused.
- The frame can't be made transparent by the page in a way the visibility check misses; Chrome computes `isVisible`
  from the final composited result.
- No-cover placement (`src/shared/place.ts`): the menu and prompt never sit on top of the page's own fields,
  buttons inside fields, checkboxes or submit button, so an accidental click lands where you aimed.

Residual risk: browsers without IntersectionObserver v2 fall back to the weaker focus check.

### A malicious iframe on an honest page

Covered by the cross-origin confirmation above: Litewarden names the frame's origin and asks before filling into it,
and logins only fill when that frame's own URL matches.

### Other extensions

Another extension with broad host permissions can read and change any page, including filled fields, just like it
could watch you type. Litewarden can't defend against that and doesn't try. Other extensions can't message
Litewarden's service worker: it checks `sender.id` on every message.

### Malware on your computer

Out of scope in general: software running as you can read the browser's memory and storage, log keys, and change
the extension files. What Litewarden does to limit the damage:
- By default, nothing decrypted is written to disk. The user key and the decrypted index live in
  `chrome.storage.session`, which Chrome keeps in memory and drops when the browser closes.
- **Two settings trade that for convenience, and both are off by default:**
  - "Lock when the browser closes" off: the unlocked session (user key) is mirrored to `chrome.storage.local` so it
    survives a restart (`persistedSession`). Anyone who can read your browser profile can then decrypt the vault
    copy. The setting says so.
  - "Keep the PIN after a restart" on: the PIN-wrapped user key is written to disk. A 6-digit PIN has a million
    combinations; the wrap uses your account's KDF (for example PBKDF2 at 600,000 iterations), so trying them all
    offline is slow but very possible for a determined attacker with the file. Treat this as "convenient", not
    "safe from someone who has your disk".
- The encrypted vault copy on disk is as safe as your master password and KDF settings, the same as the official
  clients' offline copy.

### Someone at your keyboard or looking over your shoulder

- Auto-lock after 15 minutes idle by default (configurable), using `chrome.alarms` so it fires even if the service
  worker was asleep.
- Lock when the browser closes, on by default.
- **PIN guessing is limited:** 5 wrong PINs and the PIN is wiped; you need the master password again
  (`PIN_TRIES` in `src/entrypoints/background/session.ts`).
- **Master password guessing is slowed:** after 5 wrong tries, a 1-minute wait (`PW_TRIES`, `PW_WAIT_MS`). The
  server also rate-limits logins.
- Passwords are masked until you press reveal. Copied secrets are cleared from the clipboard after 30 seconds by
  default.

Residual risk: the clipboard clear writes an empty clipboard when the timer fires, even if you copied something
else in the meantime (that copy is lost). Clipboard history tools (Windows clipboard history, clipboard managers)
may keep their own copy; Litewarden can't clear those.

### A compromised server or a man in the middle

- Vault contents are end-to-end encrypted. The server only ever sees ciphertext, your email, and the login hash
  derived from your master password (not the password itself). A compromised server can't read your passwords
  directly.
- A malicious server could serve weak KDF settings at prelogin to make the hash easier to crack. Litewarden uses
  what the server reports, as the official clients do. Planned: refuse KDF settings below a floor (PBKDF2 under
  600,000 iterations, Argon2id under the Bitwarden minimums) and warn.
- A malicious server could send crafted ciphertext. Decryption checks the HMAC before decrypting (encrypt-then-MAC,
  `src/core/crypto/webcrypto.ts`), and item decrypt failures are isolated per item and shown, not fatal.
- Unknown key formats (EncString type 7, V2 account keys) are detected and reported in plain words instead of being
  half-parsed (`UnsupportedKeyFormat`, `src/core/errors.ts`).
- **Use HTTPS.** Over plain HTTP, anyone on the network sees the login hash (enough to attempt offline cracking),
  the tokens and the ciphertext, and can change what the server says. Litewarden accepts `http://` addresses because
  people test on their own LAN, but your vault should be behind TLS.

### Supply chain and the extension itself

- **No remote code.** Everything ships in the extension package, including the Argon2 WebAssembly. The content
  security policy for extension pages is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`
  (`wxt.config.ts`): no inline scripts, no `eval`, nothing loaded from the network. `wasm-unsafe-eval` is there only
  for the bundled Argon2 module.
- **No telemetry, no analytics, no third-party services.** The extension talks to exactly one server: yours. Site
  icons come from your server's `/icons` endpoint, not from Google or DuckDuckGo. (If you sign in to Bitwarden
  cloud instead, "your server" means Bitwarden's own hosts for that region, including its icon service.)
- A scan of the built package finds no `eval`, no `new Function` and no remote script tags. The only hosts named in
  the code are Bitwarden cloud's (used only if you pick it), GitHub links, and placeholder examples.
- Dependencies are pinned to exact versions in `package.json`; the runtime ones are Preact, @preact/signals,
  hash-wasm (Argon2), tldts (public suffix list), lucide-preact (icons) and two Fontsource font packages.
- Litewarden doesn't use Bitwarden's SDK and contains no code under Bitwarden's commercial license.

Residual risk: a compromised npm dependency at build time would end up in the package. Reproducible builds and a
published lockfile help reviewers check that the store package matches the source; signed release builds are
planned for the first public release.

## Out of scope

- A compromised browser or operating system.
- Other extensions with access to the same pages.
- Physical attacks on an unlocked, unattended computer beyond the auto-lock.
- Weak master passwords and weak KDF settings chosen on the server.
- Phishing sites with a lookalike domain: Litewarden won't fill a login there (the domain doesn't match), but it
  can't stop you from typing your password by hand.

## Reporting a problem

Please open an issue at https://github.com/Concept211/litewarden/issues, or for anything that could put users at risk, contact the
maintainer privately first and give a reasonable time to fix it before publishing. Litewarden is not affiliated with
Bitwarden, Inc. or the Vaultwarden project; problems in the server belong with Vaultwarden.
