#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const extDir = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));

// `--force` is REQUIRED: dev rebuilds keep the same version (0.1.0), and
// `code --install-extension` silently skips a .vsix whose version is already
// installed unless forced — which would leave the previous build in place and
// make a rebuild look like it did nothing.
execSync(`code --install-extension dist/clustercode-${version}.vsix --force`, {
  stdio: 'inherit',
  cwd: extDir,
});
