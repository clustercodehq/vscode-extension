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

const EXPECTED_COMMANDS = ['clustercode.open', 'clustercode.reload'];

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

  it.todo('extension activates in VS Code (requires @vscode/test-electron)');
  it.todo('commands are executable after activation');
});
