import * as vscode from 'vscode';
import { requestJson } from './httpJson';
import {
  mapPollOutcome,
  isTokenUsable,
  type EmbeddedTokenRecord,
  type PollOutcome,
  type PollResponseBody,
} from './deviceFlow';

export type { EmbeddedTokenRecord } from './deviceFlow';

const POLL_INTERVAL_MS = 5000;
const SECRET_KEY = 'clustercode.embeddedToken';
/** Treat a token expiring within this window as already expired, so it isn't handed to a request it can't outlive. */
const EXPIRY_SKEW_MS = 30_000;

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
 * and persists the resulting embedded bearer token in VS Code's
 * {@link vscode.SecretStorage}.
 */
export class DevicePairingProvider implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _onTokenReceived = new vscode.EventEmitter<EmbeddedTokenRecord>();
  /** Fires once an embedded token has been received and stored. */
  readonly onTokenReceived = this._onTokenReceived.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly orchestratorUrl: string,
    private readonly log: (message: string) => void = () => {}
  ) {}

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
   * Returns the stored embedded token, or `undefined` if none is stored, it
   * fails to parse, or it has already expired. Expired tokens are treated as
   * absent (and cleared) so callers don't waste a round-trip discovering the
   * 401 — there is no refresh grant to salvage them with in v1.
   *
   * A small skew margin means a token about to expire mid-flight is refreshed
   * proactively rather than failing the request it was picked for.
   */
  async getEmbeddedToken(): Promise<EmbeddedTokenRecord | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    let record: EmbeddedTokenRecord;
    try {
      record = JSON.parse(raw) as EmbeddedTokenRecord;
    } catch {
      return undefined;
    }
    if (!isTokenUsable(record, Date.now(), EXPIRY_SKEW_MS)) {
      await this.clearToken();
      return undefined;
    }
    return record;
  }

  /** Deletes the stored embedded token, e.g. after a 401 that couldn't be refreshed. */
  async clearToken(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  /** True if a stored, unexpired embedded token exists (i.e. this instance is paired). */
  async isSignedIn(): Promise<boolean> {
    return (await this.getEmbeddedToken()) !== undefined;
  }

  /**
   * Signs out: revokes the current token server-side (so a leaked copy stops
   * working immediately, not just locally) and then clears local storage.
   * Best-effort on the server call — local deletion always happens.
   */
  async signOut(): Promise<void> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (raw) {
      try {
        const { accessToken } = JSON.parse(raw) as EmbeddedTokenRecord;
        await requestJson('POST', `${this.orchestratorUrl}/api/auth/embed-token/revoke`, undefined, 10_000, {
          Authorization: `Bearer ${accessToken}`,
        });
      } catch (err) {
        this.log(`Sign-out server revoke failed (clearing locally anyway): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.clearToken();
    this.stopPolling();
  }

  dispose(): void {
    this.stopPolling();
    this._onTokenReceived.dispose();
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
}
