/**
 * Pure, `vscode`-free device-code flow logic, extracted from
 * {@link ./devicePairingProvider} so the state machine, token-expiry rules,
 * and refresh-outcome taxonomy can be unit-tested without the VS Code runtime
 * (mirrors how `url-guard` and `orchestrator-url` keep their logic pure and
 * directly testable).
 */

/** An embedded bearer token minted once a device-code pairing is approved. */
export interface EmbeddedTokenRecord {
  accessToken: string;
  tokenType: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /**
   * Rotating refresh token (`ert_…`) accompanying the short-TTL access token.
   * Single-use: each `/api/auth/embed-refresh` call consumes it and returns a
   * replacement. Absent on records stored by pre-refresh (v1) builds.
   */
  refreshToken?: string;
}

export type PollOutcome =
  | { status: 'approved'; token: EmbeddedTokenRecord }
  | { status: 'pending' | 'denied' | 'expired' };

export interface PollResponseBody {
  access_token?: string;
  refresh_token?: string;
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
        refreshToken: body.refresh_token,
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
 * outlive. An unusable token is NOT necessarily a dead session: when the
 * record carries a {@link EmbeddedTokenRecord.refreshToken}, the refresh
 * grant can silently mint a replacement.
 */
export function isTokenUsable(record: EmbeddedTokenRecord, now: number, skewMs: number): boolean {
  if (typeof record.expiresAt !== 'number') return true;
  return record.expiresAt > now + skewMs;
}

/** Raw response body of `POST /api/auth/embed-refresh`. */
export interface RefreshResponseBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
}

export type RefreshOutcome =
  | { kind: 'rotated'; token: EmbeddedTokenRecord }
  | { kind: 'session-ended' }
  | { kind: 'transient' };

/**
 * Maps an `/api/auth/embed-refresh` response to what the caller must do —
 * the binding status taxonomy:
 *
 * - **200 with an `access_token`** → `rotated`: store the new pair, the old
 *   refresh token is consumed.
 * - **401** → `session-ended`: the ONLY authoritative "session is dead"
 *   signal (invalid_grant / revoked / reuse-detected). Clear storage, stop
 *   refreshing.
 * - **Everything else** (404 = endpoint absent during rollout skew, 5xx,
 *   status 0, a 200 missing its token = malformed) → `transient`: keep the
 *   session AND the stored record, retry later. A 404 must NEVER sign the
 *   user out.
 *
 * @param now epoch ms used to stamp the rotated token's absolute `expiresAt`.
 */
export function mapRefreshOutcome(status: number, body: RefreshResponseBody, now: number): RefreshOutcome {
  if (status === 200 && body.access_token) {
    return {
      kind: 'rotated',
      token: {
        accessToken: body.access_token,
        tokenType: body.token_type ?? 'Bearer',
        expiresAt: now + (body.expires_in ?? 0) * 1000,
        refreshToken: body.refresh_token,
      },
    };
  }
  if (status === 401) return { kind: 'session-ended' };
  return { kind: 'transient' };
}

/**
 * How long to wait before the silent-refresh timer next fires: `leadMs`
 * before the token's expiry, clamped to at least `minDelayMs` so a
 * near-expired (or already-expired) token refreshes almost immediately
 * instead of scheduling a zero/negative-delay storm.
 *
 * `jitterMs` (>0) subtracts a random `[0, jitterMs)` slice so that two
 * windows which computed the *identical* `expiresAt` (both converged on the
 * same stored token) do NOT fire their refresh at the same wall-clock
 * instant. Without this de-sync both would POST the same single-use refresh
 * token before either's rotation could propagate via
 * `SecretStorage.onDidChange`; the winner rotates and the loser's now-stale
 * POST risks tripping the server's reuse detection. Jitter only ever moves
 * the fire *earlier* (never past `minDelayMs`), so a near-expired salvage is
 * still near-immediate. `rand` is injectable for deterministic tests.
 */
export function nextRefreshDelayMs(
  expiresAt: number,
  now: number,
  leadMs = 60_000,
  minDelayMs = 1_000,
  jitterMs = 0,
  rand: () => number = Math.random
): number {
  const jitter = jitterMs > 0 ? Math.floor(rand() * jitterMs) : 0;
  return Math.max(expiresAt - leadMs - jitter - now, minDelayMs);
}

/**
 * Bounded exponential backoff for retrying after a `transient` refresh
 * outcome: `baseMs * 2^attempt`, capped at `maxMs`. `attempt` counts
 * consecutive failures starting at 0 and is clamped to a non-negative
 * integer.
 */
export function refreshRetryDelayMs(attempt: number, baseMs = 30_000, maxMs = 300_000): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(baseMs * 2 ** n, maxMs);
}
