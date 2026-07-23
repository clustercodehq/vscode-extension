/**
 * Pure, `vscode`-free device-code flow logic, extracted from
 * {@link ./devicePairingProvider} so the state machine and token-expiry rules
 * can be unit-tested without the VS Code runtime (mirrors how `url-guard` and
 * `orchestrator-url` keep their logic pure and directly testable).
 */

/** An embedded bearer token minted once a device-code pairing is approved. */
export interface EmbeddedTokenRecord {
  accessToken: string;
  tokenType: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type PollOutcome =
  | { status: 'approved'; token: EmbeddedTokenRecord }
  | { status: 'pending' | 'denied' | 'expired' };

export interface PollResponseBody {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
}

/**
 * Maps a raw `device/poll` response body to a {@link PollOutcome}. A present
 * `access_token` means approved; otherwise the OAuth-shaped `error` decides.
 * Anything unrecognized (expired_token / invalid_grant / unknown) is terminal
 * `expired` — nothing more polling can do.
 *
 * @param now epoch ms used to stamp the token's absolute `expiresAt`.
 */
export function mapPollOutcome(body: PollResponseBody, now: number): PollOutcome {
  if (body.access_token) {
    return {
      status: 'approved',
      token: {
        accessToken: body.access_token,
        tokenType: body.token_type ?? 'Bearer',
        expiresAt: now + (body.expires_in ?? 0) * 1000,
      },
    };
  }
  if (body.error === 'authorization_pending') return { status: 'pending' };
  if (body.error === 'access_denied') return { status: 'denied' };
  return { status: 'expired' };
}

/**
 * True if a stored token is still safe to use — i.e. it expires more than
 * `skewMs` in the future. The skew margin means a token about to expire
 * mid-flight is treated as unusable rather than handed to a request it can't
 * outlive (there is no refresh grant to salvage it with in v1).
 */
export function isTokenUsable(record: EmbeddedTokenRecord, now: number, skewMs: number): boolean {
  if (typeof record.expiresAt !== 'number') return true;
  return record.expiresAt > now + skewMs;
}
