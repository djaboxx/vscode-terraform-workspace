// SPDX-License-Identifier: MIT
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // __dirname after compile = <repo>/out/test-vscode
    // extensionDevelopmentPath should be the repo root.
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
    });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
