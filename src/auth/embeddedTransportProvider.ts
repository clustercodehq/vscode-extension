import * as vscode from 'vscode';
import { requestJson } from './httpJson';
import { DevicePairingProvider, EmbeddedTokenRecord } from './devicePairingProvider';

/** Transport used for extension-host calls to orchestrator API routes that require the embedded bearer token. */
export interface EmbeddedTransportProvider {
  request<T = unknown>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T>;
}

const CLI_SSO_LOGIN_COMMAND = 'clustercode login';

/**
 * Default {@link EmbeddedTransportProvider}: injects the stored embedded
 * bearer token as `Authorization: Bearer <token>` on every request; on a 401
 * it attempts one silent refresh ({@link HTTPTransport.refresh}) and retries
 * once, falling back to CLI SSO only when no refreshed token materializes.
 */
export class HTTPTransport implements EmbeddedTransportProvider {
  constructor(
    private readonly orchestratorUrl: string,
    private readonly pairing: DevicePairingProvider,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /**
   * @throws if no embedded token is stored, the request times out or
   * returns invalid JSON, a 401 survives both a refresh attempt and the CLI
   * SSO fallback, or the (possibly retried) response is a non-2xx status.
   */
  async request<T = unknown>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const url = `${this.orchestratorUrl}${path}`;

    const token = await this.pairing.getEmbeddedToken();
    if (!token) {
      throw new Error('No embedded token available — complete device pairing first.');
    }

    let { status, body } = await this._send(url, method, init.body, token.accessToken);

    if (status === 401) {
      this.log('Embedded token rejected with 401 — attempting refresh.');
      const refreshed = await this.refresh();
      if (!refreshed) {
        this.log('No refresh path available — falling back to CLI SSO.');
        await this._fallbackToCliSso();
        throw new Error('Embedded token expired and could not be refreshed; falling back to CLI sign-in.');
      }
      ({ status, body } = await this._send(url, method, init.body, refreshed.accessToken));
    }

    if (status < 200 || status >= 300) {
      throw new Error(`Orchestrator API request to ${path} failed with status ${status}`);
    }
    return body as T;
  }

  /**
   * Rotates the stored token pair via the pairing provider's single-flight
   * {@link DevicePairingProvider.refreshNow}. Resolves the fresh record on
   * success; resolves `undefined` when the session authoritatively ended
   * (401 — the provider clears storage and fires `onSessionEnded`) or on a
   * transient failure (endpoint absent / 5xx / network — session and stored
   * token kept), letting {@link request} fall through to the CLI SSO
   * fallback.
   */
  private async refresh(): Promise<EmbeddedTokenRecord | undefined> {
    return this.pairing.refreshNow();
  }

  private async _fallbackToCliSso(): Promise<void> {
    // Deliberately does NOT clear the stored record: on a transient refresh
    // failure (endpoint absent during rollout, 5xx, network) the refresh
    // token is still valid — deleting it would destroy the salvage path the
    // provider's backoff timer retries. On an authoritative session end the
    // provider has already cleared storage itself.
    const terminal = vscode.window.createTerminal('ClusterCode: Login');
    terminal.show();
    terminal.sendText(CLI_SSO_LOGIN_COMMAND);
  }

  private async _send(
    url: string,
    method: 'GET' | 'POST',
    body: unknown,
    accessToken: string
  ): Promise<{ status: number; body: unknown }> {
    const { status, body: responseBody } = await requestJson(method, url, body, 10_000, {
      Authorization: `Bearer ${accessToken}`,
    });
    return { status, body: responseBody };
  }
}
