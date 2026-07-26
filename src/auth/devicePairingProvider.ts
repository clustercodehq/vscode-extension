import * as vscode from 'vscode';
import { requestJson } from './httpJson';
import { fetchBootstrapCode } from './bootstrapCode';
import {
  mapPollOutcome,
  mapRefreshOutcome,
  nextRefreshDelayMs,
  refreshRetryDelayMs,
  isTokenUsable,
  type EmbeddedTokenRecord,
  type PollOutcome,
  type PollResponseBody,
  type RefreshResponseBody,
} from './deviceFlow';

export type { EmbeddedTokenRecord } from './deviceFlow';

const POLL_INTERVAL_MS = 5000;
const SECRET_KEY = 'clustercode.embeddedToken';
/** Treat a token expiring within this window as already expired, so it isn't handed to a request it can't outlive. */
const EXPIRY_SKEW_MS = 30_000;
/** Silent-refresh timing: fire ~60 s before expiry, never sooner than 1 s. */
const REFRESH_LEAD_MS = 60_000;
const REFRESH_MIN_DELAY_MS = 1_000;
/**
 * Randomized de-sync applied to the scheduled refresh so two windows sharing
 * the OS keychain never fire at the same instant off an identical `expiresAt`
 * (see {@link nextRefreshDelayMs}). 15 s ≫ the sub-second rotate→store→
 * onDidChange propagation, so the later window always adopts the winner's new
 * token before it fires — collapsing the coincident same-token double-POST
 * that would otherwise reach the server's reuse detection.
 */
const REFRESH_JITTER_MS = 15_000;

/** The device/user codes returned once a device-code pairing is started. */
export interface DeviceCodeSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the pairing expires if never approved. */
  expiresIn: number;
}

interface StartResponseBody {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  error?: string;
}

/**
 * Drives a device-code pairing (RFC 8628-shaped: start, then poll until
 * approved/denied/expired) against the orchestrator's device auth endpoints,
 * persists the resulting embedded bearer token (+ its rotating refresh token)
 * in VS Code's {@link vscode.SecretStorage}, and keeps the session alive via
 * a silent-refresh timer against `/api/auth/embed-refresh`.
 *
 * Multi-window safety: the OS keychain behind SecretStorage is shared by
 * every VS Code window. Refreshes are single-flight per extension host, the
 * stored record is re-read immediately before every refresh POST (another
 * window may have already rotated the single-use refresh token), and
 * {@link vscode.SecretStorage.onDidChange} is used to adopt rotations made
 * by other windows instead of fighting them (which would trip the server's
 * refresh-token reuse detection).
 */
export class DevicePairingProvider implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive `transient` refresh failures, for bounded backoff. Reset on any success. */
  private refreshFailures = 0;
  /** Shared in-flight refresh, so concurrent callers never race two POSTs. */
  private refreshInFlight: Promise<EmbeddedTokenRecord | undefined> | undefined;
  /** Set by {@link dispose}; guards a refresh that was already in flight from re-arming a timer or firing on a disposed emitter. */
  private disposed = false;
  private readonly secretChangeSub: vscode.Disposable;

  private readonly _onTokenReceived = new vscode.EventEmitter<EmbeddedTokenRecord>();
  /** Fires whenever an embedded token has been received and stored — initial pairing AND every silent refresh rotation. */
  readonly onTokenReceived = this._onTokenReceived.event;

  private readonly _onSessionEnded = new vscode.EventEmitter<void>();
  /**
   * Fires when the server authoritatively ends the session (refresh rejected
   * with 401): storage has been cleared and the refresh timer cancelled —
   * the user must pair again. Never fired for transient refresh failures.
   */
  readonly onSessionEnded = this._onSessionEnded.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly orchestratorUrl: string,
    private readonly log: (message: string) => void = () => {}
  ) {
    // Another window rotating (or deleting) the shared record must not be
    // fought: adopt it and re-schedule off the new expiry.
    this.secretChangeSub = this.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) void this._adoptStoredRecord();
    });
    // Restart-within-idle resume: if a refresh-capable record survived the
    // window reload / VS Code restart, re-arm the silent-refresh timer (an
    // already-expired access token schedules a near-immediate salvage).
    void this._adoptStoredRecord();
  }

  /**
   * Starts a new device-code pairing and begins polling for approval every
   * {@link POLL_INTERVAL_MS}. Resolves as soon as the pairing is created
   * (the code to display to the user) — it does not wait for approval;
   * listen to {@link onTokenReceived} for completion.
   *
   * @throws if the request times out, the response isn't valid JSON, or the
   * server rejects the request.
   */
  async startPairing(): Promise<DeviceCodeSession> {
    const { status, body } = await requestJson<StartResponseBody>(
      'POST',
      `${this.orchestratorUrl}/api/auth/device/start`
    );

    if (status !== 200) {
      throw new Error(`Failed to start device pairing (status ${status}): ${body.error ?? 'unknown error'}`);
    }

    const session: DeviceCodeSession = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in,
    };
    this.log(`Device pairing started — code ${session.userCode}, expires in ${session.expiresIn}s.`);
    this._beginPolling(session);
    return session;
  }

  /** Stops any in-flight polling without clearing a previously stored token. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Returns a *usable* embedded token, or `undefined` if none can be
   * obtained. An access token that has expired (or is inside the skew
   * window) but is accompanied by a stored refresh token is salvaged via
   * {@link refreshNow} rather than treated as absent — expiry no longer
   * wipes storage. Only a refresh-less record (stored by a pre-refresh
   * build) is still cleared on expiry, since nothing can revive it.
   */
  async getEmbeddedToken(): Promise<EmbeddedTokenRecord | undefined> {
    const record = await this._readStoredRecord();
    if (!record) return undefined;
    if (isTokenUsable(record, Date.now(), EXPIRY_SKEW_MS)) return record;
    if (record.refreshToken) {
      // Expired but refresh-capable: salvage. Single-flight; re-reads
      // storage itself, so a rotation by another window is picked up.
      return this.refreshNow();
    }
    await this.clearToken();
    return undefined;
  }

  /**
   * Rotates the stored token pair via `POST /api/auth/embed-refresh`.
   * Single-flight: concurrent callers (timer tick, 401-retry, panel render)
   * share ONE in-flight request — never two refresh POSTs at once, which
   * would consume the same single-use refresh token twice and trip the
   * server's reuse detection.
   *
   * Resolves the freshly rotated record on success. Resolves `undefined`
   * when there is nothing to salvage (no stored refresh token), when the
   * server authoritatively ends the session (401 → storage cleared, timer
   * cancelled, {@link onSessionEnded} fired), or on a transient failure
   * (404 / 5xx / network / malformed → session and storage KEPT, timer
   * re-armed on bounded backoff, caller may fall back to CLI SSO).
   */
  async refreshNow(): Promise<EmbeddedTokenRecord | undefined> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this._doRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async _doRefresh(): Promise<EmbeddedTokenRecord | undefined> {
    // Re-read immediately before the POST — never refresh a token captured
    // earlier: another window may have already rotated it (the stored value
    // is the only one that is still un-consumed).
    const record = await this._readStoredRecord();
    if (!record?.refreshToken) return undefined;

    let status: number;
    let body: RefreshResponseBody;
    try {
      ({ status, body } = await requestJson<RefreshResponseBody>(
        'POST',
        `${this.orchestratorUrl}/api/auth/embed-refresh`,
        { refresh_token: record.refreshToken },
        10_000
      ));
    } catch (err) {
      // Network failure / timeout / invalid JSON — transient, NOT a sign-out.
      this.log(`Token refresh failed (transient, will retry): ${err instanceof Error ? err.message : String(err)}`);
      this._armRetryBackoff();
      return undefined;
    }

    const outcome = mapRefreshOutcome(status, body, Date.now());
    if (outcome.kind === 'rotated') {
      await this._storeToken(outcome.token);
      this.refreshFailures = 0;
      this._armRefreshTimer(outcome.token);
      this.log('Embedded token silently refreshed (pair rotated).');
      if (!this.disposed) this._onTokenReceived.fire(outcome.token);
      return outcome.token;
    }
    if (outcome.kind === 'session-ended') {
      // Authoritative: the session is dead (revoked, expired server-side, or
      // reuse-detected). Clear and stop — no retry storm.
      await this.clearToken();
      this._cancelRefreshTimer();
      this.log('Token refresh rejected (401) — session ended, sign-in required.');
      if (!this.disposed) this._onSessionEnded.fire();
      return undefined;
    }
    // Transient (404 rollout skew / 5xx / malformed): keep everything, retry later.
    this.log(`Token refresh unavailable (status ${status}) — keeping session, will retry.`);
    this._armRetryBackoff();
    return undefined;
  }

  /** Deletes the stored embedded token, e.g. after a 401 that couldn't be refreshed. */
  async clearToken(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  /**
   * Mints a single-use bootstrap code for the embedded console iframe, using
   * the stored embed token as Bearer auth. The webview loads
   * `${orchestratorUrl}/embed?bc=<code>`, which sets the session cookie the
   * console authenticates with — the embed token itself never reaches the
   * webview.
   *
   * @throws if there's no stored (unexpired or refreshable) token, or the
   * mint request fails — e.g. the token was revoked server-side. Callers
   * minting a code during a panel render must catch this and fall back to
   * the Sign-In screen rather than let it crash the render.
   */
  async getBootstrapCode(): Promise<string> {
    const record = await this.getEmbeddedToken();
    if (!record) throw new Error('Not signed in');
    return fetchBootstrapCode(this.orchestratorUrl, record.accessToken);
  }

  /** True if a stored, usable-or-refreshable embedded token exists (i.e. this instance is paired). */
  async isSignedIn(): Promise<boolean> {
    return (await this.getEmbeddedToken()) !== undefined;
  }

  /**
   * Signs out: revokes the session server-side (so a leaked copy stops
   * working immediately, not just locally) and then clears local storage.
   * The revoke body carries the stored refresh token — the durable
   * credential — so sign-out works even when the short-TTL access token has
   * already expired; a still-live access token is additionally sent as the
   * Bearer header. Best-effort on the server call — local deletion always
   * happens.
   */
  async signOut(): Promise<void> {
    const record = await this._readStoredRecord();
    if (record) {
      try {
        const headers: Record<string, string> = {};
        if (record.accessToken && isTokenUsable(record, Date.now(), 0)) {
          headers.Authorization = `Bearer ${record.accessToken}`;
        }
        const body = record.refreshToken ? { refresh_token: record.refreshToken } : undefined;
        await requestJson('POST', `${this.orchestratorUrl}/api/auth/embed-token/revoke`, body, 10_000, headers);
      } catch (err) {
        this.log(`Sign-out server revoke failed (clearing locally anyway): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.clearToken();
    this.stopPolling();
    this._cancelRefreshTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this._cancelRefreshTimer();
    this.secretChangeSub.dispose();
    this._onTokenReceived.dispose();
    this._onSessionEnded.dispose();
  }

  private _beginPolling(session: DeviceCodeSession): void {
    this.stopPolling();
    const deadline = Date.now() + session.expiresIn * 1000;

    const tick = async (): Promise<void> => {
      if (Date.now() > deadline) {
        this.log('Device pairing expired before approval.');
        return;
      }

      this.log('Polling device pairing…');
      let outcome: PollOutcome;
      try {
        outcome = await this._pollOnce(session.deviceCode);
      } catch (err) {
        // Network timeout or invalid JSON — treat as transient and keep
        // polling until the deadline rather than aborting the whole flow.
        this.log(`Device pairing poll failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
        this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      if (outcome.status === 'pending') {
        this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      if (outcome.status === 'approved') {
        await this._storeToken(outcome.token);
        this.refreshFailures = 0;
        this._armRefreshTimer(outcome.token);
        this.log('Embedded token received and stored.');
        this._onTokenReceived.fire(outcome.token);
        return;
      }
      this.log(`Device pairing ended: ${outcome.status}.`);
    };

    this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  private async _pollOnce(deviceCode: string): Promise<PollOutcome> {
    const url = `${this.orchestratorUrl}/api/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`;
    const { body } = await requestJson<PollResponseBody>('GET', url);
    return mapPollOutcome(body, Date.now());
  }

  private async _storeToken(token: EmbeddedTokenRecord): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(token));
  }

  /** Raw storage read: returns whatever record is stored, expired or not. */
  private async _readStoredRecord(): Promise<EmbeddedTokenRecord | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EmbeddedTokenRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * Converges this window on whatever record is in shared storage (called on
   * construction and on every {@link vscode.SecretStorage.onDidChange} for
   * our key). A refresh-capable record re-arms the silent-refresh timer off
   * its expiry — another window rotating the pair is adopted, never treated
   * as a session end. A deleted / refresh-less record just cancels the
   * timer; ending the session (events, UX) is the job of whichever window
   * observed the authoritative 401 or performed the sign-out.
   */
  private async _adoptStoredRecord(): Promise<void> {
    const record = await this._readStoredRecord();
    if (!record?.refreshToken) {
      this._cancelRefreshTimer();
      return;
    }
    this.refreshFailures = 0;
    this._armRefreshTimer(record);
  }

  /**
   * Schedules the next silent refresh ~60 s before the access token expires
   * (clamped ≥ 1 s, de-synced by up to {@link REFRESH_JITTER_MS} across
   * windows — see {@link nextRefreshDelayMs}). No-op once disposed, so an
   * in-flight refresh resolving after teardown can't install a dangling timer.
   */
  private _armRefreshTimer(record: EmbeddedTokenRecord): void {
    this._cancelRefreshTimer();
    if (this.disposed || !record.refreshToken) return;
    const delay = nextRefreshDelayMs(record.expiresAt, Date.now(), REFRESH_LEAD_MS, REFRESH_MIN_DELAY_MS, REFRESH_JITTER_MS);
    this.refreshTimer = setTimeout(() => {
      void this.refreshNow();
    }, delay);
  }

  /** Schedules a retry after a transient refresh failure, on bounded exponential backoff. No-op once disposed. */
  private _armRetryBackoff(): void {
    this._cancelRefreshTimer();
    if (this.disposed) return;
    const delay = refreshRetryDelayMs(this.refreshFailures);
    this.refreshFailures += 1;
    this.refreshTimer = setTimeout(() => {
      void this.refreshNow();
    }, delay);
  }

  private _cancelRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}
