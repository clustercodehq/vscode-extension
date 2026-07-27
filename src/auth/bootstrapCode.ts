import { requestJson } from './httpJson';

/**
 * Mints a single-use bootstrap code for the embedded console iframe: a
 * Bearer-authed POST that exchanges the stored embed token for a short-lived
 * code. The webview then loads `${orchestratorUrl}/embed?bc=<code>`, which
 * consumes the code and sets the session cookie the console authenticates
 * with — the embed token itself is never handed to the webview.
 *
 * Pulled out of {@link ./devicePairingProvider} (which wraps this with the
 * "read the stored token" step) so the request/response handling is
 * `vscode`-free and directly unit-testable, mirroring how `deviceFlow.ts`
 * keeps its logic pure and testable outside the VS Code runtime.
 *
 * @throws if the request times out, the response isn't valid JSON, the
 * server doesn't return 200, or the body has no `code` (e.g. a revoked or
 * expired token). Callers minting a code during a panel render must catch
 * this and fall back to the Sign-In screen rather than let it propagate.
 */
export async function fetchBootstrapCode(orchestratorUrl: string, accessToken: string): Promise<string> {
  const { status, body } = await requestJson<{ code?: string; error?: string }>(
    'POST',
    `${orchestratorUrl}/api/auth/embed-bootstrap`,
    undefined,
    10_000,
    { Authorization: `Bearer ${accessToken}` }
  );

  if (status !== 200 || !body.code) {
    throw new Error(`Failed to mint bootstrap code (status ${status}): ${body.error ?? 'unknown error'}`);
  }
  return body.code;
}
