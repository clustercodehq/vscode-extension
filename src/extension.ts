import * as vscode from 'vscode';
import { ClusterCodePanel } from './panel';
import { resolveOrchestratorUrl } from './orchestrator-url';
import { DevicePairingProvider } from './auth/devicePairingProvider';
import { HTTPTransport, EmbeddedTransportProvider } from './auth/embeddedTransportProvider';

let embeddedTransport: EmbeddedTransportProvider | undefined;

/** The default transport for extension-host calls to bearer-authenticated orchestrator API routes. */
export function getEmbeddedTransport(): EmbeddedTransportProvider | undefined {
  return embeddedTransport;
}

/**
 * Starts a device-code pairing, shows the resulting code with a shortcut to
 * open the approval page in the browser, and surfaces any failure to start.
 * Invoked by the "Pair Device" command — which the panel's Sign-In screen
 * button also triggers via that same command.
 */
async function runDevicePairing(devicePairing: DevicePairingProvider, log: (message: string) => void): Promise<void> {
  try {
    const session = await devicePairing.startPairing();
    log(`Displaying pairing code ${session.userCode} to the user.`);
    const choice = await vscode.window.showInformationMessage(
      `ClusterCode: enter code ${session.userCode} to link this VS Code instance.`,
      'Open in Browser'
    );
    if (choice === 'Open in Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(session.verificationUri));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Device pairing failed to start: ${message}`);
    void vscode.window.showErrorMessage(`ClusterCode: failed to start device pairing — ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const authOutput = vscode.window.createOutputChannel('ClusterCode: Device Pairing');
  const log = (message: string) => authOutput.appendLine(`[${new Date().toISOString()}] ${message}`);

  const orchestratorUrl = resolveOrchestratorUrl(process.env.ORCHESTRATOR_URL);
  const devicePairing = new DevicePairingProvider(context.secrets, orchestratorUrl, log);
  embeddedTransport = new HTTPTransport(orchestratorUrl, devicePairing, log);

  // Reflect auth state into a context key so `when` clauses / UI can react, and
  // tell a returning, already-paired user they're signed in without forcing a
  // fresh device-code round-trip. We do NOT auto-start a pairing here: doing so
  // on every activation would spam new codes at users who never asked to sign in.
  const setSignedIn = (signedIn: boolean) => {
    void vscode.commands.executeCommand('setContext', 'clustercode.signedIn', signedIn);
  };
  void devicePairing.isSignedIn().then((signedIn) => {
    setSignedIn(signedIn);
    log(signedIn ? 'Already paired — embedded token present.' : 'Not paired — run "ClusterCode: Pair Device" to sign in.');
  });

  // Opens (or reveals) the console panel. The panel self-gates: Sign-In screen
  // when there's no valid embed token, the console once paired.
  const openPanel = () =>
    ClusterCodePanel.createOrShow(
      context.extensionUri,
      context.extensionMode === vscode.ExtensionMode.Development,
      // Decides 'running' vs 'signed-out'.
      () => devicePairing.getEmbeddedToken(),
      // Mints the single-use bootstrap code the iframe exchanges for its
      // session cookie (`${orchestratorUrl}/embed?bc=<code>`).
      () => devicePairing.getBootstrapCode(),
      log
    );

  context.subscriptions.push(
    authOutput,
    devicePairing,
    devicePairing.onTokenReceived(() => {
      // Fires on the initial pairing AND every silent refresh rotation (~every
      // 9 min). Only reflect signed-in state here — do NOT reload the panel or
      // toast, which on a rotation would wipe the embedded console's live state.
      setSignedIn(true);
    }),
    devicePairing.onPairingCompleted(() => {
      // A user-initiated device pairing finished (Sign In / Pair Device, or a
      // re-pair after the session ended). Swap the open panel straight to the
      // console and toast — ALWAYS, regardless of prior signed-in state. The
      // webview's session can die (its keep-alive 401s → "session ended"
      // overlay) while this host's silent-refresh loop still believes it's
      // signed in, so gating this on a signed-out→signed-in transition would
      // strand a re-pair behind the stale overlay until a manual reload.
      setSignedIn(true);
      ClusterCodePanel.reload();
      log('Device pairing flow complete.');
      void vscode.window.showInformationMessage('ClusterCode: this VS Code instance is now signed in.');
    }),
    devicePairing.onSessionEnded(() => {
      setSignedIn(false);
      // Drop an open console panel to the Sign-In screen — the session is
      // authoritatively dead (refresh rejected), not merely transiently broken.
      ClusterCodePanel.reload();
      log('Embedded session ended (refresh rejected) — sign-in required.');
      void vscode.window.showWarningMessage('ClusterCode: your session ended — sign in again.');
    }),
    vscode.commands.registerCommand('clustercode.pairDevice', () => {
      // "Sign In" — surface the panel (Sign-In screen) and start the device-code
      // flow. On approval, onTokenReceived reloads the panel to the console.
      openPanel();
      return runDevicePairing(devicePairing, log);
    }),
    vscode.commands.registerCommand('clustercode.signOut', async () => {
      await devicePairing.signOut();
      setSignedIn(false);
      // Re-render the open panel: with the token gone it shows the Sign-In
      // screen instead of leaving the console visible.
      ClusterCodePanel.reload();
      log('Signed out — embedded token revoked and cleared.');
      void vscode.window.showInformationMessage('ClusterCode: signed out.');
    }),
    vscode.commands.registerCommand('clustercode.open', () => openPanel()),
    vscode.commands.registerCommand('clustercode.reload', () =>
      ClusterCodePanel.reload()
    ),
  );
}

export function deactivate() {
  ClusterCodePanel.currentPanel?.dispose();
}
