import * as vscode from 'vscode';
import { TfRun, RunStatus, RunConclusion, RunType } from '../types/index.js';
import { GithubActionsClient, GhaWorkflowRun } from '../github/GithubActionsClient.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

export class RunTreeItem extends vscode.TreeItem {
  readonly run: TfRun;

  constructor(run: TfRun) {
    const label = `${run.type} — ${run.conclusion ?? run.status}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.run = run;
    this.contextValue = 'run';
    this.description = run.startedAt
      ? new Date(run.startedAt).toLocaleString()
      : String(run.workflowRunId);
    this.iconPath = new vscode.ThemeIcon(runIcon(run));
    this.tooltip = `Run #${run.workflowRunId}: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`;
  }
}

function runIcon(run: TfRun): string {
  switch (run.conclusion) {
    case 'success':   return 'pass';
    case 'failure':   return 'error';
    case 'cancelled': return 'circle-slash';
    case 'timed_out': return 'watch';
    default:
      return run.status === 'in_progress' ? 'loading~spin' : 'clock';
  }
}

function inferRunType(run: GhaWorkflowRun): RunType {
  const name = (run.name ?? '').toLowerCase();
  if (name.includes('apply')) return 'apply';
  if (name.includes('destroy')) return 'destroy';
  return 'plan';
}

export class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly actionsClient: GithubActionsClient,
    private readonly configManager: WorkspaceConfigManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RunTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(_element?: RunTreeItem): Promise<RunTreeItem[]> {
    const active = await this.configManager.getActive();
    if (!active) {
      return [];
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      return [];
    }

    try {
      const runs = await this.actionsClient.listRepoRuns(owner, repo, 20);
      const repoSlug = `${owner}/${repo}`;

      return runs.map(r => {
        const type = inferRunType(r);
        const tfRun = this.actionsClient.toTfRun(r, repoSlug, repoSlug, type);
        return new RunTreeItem(tfRun);
      });
    } catch {
      return [];
    }
  }
}
