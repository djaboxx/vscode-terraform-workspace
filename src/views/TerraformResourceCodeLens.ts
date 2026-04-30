import * as vscode from 'vscode';

/**
 * Adds a CodeLens above each `resource "..." "..." {` block linking to the
 * Terraform Registry documentation for that resource type. Lens command opens
 * the registry page in the user's external browser.
 */
export class TerraformResourceCodeLens implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!doc.fileName.endsWith('.tf')) return [];
    const lenses: vscode.CodeLens[] = [];
    const re = /^(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
    const text = doc.getText();
    for (const m of text.matchAll(re)) {
      const offset = m.index ?? 0;
      const pos = doc.positionAt(offset);
      const range = new vscode.Range(pos, pos);
      const kind = m[1];
      const typeOrSource = m[2];

      if (kind === 'resource' || kind === 'data') {
        const provider = typeOrSource.split('_', 1)[0];
        const url = `https://registry.terraform.io/providers/hashicorp/${provider}/latest/docs/${kind === 'data' ? 'data-sources' : 'resources'}/${typeOrSource.replace(new RegExp('^' + provider + '_'), '')}`;
        lenses.push(new vscode.CodeLens(range, {
          title: `$(book) ${kind} docs`,
          command: 'vscode.open',
          arguments: [vscode.Uri.parse(url)],
        }));
      } else if (kind === 'module' && typeOrSource) {
        // module "name" { source = "..." } — we can't peek the source from
        // here, but offer to jump to the source line.
        lenses.push(new vscode.CodeLens(range, {
          title: '$(symbol-module) module',
          command: 'editor.action.peekDefinition',
          arguments: [],
        }));
      }
    }
    return lenses;
  }
}
