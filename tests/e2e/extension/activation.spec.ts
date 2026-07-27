/**
 * VS Code Extension Activation Test
 *
 * The active test reads package.json and verifies the expected commands are
 * declared — it needs neither VS Code nor @vscode/test-electron.
 *
 * The full activation checks (launching a VS Code instance, activating the
 * extension, confirming commands are executable) are scaffolded below as
 * `it.todo` and will require @vscode/test-electron and a VS Code installation
 * once wired up.
 *
 * Run: npx tsx tests/e2e/extension/activation.spec.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const EXPECTED_COMMANDS = [
  'clustercode.open',
  'clustercode.reload',
  'clustercode.pairDevice',
  'clustercode.signOut',
];

describe('VS Code Extension', () => {
  it('expected commands are defined in package.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const extensionRoot = join(__dirname, '..', '..', '..');
    const pkg = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf-8'));

    const registeredCommands: string[] = pkg.contributes.commands.map(
      (cmd: { command: string }) => cmd.command,
    );

    for (const expected of EXPECTED_COMMANDS) {
      assert.ok(
        registeredCommands.includes(expected),
        `Expected command "${expected}" to be registered in package.json`,
      );
    }
  });

  it('every registered command has a matching onCommand activation event', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const extensionRoot = join(__dirname, '..', '..', '..');
    const pkg = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf-8'));

    const activationEvents: string[] = pkg.activationEvents ?? [];
    for (const cmd of pkg.contributes.commands as { command: string }[]) {
      assert.ok(
        activationEvents.includes(`onCommand:${cmd.command}`),
        `Command "${cmd.command}" is missing an "onCommand:${cmd.command}" activation event`,
      );
    }
  });

  it.todo('extension activates in VS Code (requires @vscode/test-electron)');
  it.todo('commands are executable after activation');
});
