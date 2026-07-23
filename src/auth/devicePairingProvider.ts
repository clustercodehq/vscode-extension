import * as vscode from 'vscode';
import { requestJson } from './httpJson';

const POLL_INTERVAL_MS = 5000;
const SECRET_KEY = 'clustercode.embeddedToken';

/** The device/user codes returned once a device-code pairing is started. */
export interface DeviceCodeSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the pairing expires if never approved. */
  expiresIn: number;
}

/** An embedded bearer token minted once a device-code pairing is approved. */
export interface EmbeddedTokenRecord {
  accessToken: string;
  tokenType: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

type PollOutcome =
  | { status: 'approved'; token: EmbeddedTokenRecord }
  | { status: 'pending' | 'denied' | 'expired' };

interface StartResponseBody {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  error?: string;
}

interface PollResponseBody {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
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

  /** Returns the stored embedded token, or `undefined` if none is stored (or it fails to parse). */
  async getEmbeddedToken(): Promise<EmbeddedTokenRecord | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EmbeddedTokenRecord;
    } catch {
      return undefined;
    }
  }

  /** Deletes the stored embedded token, e.g. after a 401 that couldn't be refreshed. */
  async clearToken(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
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

    if (body.access_token) {
      return {
        status: 'approved',
        token: {
          accessToken: body.access_token,
          tokenType: body.token_type ?? 'Bearer',
          expiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
        },
      };
    }
    if (body.error === 'authorization_pending') return { status: 'pending' };
    if (body.error === 'access_denied') return { status: 'denied' };
    // expired_token / invalid_grant / anything unrecognized — nothing more polling can do.
    return { status: 'expired' };
  }

  private async _storeToken(token: EmbeddedTokenRecord): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(token));
  }
}
