import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { getWorkspaces } from '../types/index.js';

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

  /** Returns env names that have pending changes in their last plan run. */
  async checkAll(): Promise<string[]> {
    const drifted: string[] = [];
    const active = await this.services.configManager.getActive();
    if (!active) return drifted;

    const [owner, repo] = active.config.repo.name.split('/');
    if (!owner || !repo) return drifted;

    for (const env of getWorkspaces(active.config)) {
      const filename = `terraform-plan-${env.name}.yml`;
      try {
        const runs = await this.services.actionsClient.getWorkflowRuns(owner, repo, filename, 1);
        const latest = runs[0];
        if (!latest) continue;
        if (latest.status === 'completed' && latest.conclusion === 'neutral') {
          drifted.push(env.name);
          this.out.appendLine(`[drift] ${env.name}: pending changes (run #${latest.run_number})`);
        }
      } catch (err) {
        this.out.appendLine(`[drift] ${env.name}: check failed: ${err}`);
      }
    }

    if (drifted.length > 0) {
      vscode.window.showWarningMessage(
        `Terraform drift detected in: ${drifted.join(', ')}`,
        'Open Runs',
      ).then(choice => {
        if (choice === 'Open Runs') {
          vscode.commands.executeCommand('terraform.runs.focus');
        }
      });
    }
    return drifted;
  }
}
