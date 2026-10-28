# Litewarden threat model

Litewarden is a browser extension that keeps a copy of your Vaultwarden vault and fills logins into web pages. This
document says what it protects, who it protects against, what it does today, and what it doesn't cover.

**There has been no paid security audit.** Everything here is our own analysis. If you find a mistake or a way
around any of it, please open an issue at https://github.com/Concept211/Litewarden/issues (or, for something serious, contact the maintainer privately first). Review
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
| Clipboard contents | The system clipboard | Cleared after 30 seconds by default, but only if it still holds what Litewarden copied (`src/entrypoints/background/clipboard.ts`, `src/entrypoints/offscreen/main.ts`). A SHA-256 of the copied text is kept in `chrome.storage.session` until then. |
| Unlocked session mirror (user key, org keys) | `chrome.storage.local` (`persistedSession`), only if "Lock when the browser closes" is off | AES-GCM sealed under a non-extractable key in IndexedDB, dropped on every lock (`src/shared/vaultkey.ts`). Never the raw key. |
| Weak-settings notice dismissal | `chrome.storage.local` (`kdfDismissed`) | The KDF settings the user dismissed the notice for. No secret. |
| "Teach this site" rules | `chrome.storage.local` (`siteRules`) | CSS selectors for a site's fields. No secrets. |

## What is stored where, and who can read it

"Content script" means code running in a web page's tab on Litewarden's behalf. If a page broke into that world (a
browser bug), it would have the content script's abilities. "Profile reader" means malware or a person with the
browser's files on disk; that is out of scope (see below) and listed only for completeness.

| Data | Where | Form on disk | Extension pages and worker | Content scripts | Profile reader |
|---|---|---|---|---|---|
| Account, settings, site rules, sync times | `storage.local` | Plain | Yes | **No**: `local` is set to trusted contexts only (`fenceStorage` in `src/shared/store.ts`) | Yes |
| Encrypted vault, tokens | `storage.local` | Vault: the server's ciphertext. Tokens: plain | Yes | **No** (same fence). Even without the fence they would get ciphertext and tokens that can fetch ciphertext, not decrypt it | Yes (tokens can fetch the encrypted vault from your server) |
| PIN-wrapped user key (if "Keep the PIN after a restart") | `storage.local` | Encrypted by a key derived from the PIN through the account KDF | Yes | **No** (fence); and it is ciphertext anyway | Yes, then guesses the PIN offline |
| Session mirror (if "Lock when the browser closes" is off) | `storage.local` | AES-GCM under a non-extractable WebCrypto key held in IndexedDB | Yes | **No**: fenced, and IndexedDB belongs to the extension's origin, so even a content script that got past the fence reads only ciphertext | Yes: the key is in the same profile |
| User key, org keys, decrypted index, PIN-wrapped key (default) | `storage.session` (memory) | Not on disk | Yes | **No**: session storage is trusted contexts only by default, and we set it explicitly | Only by reading browser memory |
| Clipboard hash | `storage.session` | Not on disk | Yes | No | Only by reading browser memory |
| Master password | Popup memory while typing | Never stored | n/a | n/a | n/a |

How the fence works and what we checked: `chrome.storage.StorageArea.setAccessLevel` exists on every storage area
since Chrome 102, not only on `session`. The service worker calls it with `TRUSTED_CONTEXTS` on `local`, `session`
and `sync` at the top of every start (`fenceStorage`, because the setting does not survive a worker restart). Nothing
in the source sets any area to `TRUSTED_AND_UNTRUSTED_CONTEXTS` (a unit test greps for it). An e2e test reads
storage from inside the content-script world of a real page over the DevTools protocol: it is refused ("Access to
storage is not allowed from this context"), and the same read succeeds when the area is deliberately opened up, so
the refusal is the fence and not a broken probe. The content scripts themselves never use `chrome.storage`. The
fence has one gap: between a worker start and its first `setAccessLevel` call, `local` is at its default. The call
is the first statement the worker runs, and content scripts have no storage code, so only a page that had already
broken into the content-script world could use that window.

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
- `chrome.storage.local` is readable from content scripts by default. Litewarden closes that: the service worker
  sets `local` (and `session`) to trusted contexts only (see "What is stored where"), and its content scripts never
  read storage anyway; they only use the message list above. As a second layer, the one secret that can sit in
  `local` without your PIN protecting it, the mirror of the unlocked session when "Lock when the browser closes" is
  off, is AES-GCM sealed under a non-extractable key in IndexedDB. A page that somehow got past the fence would read
  the encrypted vault, the tokens and sealed or PIN-encrypted blobs, none of which opens without your PIN or master
  password. Builds before this change wrote that mirror unsealed; the new build seals it the first time it sees one.

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
    survives a restart (`persistedSession`), sealed under a non-extractable key in IndexedDB. The key sits in the same
    profile, so anyone who can read your browser profile can still decrypt the vault copy; the sealing keeps it from
    page-side code, not from profile access. The setting says so. Every lock and log out deletes the key, so a copy
    of the sealed blob made earlier is useless afterward.
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

The clipboard clear checks before it clears. When Litewarden copies a password or code it keeps a SHA-256 of the
text (in `chrome.storage.session`, not the text). When the timer fires, the offscreen document pastes the current
clipboard into a hidden textarea (`document.execCommand('paste')`, allowed by the `clipboardRead` permission; the
asynchronous `navigator.clipboard.readText()` needs a focused page and an offscreen document can't have focus),
hashes it, and clears only on a match. Anything you copied since, including Litewarden's own username copy, is left
alone. The text read for the comparison lives in a local variable and the textarea for the length of the check and is
then dropped.

Residual risk: if the clipboard can't be read in the offscreen document (the permission was removed, or Chrome
refuses the paste), the clear falls back to the old behavior and wipes the clipboard anyway, because a secret left
on the clipboard is worse than a lost copy. `clipboardRead` is one more permission than before and shows in Chrome's
permission list as reading data you copy and paste; Litewarden uses it only for this comparison and never sends the
clipboard anywhere. Clipboard history tools (Windows clipboard history, clipboard managers) may keep their own copy;
Litewarden can't clear those.

### A compromised server or a man in the middle

- Vault contents are end-to-end encrypted. The server only ever sees ciphertext, your email, and the login hash
  derived from your master password (not the password itself). A compromised server can't read your passwords
  directly.
- A malicious server could serve weak KDF settings at prelogin to make the hash easier to crack. Litewarden checks
  them (`checkKdf` in `src/core/kdf.ts`) before it uses the master password for anything. PBKDF2 under 5,000
  rounds, or Argon2id with missing or zero settings, is refused with a plain error and nothing is sent: no password
  and no hash. PBKDF2 under 600,000 rounds, or Argon2id under 16 MiB of memory, 2 rounds or 1 lane (Bitwarden's
  recommended minimums), signs in but shows a dismissible warning on the main screen after unlock and a permanent
  row in Settings > Account, saying the account's encryption settings are weak and can be raised in the web vault.
  The notice comes back if the settings change. This is a floor, not a guarantee: a server can still choose settings
  that are merely above it.
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
  hash-wasm (Argon2), tldts (public suffix list), lucide-preact (icons), jsQR (reads a 2FA setup QR code) and two
  Fontsource font packages.
- The 2FA scan button takes one screenshot of the visible tab, only when you click it, and decodes it inside the
  popup. To know where to look, it asks the page for the positions of its images, canvases and SVGs (positions
  only, nothing else). The image isn't stored or sent anywhere.
- 2FA setup pages (Settings, Autofill, "Offer to add 2FA keys", on by default). The content script reads the top
  page's text to spot a setup: 2FA wording plus an `otpauth://` link, a typed key or a square image. It sends the
  worker only what it found there (the link, the key, the images' positions). Only for such a page does the worker
  take one screenshot of the visible tab and read the QR code in memory; the screenshot isn't stored or sent.
  The key waits in session memory (cleared when the browser closes, dropped after 10 minutes or when the tab
  leaves the site) until you choose. Nothing is saved without a click on the card or in the popup, which follow
  the same rules as the save card (own frame, click guard, covers nothing).
- What a page can do with it: show a fake setup to get a key of its choosing saved to a login of its own domain.
  The code Litewarden then types into the page comes from that same key, so the page learns nothing it didn't
  already know; a real key's codes are never typed into a page this way. Replacing a login's existing key needs
  its own "Replace" click with a warning, and the old key is kept in the login's notes (Undo also restores it), so
  a fake setup can't lock you out of an account.
- Litewarden doesn't use Bitwarden's SDK and contains no code under Bitwarden's commercial license.

Residual risk: a compromised npm dependency at build time would end up in the package. Reproducible builds and a
published lockfile help reviewers check that the store package matches the source; signed release builds are
planned for the first public release.

## Out of scope

- A compromised browser or operating system.
- Other extensions with access to the same pages.
- Physical attacks on an unlocked, unattended computer beyond the auto-lock.
- Weak master passwords. Weak KDF settings chosen on the server are warned about above the hard floor, not blocked.
- Phishing sites with a lookalike domain: Litewarden won't fill a login there (the domain doesn't match), but it
  can't stop you from typing your password by hand.

## Reporting a problem

Please open an issue at https://github.com/Concept211/Litewarden/issues, or for anything that could put users at risk, contact the
maintainer privately first and give a reasonable time to fix it before publishing. Litewarden is not affiliated with
Bitwarden, Inc. or the Vaultwarden project; problems in the server belong with Vaultwarden.
