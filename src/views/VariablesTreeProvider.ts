import * as vscode from 'vscode';
import { TfVariable } from '../types/index.js';
import { GithubEnvironmentsClient } from '../github/GithubEnvironmentsClient.js';
import { GithubOrgsClient } from '../github/GithubOrgsClient.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

// Discriminated tree node types

export class VariableScopeGroup extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly scopeKey: string,
    public readonly envName?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'variableGroup';
  }
}

export class VariableTreeItem extends vscode.TreeItem {
  readonly variable: TfVariable;

  constructor(variable: TfVariable) {
    super(variable.key, vscode.TreeItemCollapsibleState.None);
    this.variable = variable;
    this.contextValue = 'variable';
    this.description = variable.sensitive ? '••••••' : (variable.value ?? '');
    this.iconPath = new vscode.ThemeIcon(variable.sensitive ? 'key' : 'symbol-variable');
    this.tooltip = `[${variable.scope}] ${variable.key}${variable.description ? ` — ${variable.description}` : ''}`;
  }
}

type VariablesNode = VariableScopeGroup | VariableTreeItem;

export class VariablesTreeProvider implements vscode.TreeDataProvider<VariablesNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly envsClient: GithubEnvironmentsClient,
    private readonly orgsClient: GithubOrgsClient,
    private readonly configManager: WorkspaceConfigManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: VariablesNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VariablesNode): Promise<VariablesNode[]> {
    const active = await this.configManager.getActive();
    if (!active) {
      return [];
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      return [];
    }

    if (!element) {
      return this.getTopLevelGroups(owner, repo, active.config.repo.repoOrg, active.config);
    }

    if (element instanceof VariableScopeGroup) {
      return this.getVariablesForGroup(element, owner, repo);
    }

    return [];
  }

  private async getTopLevelGroups(
    owner: string,
    repo: string,
    org: string,
    config?: import('../types/index.js').WorkspaceConfig,
  ): Promise<VariableScopeGroup[]> {
    const groups: VariableScopeGroup[] = [];

    // Only query GHA Environments when the repo is configured to use them
    const anyUseGhaEnv = !config || config.useGhaEnvironments !== false;
    if (anyUseGhaEnv) {
      try {
        const envs = await this.envsClient.listEnvironments(owner, repo);
        for (const env of envs) {
          groups.push(new VariableScopeGroup(`Env: ${env.name}`, `env:${env.name}`, env.name));
        }
      } catch {
        // ignore
      }
    }

    groups.push(new VariableScopeGroup('Repository', `repo:${owner}/${repo}`));
    groups.push(new VariableScopeGroup(`Org: ${org}`, `org:${org}`));

    return groups;
  }

  private async getVariablesForGroup(
    group: VariableScopeGroup,
    owner: string,
    repo: string,
  ): Promise<VariableTreeItem[]> {
    try {
      if (group.envName) {
        const [secrets, variables] = await Promise.all([
          this.envsClient.listEnvironmentSecrets(owner, repo, group.envName),
          this.envsClient.listEnvironmentVariables(owner, repo, group.envName),
        ]);
        return this.envsClient
          .toTfVariables(secrets, variables, 'environment', group.envName, `${owner}/${repo}`)
          .map(v => new VariableTreeItem(v));
      }

      if (group.scopeKey.startsWith('repo:')) {
        const [secrets, variables] = await Promise.all([
          this.envsClient.listRepoSecrets(owner, repo),
          this.envsClient.listRepoVariables(owner, repo),
        ]);
        return this.envsClient
          .toTfVariables(secrets, variables, 'repository', undefined, `${owner}/${repo}`)
          .map(v => new VariableTreeItem(v));
      }

      if (group.scopeKey.startsWith('org:')) {
        const orgName = group.scopeKey.slice(4);
        const varSet = await this.orgsClient.getOrgVariableSet(orgName);
        return varSet.variables.map(v => new VariableTreeItem(v));
      }
    } catch {
      // ignore
    }

    return [];
  }
}
