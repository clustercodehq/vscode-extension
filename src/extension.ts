import * as vscode from 'vscode';
import { ClusterCodePanel } from './panel';

export function activate(context: vscode.ExtensionContext) {

  context.subscriptions.push(
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
