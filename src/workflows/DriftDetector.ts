import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExtensionServices } from '../services.js';
import { getWorkspaces } from '../types/index.js';

/** Structured result for a single environment's drift check. */
export interface DriftResult {
  /** GitHub Actions environment name. */
  envName: string;
  /** GHA run ID for the plan that detected drift. */
  runId: number;
  /** URL to the GHA run page. */
  runUrl: string;
  /**
   * Human-readable plan text (`terraform show -no-color`).
   * Populated on a best-effort basis; may be undefined if logs are unavailable.
   */
  planText?: string;
  /**
   * Source that provided the plan text — used for display hints.
   *  - `'gha-artifact'`  — downloaded from the `actions/upload-artifact` step.
   *  - `'gha-logs'`      — extracted from the raw run-log zip.
   *  - `'codebuild-local'` — read from `.tf-artifacts/` on the local filesystem.
   */
  planSource?: 'gha-artifact' | 'gha-logs' | 'codebuild-local';
}

/**
 * Periodically polls each environment's plan workflow and surfaces drift —
 * defined as the latest plan run completing with `conclusion=neutral` (the
 * exit code we map from `terraform plan -detailed-exitcode == 2`).
 *
 * Schedule is controlled by `terraformWorkspace.driftCheckMinutes`. A value
 * of 0 (default) disables the timer; the user can still run drift checks
 * on-demand via the `terraform.checkDrift` command.
 */
export class DriftDetector implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly services: ExtensionServices,
    private readonly out: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('terraformWorkspace.driftCheckMinutes')) {
          this.reschedule();
        }
      }),
    );
    this.reschedule();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
  }

  reschedule(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const minutes = vscode.workspace.getConfiguration('terraformWorkspace').get<number>('driftCheckMinutes', 0);
    if (!minutes || minutes <= 0) return;
    this.timer = setInterval(() => {
      this.checkAll().catch(err => this.out.appendLine(`[drift] ${err}`));
    }, minutes * 60 * 1000);
  }

  /**
   * Checks all environments for drift.
   * Returns a `DriftResult` for each environment that has pending changes,
   * including a best-effort fetch of the plan text for visualization.
   *
   * Also surfaces a notification (unchanged UX) and returns the bare name
   * list via the `names` property for callers that just need the strings.
   */
  async checkAll(): Promise<DriftResult[]> {
    const results: DriftResult[] = [];
    const active = await this.services.configManager.getActive();
    if (!active) return results;

    const [owner, repo] = active.config.repo.name.split('/');
    if (!owner || !repo) return results;

    const workspaceFolder = active.folder;

    for (const env of getWorkspaces(active.config)) {
      const filename = `terraform-plan-${env.name}.yml`;
      try {
        const runs = await this.services.actionsClient.getWorkflowRuns(owner, repo, filename, 1);
        const latest = runs[0];
        if (!latest) continue;
        if (latest.status !== 'completed' || latest.conclusion !== 'neutral') continue;

        this.out.appendLine(`[drift] ${env.name}: pending changes (run #${latest.run_number})`);

        const result: DriftResult = {
          envName: env.name,
          runId: latest.id,
          runUrl: latest.html_url,
        };

        // ── Fetch plan text ────────────────────────────────────────────────
        // Path A: CodeBuild local-dispatch — read from .tf-artifacts/ on disk.
        const effectiveExecutor = env.executor ?? active.config.executor ?? 'inline';
        if (effectiveExecutor === 'codebuild' && workspaceFolder) {
          const planText = await this.readLocalCbArtifact(workspaceFolder, env.name);
          if (planText) {
            result.planText = planText;
            result.planSource = 'codebuild-local';
          }
        }

        // Path B: GHA artifact or log zip (used for inline executor, or as
        // fallback when CodeBuild ran via GHA orchestration).
        if (!result.planText) {
          try {
            const planText = await this.services.actionsClient.fetchPlanText(
              owner, repo, latest.id, env.name, env.cacheBucket,
            );
            if (planText) {
              // Distinguish which strategy succeeded based on content heuristics;
              // the client returns plain text regardless of source.
              result.planText = planText;
              result.planSource = 'gha-artifact';
            }
          } catch {
            // best effort — panel will show "plan text unavailable"
          }
        }

        results.push(result);
      } catch (err) {
        this.out.appendLine(`[drift] ${env.name}: check failed: ${err}`);
      }
    }

    if (results.length > 0) {
      const names = results.map(r => r.envName).join(', ');
      vscode.window.showWarningMessage(
        `Terraform drift detected in: ${names}`,
        'View Diff',
        'Open Runs',
      ).then(choice => {
        if (choice === 'View Diff') {
          vscode.commands.executeCommand('terraform.showDriftDiff', results);
        } else if (choice === 'Open Runs') {
          vscode.commands.executeCommand('terraform.runs.focus');
        }
      });
    }
    return results;
  }

  /**
   * Reads `plan.txt` from the most recent CodeBuild local-artifact directory
   * for the given environment (`<workspaceFolder>/.tf-artifacts/<env>/`).
   */
  private async readLocalCbArtifact(
    folder: vscode.WorkspaceFolder,
    envName: string,
  ): Promise<string | undefined> {
    try {
      const artifactBase = path.join(folder.uri.fsPath, '.tf-artifacts', envName);
      const runs = await fs.readdir(artifactBase);
      if (runs.length === 0) return undefined;

      // Sort run directories by name (they're timestamped); take the latest.
      const latest = runs.sort().at(-1)!;
      const planPath = path.join(artifactBase, latest, 'plan.txt');
      return await fs.readFile(planPath, 'utf-8');
    } catch {
      return undefined;
    }
  }
}
