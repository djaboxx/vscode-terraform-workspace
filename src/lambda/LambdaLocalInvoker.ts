import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Invokes a Lambda handler locally using a plain Python interpreter — no
 * Docker, no Lambda Runtime Interface Emulator. The target environment
 * cannot run `docker`, so we shell out to the user's Python via a stdlib-only
 * driver script (see `pythonLocalInvokeScript()` in `PythonDevScaffolder.ts`).
 *
 * Fidelity caveat: this catches handler logic + missing-dep bugs but does
 * NOT exercise the AL2-based Lambda runtime (glibc/musl mismatches, baked-in
 * binaries, etc.). For deploy-time correctness, the remote build via
 * `LambdaImageDispatcher` remains the source of truth.
 */

export interface LocalInvokeInputs {
  /** Folder that holds pyproject.toml + scripts/local_invoke.py + src/. */
  workingDirectory: vscode.Uri;
  /** Dotted handler path, e.g. "handler.lambda_handler". */
  handler: string;
  /** Path to the JSON event file to pass to the handler. Workspace-relative or absolute. */
  eventPath: string;
  /** Logical function name (used only for log context). */
  functionName: string;
  /** Optional explicit interpreter override; otherwise auto-resolved. */
  pythonPath?: string;
}

export interface LocalInvokeResult {
  exitCode: number;
  /** Full process stdout (also streamed into the output channel as it arrives). */
  stdout: string;
  /** Full process stderr. */
  stderr: string;
  /** Resolved interpreter actually used. */
  pythonPath: string;
}

export class LambdaLocalInvoker {
  constructor(private readonly output: vscode.OutputChannel) {}

  /**
   * Resolve a Python interpreter to use. Order:
   *   1. explicit `inputs.pythonPath`
   *   2. `python.defaultInterpreterPath` setting
   *   3. `<workingDirectory>/.venv/bin/python`
   *   4. `python3` on PATH
   * Returns the absolute path or `null` if nothing was found.
   */
  async resolvePython(inputs: LocalInvokeInputs): Promise<string | null> {
    if (inputs.pythonPath && (await pathExists(inputs.pythonPath))) return inputs.pythonPath;

    const setting = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
    if (setting && (await pathExists(setting))) return setting;

    const venv = path.join(inputs.workingDirectory.fsPath, '.venv', 'bin', 'python');
    if (await pathExists(venv)) return venv;

    // Fallback: rely on PATH lookup.
    return 'python3';
  }

  async invoke(inputs: LocalInvokeInputs, token: vscode.CancellationToken): Promise<LocalInvokeResult> {
    const py = await this.resolvePython(inputs);
    if (py === null) {
      throw new Error(
        'No Python interpreter found. Set `python.defaultInterpreterPath`, create a .venv in the project, or install Python 3 on PATH.',
      );
    }

    const cwd = inputs.workingDirectory.fsPath;
    const driver = path.join(cwd, 'scripts', 'local_invoke.py');
    if (!(await pathExists(driver))) {
      throw new Error(
        `Driver script not found at ${driver}. Run "Lambda: Scaffold Python Dev Environment…" first.`,
      );
    }

    const eventPath = path.isAbsolute(inputs.eventPath)
      ? inputs.eventPath
      : path.join(cwd, inputs.eventPath);
    if (!(await pathExists(eventPath))) {
      throw new Error(`Event JSON not found at ${eventPath}.`);
    }

    this.output.show(true);
    this.log(`▶ Local invoke: ${inputs.functionName} (${inputs.handler})`);
    this.log(`  python:  ${py}`);
    this.log(`  cwd:     ${cwd}`);
    this.log(`  event:   ${eventPath}`);

    return new Promise<LocalInvokeResult>((resolve, reject) => {
      const child = spawn(
        py,
        [
          driver,
          '--handler', inputs.handler,
          '--event', eventPath,
          '--src', 'src',
          '--function-name', inputs.functionName,
        ],
        { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf-8');
        stdout += s;
        this.output.append(s);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf-8');
        stderr += s;
        this.output.append(s);
      });

      const cancelSub = token.onCancellationRequested(() => {
        this.log('  ⚠ Cancellation requested — killing python child process.');
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      });

      child.once('error', (err) => {
        cancelSub.dispose();
        reject(new Error(`Failed to spawn ${py}: ${err.message}`));
      });
      child.once('close', (code) => {
        cancelSub.dispose();
        const exitCode = code ?? 0;
        this.log(`◀ exit ${exitCode}`);
        resolve({ exitCode, stdout, stderr, pythonPath: py });
      });
    });
  }

  private log(line: string): void {
    this.output.appendLine(line);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
