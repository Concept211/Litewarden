// SPDX-License-Identifier: GPL-3.0-only
// Typed errors. Every one carries a plain-words message the UI can show as is.

export class LitewardenError extends Error {
  override name = 'LitewardenError';
}

/** The account or an item uses a key format this version can't read yet (COSE / EncString type 7, V2 account keys). */
export class UnsupportedKeyFormat extends LitewardenError {
  override name = 'UnsupportedKeyFormat';
  constructor(public readonly detail: string) {
    super(
      `This account uses a newer encryption format (${detail}) that Litewarden can't read yet. ` +
        'Your vault is safe and unchanged; use the web vault until Litewarden adds support.',
    );
  }
}

/** A MAC check failed: wrong key, or the data was changed. Never shown as an empty vault. */
export class DecryptError extends LitewardenError {
  override name = 'DecryptError';
}

export class ApiError extends LitewardenError {
  override name = 'ApiError';
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    where: string,
  ) {
    super(`${where} failed: ${status === 0 ? 'no response' : `HTTP ${status}`}${serverMessage(body) ? `: ${serverMessage(body)}` : ''}`);
  }
}

/** Login needs a second factor. `providers` are Bitwarden TwoFactorProviderType numbers (0 = authenticator app). */
export class TwoFactorRequired extends LitewardenError {
  override name = 'TwoFactorRequired';
  constructor(public readonly providers: number[]) {
    super('This account needs a two-step login code.');
  }
}

export class WrongPassword extends LitewardenError {
  override name = 'WrongPassword';
  constructor() {
    super('Wrong email or master password.');
  }
}

export class WrongTwoFactorCode extends LitewardenError {
  override name = 'WrongTwoFactorCode';
  constructor() {
    super("That code didn't work. Codes change every 30 seconds; try the current one.");
  }
}

export class ServerUnreachable extends LitewardenError {
  override name = 'ServerUnreachable';
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    super(`Can't reach ${url}. Check the address and that the server is running.`, { cause });
  }
}

/** Pull the human message out of a Vaultwarden/Bitwarden error body (it lives in a few places). */
export function serverMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : '';
  const b = body as Record<string, unknown>;
  const em = b.errorModel as Record<string, unknown> | undefined;
  const ErrorModel = b.ErrorModel as Record<string, unknown> | undefined;
  for (const v of [b.message, em?.message, ErrorModel?.Message, b.error_description, b.error]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** The server's key settings are below the floor Bitwarden itself enforces. Raised before the password is used. */
export class WeakKdf extends LitewardenError {
  override name = 'WeakKdf';
  constructor(detail: string) {
    super(
      `This server reports weak encryption settings (${detail}), so Litewarden stopped before sending your password. ` +
        'Your master password is safe. Check the address, and if it is right, raise the settings in the web vault under Account security.',
    );
  }
}
