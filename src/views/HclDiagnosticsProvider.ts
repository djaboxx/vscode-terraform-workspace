import * as vscode from 'vscode';

/**
 * Lightweight Terraform style diagnostics. Not a parser — just regex checks
 * for the most common review nits we care about:
 *   - hardcoded AWS region strings (looks like `region = "us-east-1"`)
 *   - resources missing tags (`resource "aws_*" "..." { ... }` with no `tags`)
 *   - missing `required_version` / `required_providers` in versions.tf
 *
 * Diagnostics are scoped to *.tf files in the workspace and refresh on
 * save + open. Findings appear in the Problems panel.
 */
export class HclDiagnosticsProvider implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.diagnostics = vscode.languages.createDiagnosticCollection('terraform-hcl');
    this.disposables.push(this.diagnostics);

    for (const doc of vscode.workspace.textDocuments) this.lint(doc);

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => this.lint(d)),
      vscode.workspace.onDidSaveTextDocument(d => this.lint(d)),
      vscode.workspace.onDidCloseTextDocument(d => this.diagnostics.delete(d.uri)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private lint(doc: vscode.TextDocument): void {
    if (!doc.fileName.endsWith('.tf')) return;
    const text = doc.getText();
    const issues: vscode.Diagnostic[] = [];

    // Hardcoded AWS regions — `region = "us-east-1"` outside provider blocks
    // is fine in some cases, so this is a Hint rather than a Warning.
    const regionRe = /\bregion\s*=\s*"(us|eu|ap|sa|ca|me|af)-[a-z]+-\d"/g;
    for (const m of text.matchAll(regionRe)) {
      const range = rangeFromMatch(doc, m);
      const d = new vscode.Diagnostic(range, 'Hardcoded AWS region — consider using a variable.', vscode.DiagnosticSeverity.Hint);
      d.source = 'terraform-workspace';
      d.code = 'hardcoded-region';
      issues.push(d);
    }

    // `resource "aws_..." "name" { ... }` blocks without a `tags = {` line
    const resourceRe = /resource\s+"(aws_\w+)"\s+"[^"]+"\s*\{([\s\S]*?)\n\}/g;
    for (const m of text.matchAll(resourceRe)) {
      const body = m[2] ?? '';
      // Skip well-known untaggable resources
      if (/^(aws_iam_(role_)?policy_attachment|aws_route|aws_lb_listener_rule|aws_security_group_rule)$/.test(m[1])) continue;
      if (!/\btags\s*=/.test(body)) {
        const range = rangeFromMatch(doc, m);
        const d = new vscode.Diagnostic(range, `${m[1]} block has no \`tags\` attribute.`, vscode.DiagnosticSeverity.Information);
        d.source = 'terraform-workspace';
        d.code = 'missing-tags';
        issues.push(d);
      }
    }

    // versions.tf checks
    if (doc.fileName.endsWith('/versions.tf') || doc.fileName.endsWith('\\versions.tf')) {
      if (!/required_version\s*=/.test(text)) {
        issues.push(headDiagnostic(doc, '`versions.tf` is missing `required_version`.', 'missing-required-version'));
      }
      if (!/required_providers\s*\{/.test(text)) {
        issues.push(headDiagnostic(doc, '`versions.tf` is missing a `required_providers` block.', 'missing-required-providers'));
      }
    }

    this.diagnostics.set(doc.uri, issues);
  }
}

function rangeFromMatch(doc: vscode.TextDocument, m: RegExpMatchArray): vscode.Range {
  const start = doc.positionAt(m.index ?? 0);
  const end = doc.positionAt((m.index ?? 0) + Math.min(m[0].length, 80));
  return new vscode.Range(start, end);
}

function headDiagnostic(doc: vscode.TextDocument, message: string, code: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Warning);
  d.source = 'terraform-workspace';
  d.code = code;
  return d;
}
