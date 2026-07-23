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

export function activate(context: vscode.ExtensionContext) {
  const authOutput = vscode.window.createOutputChannel('ClusterCode: Device Pairing');
  const log = (message: string) => authOutput.appendLine(`[${new Date().toISOString()}] ${message}`);

  const orchestratorUrl = resolveOrchestratorUrl(process.env.ORCHESTRATOR_URL);
  const devicePairing = new DevicePairingProvider(context.secrets, orchestratorUrl, log);
  embeddedTransport = new HTTPTransport(orchestratorUrl, devicePairing, log);

  context.subscriptions.push(
    authOutput,
    devicePairing,
    devicePairing.onTokenReceived(() => log('Device pairing flow complete.')),
    vscode.commands.registerCommand('clustercode.pairDevice', async () => {
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
    }),
    vscode.commands.registerCommand('clustercode.open', () =>
      ClusterCodePanel.createOrShow(
        context.extensionUri,
        context.extensionMode === vscode.ExtensionMode.Development
      )
    ),
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
