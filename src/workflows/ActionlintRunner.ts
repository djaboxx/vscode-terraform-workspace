import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

/**
 * Runs `actionlint` over `.github/workflows/*.{yml,yaml}` in the active
 * workspace folder and renders the results as VS Code diagnostics.
 *
 * Requires `actionlint` on PATH. If not installed, the command shows a one-time
 * notification with install hints.
 */
export class ActionlintRunner implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;

  constructor() {
    this.diagnostics = vscode.languages.createDiagnosticCollection('terraform-workspace-actionlint');
  }

  dispose(): void {
    this.diagnostics.dispose();
  }

  async run(
    folder: vscode.WorkspaceFolder,
    opts: { silent?: boolean; timeoutMs?: number; token?: vscode.CancellationToken } = {},
  ): Promise<ActionlintIssue[]> {
    const exe = await this.findExecutable();
    if (!exe) {
      if (!opts.silent) {
        const choice = await vscode.window.showWarningMessage(
          'actionlint not found on PATH. Install it to lint generated workflows.',
          'Install instructions',
        );
        if (choice === 'Install instructions') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/rhysd/actionlint/blob/main/docs/install.md'));
        }
      }
      return [];
    }

    const dir = path.join(folder.uri.fsPath, '.github', 'workflows');
    const timeoutMs = opts.timeoutMs ?? 15_000;

    return await new Promise<ActionlintIssue[]>(resolve => {
      const child = cp.execFile(
        exe,
        ['-format', '{{json .}}', '-no-color'],
        { cwd: dir, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGTERM' },
        (err, stdout, stderr) => {
          // actionlint exits 1 when issues are present; that's not a process error.
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            if (!opts.silent) vscode.window.showErrorMessage(`actionlint not found at ${exe}`);
            resolve([]);
            return;
          }
          // execFile sets killed=true and signal='SIGTERM' on timeout
          if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            if (!opts.silent) vscode.window.showWarningMessage(`actionlint timed out after ${timeoutMs}ms.`);
            resolve([]);
            return;
          }

          const issues = parseIssues(stdout, stderr);
          const byFile = new Map<string, vscode.Diagnostic[]>();
          for (const issue of issues) {
            const abs = path.isAbsolute(issue.filepath) ? issue.filepath : path.join(dir, issue.filepath);
            const range = new vscode.Range(
              Math.max(0, issue.line - 1), Math.max(0, issue.column - 1),
              Math.max(0, issue.line - 1), Math.max(0, issue.column - 1) + Math.max(1, (issue.snippet ?? '').length),
            );
            const diag = new vscode.Diagnostic(
              range,
              `[${issue.kind ?? 'actionlint'}] ${issue.message}`,
              vscode.DiagnosticSeverity.Warning,
            );
            diag.source = 'actionlint';
            (byFile.get(abs) ?? byFile.set(abs, []).get(abs)!).push(diag);
          }

          // Clear stale diagnostics for files in this folder
          this.diagnostics.forEach(uri => {
            if (uri.fsPath.startsWith(dir)) this.diagnostics.delete(uri);
          });
          for (const [file, diags] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), diags);
          }

          const total = issues.length;
          if (!opts.silent) {
            if (total === 0) {
              vscode.window.showInformationMessage('actionlint: no issues found.');
            } else {
              vscode.window.showWarningMessage(`actionlint: ${total} issue(s) across ${byFile.size} file(s).`);
            }
          }
          resolve(issues);
        },
      );

      // Wire user cancellation → SIGTERM the subprocess.
      if (opts.token) {
        const sub = opts.token.onCancellationRequested(() => {
          if (!child.killed) child.kill('SIGTERM');
        });
        child.on('exit', () => sub.dispose());
      }
    });
  }

  private findExecutable(): Promise<string | undefined> {
    return new Promise(resolve => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      cp.execFile(cmd, ['actionlint'], (err, stdout) => {
        if (err) { resolve(undefined); return; }
        const first = stdout.split(/\r?\n/).find(l => l.trim());
        resolve(first?.trim());
      });
    });
  }
}

export interface ActionlintIssue {
  filepath: string;
  line: number;
  column: number;
  message: string;
  kind?: string;
  snippet?: string;
}

function parseIssues(stdout: string, stderr: string): ActionlintIssue[] {
  const blob = (stdout || '').trim();
  if (!blob) {
    // actionlint prints usage on stderr if invocation failed; surface empty.
    if (stderr) console.warn('actionlint stderr:', stderr);
    return [];
  }
  try {
    const parsed = JSON.parse(blob);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw): ActionlintIssue => {
      const it = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      return {
        filepath: typeof it.filepath === 'string' ? it.filepath : '',
        line: Number(it.line ?? 1),
        column: Number(it.column ?? 1),
        message: String(it.message ?? ''),
        kind: typeof it.kind === 'string' ? it.kind : undefined,
        snippet: typeof it.snippet === 'string' ? it.snippet : undefined,
      };
    });
  } catch {
    return [];
  }
}
