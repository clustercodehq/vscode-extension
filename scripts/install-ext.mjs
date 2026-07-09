#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const extDir = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));

execSync(`code --install-extension dist/clustercode-${version}.vsix`, {
  stdio: 'inherit',
  cwd: extDir,
});
