import * as vscode from 'vscode';
import { ClusterCodePanel } from './panel';
import { resolveOrchestratorUrl } from './orchestrator-url';
import { DevicePairingProvider } from './auth/devicePairingProvider';
import { HTTPTransport, EmbeddedTransportProvider } from './auth/embeddedTransportProvider';
import { resolveOpenPromptChoice } from './auth/openFlow';

let embeddedTransport: EmbeddedTransportProvider | undefined;

/** The default transport for extension-host calls to bearer-authenticated orchestrator API routes. */
export function getEmbeddedTransport(): EmbeddedTransportProvider | undefined {
  return embeddedTransport;
}

/**
 * Starts a device-code pairing, shows the resulting code with a shortcut to
 * open the approval page in the browser, and surfaces any failure to start.
 * Shared by the explicit "Pair Device" command and by the "Sign In" choice
 * on the "Open" command's signed-out prompt.
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
  const setSignedIn = (signedIn: boolean) =>
    void vscode.commands.executeCommand('setContext', 'clustercode.signedIn', signedIn);
  void devicePairing.isSignedIn().then((signedIn) => {
    setSignedIn(signedIn);
    log(signedIn ? 'Already paired — embedded token present.' : 'Not paired — run "ClusterCode: Pair Device" to sign in.');
  });

  context.subscriptions.push(
    authOutput,
    devicePairing,
    devicePairing.onTokenReceived(() => {
      setSignedIn(true);
      log('Device pairing flow complete.');
      void vscode.window.showInformationMessage('ClusterCode: this VS Code instance is now signed in.');
    }),
    vscode.commands.registerCommand('clustercode.pairDevice', () => runDevicePairing(devicePairing, log)),
    vscode.commands.registerCommand('clustercode.signOut', async () => {
      await devicePairing.signOut();
      setSignedIn(false);
      log('Signed out — embedded token revoked and cleared.');
      void vscode.window.showInformationMessage('ClusterCode: signed out.');
    }),
    vscode.commands.registerCommand('clustercode.open', async () => {
      const openPanel = () =>
        ClusterCodePanel.createOrShow(
          context.extensionUri,
          context.extensionMode === vscode.ExtensionMode.Development,
          // Lets the webview console fetch the current embedded bearer token from
          // the local broker to authenticate its same-origin API calls.
          () => devicePairing.getEmbeddedToken()
        );

      if (await devicePairing.isSignedIn()) {
        openPanel();
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        'Sign in to ClusterCode to open the console.',
        'Sign In',
        'Open Without Signing In'
      );

      switch (resolveOpenPromptChoice(choice)) {
        case 'signIn': {
          // Registered *before* starting pairing so a fast approval can't
          // fire onTokenReceived before this listener exists. One-shot: it
          // disposes itself the moment it opens the panel, so a later
          // re-pair (e.g. after "Sign Out") won't reopen the panel on its
          // own. This is additive to — and independent of — the always-on
          // onTokenReceived listener above, which only updates sign-in
          // state and notifies; it stays subscribed for the extension's
          // lifetime and is unaffected by this one firing or disposing.
          const openOnceSignedIn = devicePairing.onTokenReceived(() => {
            openOnceSignedIn.dispose();
            openPanel();
          });
          await runDevicePairing(devicePairing, log);
          break;
        }
        case 'openAnonymously':
          openPanel();
          break;
        case 'none':
          break;
      }
    }),
    vscode.commands.registerCommand('clustercode.reload', () =>
      ClusterCodePanel.reload()
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('clustercode.extraFrameOrigins')) {
        ClusterCodePanel.onConfigChanged();
      }
    }),
  );
}

export function deactivate() {
  ClusterCodePanel.currentPanel?.dispose();
}
