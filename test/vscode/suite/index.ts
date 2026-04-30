// SPDX-License-Identifier: MIT
/* eslint-disable @typescript-eslint/no-require-imports */
import * as path from 'node:path';
import * as fs from 'node:fs';

// Minimal Mocha-compatible test runner. Avoids adding mocha as a dep by using
// the bundled VS Code test runner conventions. We dynamically require Mocha
// because @vscode/test-electron resolves it from the host VS Code download.
export function run(): Promise<void> {
  // Lazy-require so that this file can be type-checked without mocha installed
  // at the workspace level. mocha is provided by @vscode/test-electron's
  // bundled test runner.
  const Mocha = require('mocha') as typeof import('mocha');
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });

  const testsRoot = __dirname;
  const files = fs
    .readdirSync(testsRoot)
    .filter((f) => f.endsWith('.test.js'));
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
