import * as vscode from 'vscode';
import { TfWorkspace } from '../types/index.js';
import { GithubEnvironmentsClient } from '../github/GithubEnvironmentsClient.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

export class WorkspaceTreeItem extends vscode.TreeItem {
  readonly workspace: TfWorkspace;

  constructor(workspace: TfWorkspace) {
    super(workspace.name, vscode.TreeItemCollapsibleState.None);
    this.workspace = workspace;
    this.contextValue = 'workspace';
    this.description = workspace.repoSlug;
    this.tooltip = `${workspace.name} — ${workspace.repoSlug}`;
    this.iconPath = workspace.isActive
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('cloud');
  }
}

export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _activeWorkspace: TfWorkspace | undefined;

  constructor(
    private readonly envsClient: GithubEnvironmentsClient,
    private readonly configManager: WorkspaceConfigManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  selectWorkspace(item: WorkspaceTreeItem): void {
    this._activeWorkspace = { ...item.workspace, isActive: true };
    this.refresh();
  }

  getActiveWorkspace(): TfWorkspace | undefined {
    return this._activeWorkspace;
  }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(_element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    const active = await this.configManager.getActive();
    if (!active) {
      return [];
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      return [];
    }

    try {
      const envs = await this.envsClient.listEnvironments(owner, repo);
      return envs.map(env => {
        const ws = this.envsClient.toTfWorkspace(env, owner, repo, owner);
        ws.isActive = this._activeWorkspace?.id === ws.id;
        return new WorkspaceTreeItem(ws);
      });
    } catch {
      return [];
    }
  }
}
