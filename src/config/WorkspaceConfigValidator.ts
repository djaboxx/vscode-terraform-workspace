import * as vscode from 'vscode';
import { WorkspaceConfigManager } from './WorkspaceConfigManager.js';
import { defineSchema, CompiledSchema, SchemaError } from '../schemas/defineSchema.js';

/**
 * Wires `.vscode/terraform-workspace.json` to a VS Code DiagnosticCollection.
 * AJV validates against the same schema that powers `jsonValidation` in
 * package.json — but here we surface results as red squigglies on the file
 * with line/column pointers, which the JSON contribution alone cannot do for
 * cross-field rules or custom message shaping.
 *
 * Validation runs on:
 *   - file open
 *   - file save
 *   - WorkspaceConfigManager.onDidChange (covers external edits/git pulls)
 */
export class WorkspaceConfigValidator implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private schema?: CompiledSchema<unknown>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configManager: WorkspaceConfigManager,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection('terraform-workspace');
    this.disposables.push(this.diagnostics);
  }

  async activate(): Promise<void> {
    await this.loadValidator();

    // Validate every currently-open instance of the config file
    for (const doc of vscode.workspace.textDocuments) {
      if (this.isConfigDoc(doc)) {
        this.validateDoc(doc);
      }
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (this.isConfigDoc(doc)) this.validateDoc(doc);
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (this.isConfigDoc(doc)) this.validateDoc(doc);
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (this.isConfigDoc(e.document)) this.validateDoc(e.document);
      }),
      this.configManager.onDidChange(folder => {
        const uri = this.configManager.configUri(folder);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) this.validateDoc(doc);
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private isConfigDoc(doc: vscode.TextDocument): boolean {
    return doc.uri.fsPath.endsWith('/.vscode/terraform-workspace.json')
        || doc.uri.fsPath.endsWith('\\.vscode\\terraform-workspace.json');
  }

  private async loadValidator(): Promise<void> {
    const schemaUri = vscode.Uri.joinPath(this.extensionUri, 'schemas', 'terraform-workspace.schema.json');
    let schemaJson: unknown;
    try {
      const bytes = await vscode.workspace.fs.readFile(schemaUri);
      schemaJson = JSON.parse(Buffer.from(bytes).toString('utf-8'));
    } catch (err) {
      console.error('terraform-workspace: failed to load schema', err);
      return;
    }
    this.schema = defineSchema(schemaJson as object);
  }

  private validateDoc(doc: vscode.TextDocument): void {
    if (!this.schema) {
      this.diagnostics.set(doc.uri, []);
      return;
    }

    const text = doc.getText();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      this.diagnostics.set(doc.uri, [parseDiagnostic(doc, err)]);
      return;
    }

    const result = this.schema.validate(parsed);
    if (result.ok) {
      this.diagnostics.set(doc.uri, []);
      return;
    }

    this.diagnostics.set(doc.uri, result.errors.map(e => schemaErrorToDiagnostic(doc, e, text)));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDiagnostic(doc: vscode.TextDocument, err: unknown): vscode.Diagnostic {
  // SyntaxError messages from JSON.parse usually include "at position N"
  const message = err instanceof Error ? err.message : String(err);
  const m = /at position (\d+)/.exec(message);
  let range: vscode.Range;
  if (m) {
    const pos = doc.positionAt(Number(m[1]));
    range = new vscode.Range(pos, pos);
  } else {
    range = new vscode.Range(0, 0, 0, 1);
  }
  return new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
}

function schemaErrorToDiagnostic(
  doc: vscode.TextDocument,
  err: SchemaError,
  text: string,
): vscode.Diagnostic {
  // SchemaError.path is JSON-pointer style (`/environments/0/cacheBucket`).
  // Walk the JSON text to find the failing property so we can point at it.
  const range = locatePath(doc, text, err.path);
  const message = `${err.path || '/'} ${err.message}`.trim();
  return new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
}

/**
 * Best-effort locator: walks `/a/b/2/c` into the JSON text to find an offset
 * range. Falls back to the document head if traversal fails. This is not a
 * full JSON parser — it uses lightweight regex per segment and is good enough
 * for human-readable squigglies on simple paths.
 */
function locatePath(doc: vscode.TextDocument, text: string, instancePath: string): vscode.Range {
  if (!instancePath) return new vscode.Range(0, 0, 0, 1);

  const segments = instancePath.split('/').filter(Boolean);
  let cursor = 0;

  for (const seg of segments) {
    const isIndex = /^\d+$/.test(seg);
    if (isIndex) {
      // Find the Nth `[` element in the slice starting at cursor.
      // Simpler: skip to the array opening then walk N commas at depth 0.
      const arrStart = text.indexOf('[', cursor);
      if (arrStart < 0) break;
      let depth = 0;
      let i = arrStart;
      let count = 0;
      const target = Number(seg);
      while (i < text.length) {
        const ch = text[i];
        if (ch === '[' || ch === '{') {
          if (depth === 1 && count === target && (text[i] === '{' || text[i] === '[')) {
            cursor = i;
            break;
          }
          depth++;
          if (depth === 1 && count === target) { cursor = i; break; }
        } else if (ch === ']' || ch === '}') {
          depth--;
        } else if (ch === ',' && depth === 1) {
          count++;
          if (count === target) {
            // Skip whitespace
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            cursor = j;
            break;
          }
        }
        i++;
      }
    } else {
      const re = new RegExp(`"${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
      re.lastIndex = cursor;
      const m = re.exec(text);
      if (!m) break;
      cursor = m.index;
    }
  }

  const start = doc.positionAt(cursor);
  // Underline the token at cursor — find end of identifier or value
  const endOffset = Math.min(cursor + 40, text.length);
  const end = doc.positionAt(endOffset);
  return new vscode.Range(start, end);
}
