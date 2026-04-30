import * as vscode from 'vscode';
import { GithubEnvironmentsClient } from '../github/GithubEnvironmentsClient.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

/**
 * Catalogue of repo/env settings the scaffolded composite actions require to
 * function. Surfaced in a dedicated tree view so users can see what's missing
 * and set values (including secrets) without leaving VS Code.
 */
export interface RequiredSettingDef {
  name: string;
  kind: 'variable' | 'secret';
  scope: 'repository' | 'environment';
  usedBy: string;
  purpose: string;
  optional?: boolean;
}

export const REQUIRED_SETTINGS: readonly RequiredSettingDef[] = [
  {
    name: 'AWS_ROLE_TO_ASSUME',
    kind: 'variable',
    scope: 'environment',
    usedBy: 'aws-auth',
    purpose: 'IAM role ARN assumed via OIDC.',
  },
  {
    name: 'APP_ID',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'gh-auth',
    purpose: 'GitHub App ID used to mint installation tokens.',
  },
  {
    name: 'APP_PRIVATE_KEY',
    kind: 'secret',
    scope: 'repository',
    usedBy: 'gh-auth',
    purpose: 'PEM private key for the GitHub App.',
  },
  {
    name: 'TF_STATE_BUCKET',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'terraform-init',
    purpose: 'S3 bucket holding tfstate.',
  },
  {
    name: 'TF_STATE_REGION',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'terraform-init / aws-auth',
    purpose: 'AWS region for state and default provider region.',
  },
  {
    name: 'TF_STATE_DYNAMODB_TABLE',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'terraform-init',
    purpose: 'DynamoDB table for state locking (optional).',
    optional: true,
  },
  {
    name: 'TF_STATE_KEY_PREFIX',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'terraform-init',
    purpose: 'Prefix prepended to the state object key.',
  },
  {
    name: 'TF_CACHE_BUCKET',
    kind: 'variable',
    scope: 'repository',
    usedBy: 'terraform-init / plan / apply / s3-cleanup',
    purpose: 'S3 bucket used to hand .terraform/ and the plan binary between jobs.',
  },
];

/** Tree node: a scope grouping ("Repository" or "Env: <name>"). */
export class RequiredScopeGroup extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly scope: 'repository' | 'environment',
    public readonly envName?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(scope === 'environment' ? 'server-environment' : 'repo');
    this.contextValue = 'requiredSetupGroup';
  }
}

/** Tree node: a single required variable/secret. */
export class RequiredSettingItem extends vscode.TreeItem {
  constructor(
    public readonly def: RequiredSettingDef,
    public readonly envName: string | undefined,
    public readonly isSet: boolean,
    public readonly currentValue: string | undefined,
  ) {
    super(def.name, vscode.TreeItemCollapsibleState.None);
    const status = isSet ? '$(check)' : (def.optional ? '$(circle-outline)' : '$(error)');
    const kindLabel = def.kind === 'secret' ? 'secret' : 'variable';
    const optTag = def.optional ? ' (optional)' : '';
    this.description = `${status} ${kindLabel}${optTag}`;
    this.iconPath = new vscode.ThemeIcon(def.kind === 'secret' ? 'key' : 'symbol-variable');
    const valueLine = def.kind === 'secret'
      ? (isSet ? 'Set (value hidden)' : 'Not set')
      : (isSet ? `= ${currentValue ?? ''}` : 'Not set');
    this.tooltip = new vscode.MarkdownString(
      `**${def.name}** — ${kindLabel}\n\n` +
      `Scope: ${def.scope}${envName ? ` (${envName})` : ''}\n\n` +
      `Used by: \`${def.usedBy}\`\n\n` +
      `${def.purpose}\n\n` +
      `Status: ${valueLine}`
    );
    this.contextValue = isSet ? 'requiredSettingSet' : 'requiredSettingMissing';
    this.command = {
      command: 'terraform.requiredSetup.set',
      title: 'Set value',
      arguments: [this],
    };
  }
}

export type RequiredSetupNode = RequiredScopeGroup | RequiredSettingItem;

export class RequiredSetupTreeProvider implements vscode.TreeDataProvider<RequiredSetupNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly envsClient: GithubEnvironmentsClient,
    private readonly configManager: WorkspaceConfigManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RequiredSetupNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RequiredSetupNode): Promise<RequiredSetupNode[]> {
    const active = await this.configManager.getActive();
    if (!active) return [];

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) return [];

    if (!element) {
      const groups: RequiredScopeGroup[] = [
        new RequiredScopeGroup('Repository', 'repository'),
      ];

      if (active.config.useGhaEnvironments !== false) {
        try {
          const envs = await this.envsClient.listEnvironments(owner, repo);
          for (const env of envs) {
            groups.push(new RequiredScopeGroup(`Env: ${env.name}`, 'environment', env.name));
          }
        } catch {
          // ignore — show repo-scoped group only
        }
      }
      return groups;
    }

    if (element instanceof RequiredScopeGroup) {
      const defs = REQUIRED_SETTINGS.filter(d => d.scope === element.scope);
      if (defs.length === 0) return [];

      try {
        if (element.scope === 'repository') {
          const [secrets, variables] = await Promise.all([
            this.envsClient.listRepoSecrets(owner, repo),
            this.envsClient.listRepoVariables(owner, repo),
          ]);
          const secretNames = new Set(secrets.map(s => s.name));
          const varMap = new Map(variables.map(v => [v.name, v.value]));
          return defs.map(def => {
            const isSet = def.kind === 'secret' ? secretNames.has(def.name) : varMap.has(def.name);
            return new RequiredSettingItem(def, undefined, isSet, varMap.get(def.name));
          });
        }

        if (element.scope === 'environment' && element.envName) {
          const [secrets, variables] = await Promise.all([
            this.envsClient.listEnvironmentSecrets(owner, repo, element.envName),
            this.envsClient.listEnvironmentVariables(owner, repo, element.envName),
          ]);
          const secretNames = new Set(secrets.map(s => s.name));
          const varMap = new Map(variables.map(v => [v.name, v.value]));
          return defs.map(def => {
            const isSet = def.kind === 'secret' ? secretNames.has(def.name) : varMap.has(def.name);
            return new RequiredSettingItem(def, element.envName, isSet, varMap.get(def.name));
          });
        }
      } catch {
        // Fall through with "unknown" status
        return defs.map(def => new RequiredSettingItem(def, element.envName, false, undefined));
      }
    }

    return [];
  }
}
