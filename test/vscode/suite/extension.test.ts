// SPDX-License-Identifier: MIT
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'HappyPathway.terraform-workspace';

suite('Extension activation', () => {
  test('extension is present', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Expected ${EXTENSION_ID} to be installed`);
  });

  test('extension activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('core commands are registered', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    const all = await vscode.commands.getCommands(true);
    const expected = [
      'terraform.scaffoldFromTemplate',
      'terraform.scaffoldOidcTrust',
      'terraform.scaffoldBackend',
    ];
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `Command ${cmd} not registered`);
    }
  });
});
