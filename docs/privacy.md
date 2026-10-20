---
title: Privacy policy
description: Litewarden collects nothing. It talks only to the password server you sign in to.
permalink: /privacy
---

# Litewarden privacy policy

Last updated: October 20, 2026

Litewarden is a password manager extension for Vaultwarden and other Bitwarden-compatible servers. It is made by
[Concept211](https://concept211.com). The short version: **we collect nothing.** Litewarden has no account with us,
no analytics, no telemetry and no ads. It talks only to the password server you sign in to.

## What Litewarden handles

To do its job, Litewarden handles your password vault: logins, usernames, passwords, notes, website addresses and
2FA secrets. The Chrome Web Store calls this "authentication information."

- **Your server.** The vault lives on the server you choose (your own Vaultwarden, or a Bitwarden cloud server if
  you pick one). It is end-to-end encrypted: the server only ever stores ciphertext.
- **Your master password** is used on your computer to derive your keys. It is never stored and never sent anywhere.
  Only a one-way hash goes to your server when you sign in, the same way the official clients work.
- **In your browser**, Litewarden keeps:
  - an encrypted copy of your vault, so the popup opens quickly;
  - your sign-in tokens for your server;
  - your settings, and any "teach this site" field rules;
  - while unlocked, the decryption key and a search index of names, usernames and website addresses. These stay in
    the browser's session memory and are dropped when you lock or close the browser, unless you turn off "Lock when
    the browser closes."

Nothing leaves your browser except requests to your own server.

## Network requests

Litewarden connects to one place: the server address you enter. That includes sign-in, sync, saving items, live
updates and website icons (your server fetches the icons, not Litewarden). It never contacts Concept211 or any
other service.

## Website access

Litewarden can read login forms on the sites you visit so it can fill them and offer to save new logins. It looks
at form fields only, and only on your computer. It doesn't record, collect or send your browsing history or page
contents anywhere.

## Clipboard

When you copy a password, Litewarden clears the clipboard after 30 seconds (you can change this). Before clearing,
it checks the clipboard still holds what it copied, so it never wipes something you copied later. To do that it
compares a fingerprint (a SHA-256 hash) of the text. It never stores or sends what's on your clipboard.

## Sharing and selling

We don't sell, share or transfer your data, because we never receive it. Your data isn't used for advertising,
credit decisions or anything other than running the password manager you installed.

## Removing your data

Uninstalling Litewarden removes everything it stored in your browser. Your vault stays on your server, under your
control.

## Contact

Questions or security reports: open an issue at
[github.com/Concept211/litewarden](https://github.com/Concept211/litewarden/issues), or use the contact form at
[concept211.com](https://concept211.com).

Litewarden is open source under the GPL-3.0 license. You can read every line of what it does in the repository.
