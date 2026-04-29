import * as vscode from 'vscode';
import { GithubAuthProvider } from './auth/GithubAuthProvider.js';
import { GithubActionsClient } from './github/GithubActionsClient.js';
import { GithubEnvironmentsClient } from './github/GithubEnvironmentsClient.js';
import { GithubOrgsClient } from './github/GithubOrgsClient.js';
import { GithubSearchClient } from './github/GithubSearchClient.js';
import { WorkspaceConfigManager } from './config/WorkspaceConfigManager.js';
import { WorkspacesTreeProvider, WorkspaceTreeItem } from './views/WorkspacesTreeProvider.js';
import { VariablesTreeProvider, VariableTreeItem } from './views/VariablesTreeProvider.js';
import { RunsTreeProvider, RunTreeItem } from './views/RunsTreeProvider.js';
import { WorkspaceConfigPanel } from './views/WorkspaceConfigPanel.js';
import { TerraformChatParticipant } from './chat/TerraformChatParticipant.js';
import { registerTerraformTools } from './tools/TerraformTools.js';
import { WorkflowGenerator } from './workflows/WorkflowGenerator.js';
import { TerraformFileCache } from './cache/TerraformFileCache.js';
import { ExtensionServices } from './services.js';
import { TfWorkspace } from './types/index.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new GithubAuthProvider();
  const actionsClient = new GithubActionsClient(auth);
  const envsClient = new GithubEnvironmentsClient(auth);
  const orgsClient = new GithubOrgsClient(auth);
  const searchClient = new GithubSearchClient(auth);
  const configManager = new WorkspaceConfigManager(context);
  const tfCache = new TerraformFileCache(context.globalStorageUri.fsPath);

  // Warm the cache before anything needs it; watcher keeps it current afterwards
  tfCache.initialize();
  context.subscriptions.push(tfCache);

  const services: ExtensionServices = { auth, actionsClient, envsClient, orgsClient, searchClient, configManager, tfCache };

  const outputChannel = vscode.window.createOutputChannel('Terraform Workspace');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(configManager.startWatching());

  // ── Status bar: active folder indicator ───────────────────────────────────

  const folderStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  folderStatusBar.command = 'terraform.selectFolder';
  folderStatusBar.tooltip = 'Terraform: click to switch workspace folder';
  context.subscriptions.push(folderStatusBar);

  const refreshFolderStatusBar = async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      folderStatusBar.hide();
      return;
    }
    const pinned = configManager.getActiveFolder() ?? folders[0];
    folderStatusBar.text = `$(folder) Terraform: ${pinned.name}`;
    folderStatusBar.show();
  };

  await refreshFolderStatusBar();

  // ── Tree views ─────────────────────────────────────────────────────────────

  const workspacesProvider = new WorkspacesTreeProvider(envsClient, configManager);
  const variablesProvider = new VariablesTreeProvider(envsClient, orgsClient, configManager);
  const runsProvider = new RunsTreeProvider(actionsClient, configManager);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('terraform.workspaces', workspacesProvider),
    vscode.window.registerTreeDataProvider('terraform.variables', variablesProvider),
    vscode.window.registerTreeDataProvider('terraform.runs', runsProvider),
  );

  // Refresh views when config changes on disk
  context.subscriptions.push(
    configManager.onDidChange(() => {
      workspacesProvider.refresh();
      variablesProvider.refresh();
      runsProvider.refresh();
      refreshFolderStatusBar();
    }),
  );

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(

    vscode.commands.registerCommand('terraform.selectFolder', async () => {
      const chosen = await configManager.pickFolder();
      if (chosen) {
        await refreshFolderStatusBar();
        workspacesProvider.refresh();
        variablesProvider.refresh();
        runsProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('terraform.refreshWorkspaces', () => {
      workspacesProvider.refresh();
      variablesProvider.refresh();
      runsProvider.refresh();
    }),

    vscode.commands.registerCommand('terraform.selectWorkspace', (item: WorkspaceTreeItem) => {
      workspacesProvider.selectWorkspace(item);
    }),

    vscode.commands.registerCommand('terraform.runPlan', async (item?: WorkspaceTreeItem) => {
      const ws = item?.workspace ?? workspacesProvider.getActiveWorkspace();
      if (!ws) {
        vscode.window.showWarningMessage(
          'No workspace selected. Click a workspace in the Terraform Workspaces view first.',
        );
        return;
      }
      await triggerRun('plan', ws, services, outputChannel, runsProvider);
    }),

    vscode.commands.registerCommand('terraform.runApply', async (item?: WorkspaceTreeItem) => {
      const ws = item?.workspace ?? workspacesProvider.getActiveWorkspace();
      if (!ws) {
        vscode.window.showWarningMessage('No workspace selected.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Apply Terraform changes to "${ws.name}"? This is destructive.`,
        { modal: true },
        'Apply',
      );
      if (confirm !== 'Apply') return;
      await triggerRun('apply', ws, services, outputChannel, runsProvider);
    }),

    vscode.commands.registerCommand('terraform.openRunLogs', (item: RunTreeItem) => {
      if (item?.run?.htmlUrl) {
        vscode.env.openExternal(vscode.Uri.parse(item.run.htmlUrl));
      }
    }),

    vscode.commands.registerCommand('terraform.addVariable', async () => {
      const active = await configManager.getActive();
      if (!active) {
        vscode.window.showWarningMessage('No workspace config found.');
        return;
      }

      const scope = await vscode.window.showQuickPick(
        ['environment', 'repository', 'organization'],
        { placeHolder: 'Select variable scope' },
      );
      if (!scope) return;

      const key = await vscode.window.showInputBox({ prompt: 'Variable name' });
      if (!key) return;

      const value = await vscode.window.showInputBox({ prompt: 'Variable value', password: false });
      if (value === undefined) return;

      const { repoOrg: owner, name: repo } = active.config.repo;

      try {
        if (scope === 'environment') {
          const envName = await pickEnvironment(envsClient, owner, repo);
          if (!envName) return;
          await envsClient.setEnvironmentVariable(owner, repo, envName, key, value);
        } else if (scope === 'repository') {
          await envsClient.setRepoVariable(owner, repo, key, value);
        } else {
          await orgsClient.setOrgVariable(owner, key, value);
        }
        variablesProvider.refresh();
        vscode.window.showInformationMessage(`Variable "${key}" set.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to set variable: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.addSecret', async () => {
      const active = await configManager.getActive();
      if (!active) {
        vscode.window.showWarningMessage('No workspace config found.');
        return;
      }

      const scope = await vscode.window.showQuickPick(
        ['environment', 'repository', 'organization'],
        { placeHolder: 'Select secret scope' },
      );
      if (!scope) return;

      const key = await vscode.window.showInputBox({ prompt: 'Secret name' });
      if (!key) return;

      const value = await vscode.window.showInputBox({ prompt: 'Secret value', password: true });
      if (value === undefined) return;

      const { repoOrg: owner, name: repo } = active.config.repo;

      try {
        if (scope === 'environment') {
          const envName = await pickEnvironment(envsClient, owner, repo);
          if (!envName) return;
          await envsClient.setEnvironmentSecret(owner, repo, envName, key, value);
        } else if (scope === 'repository') {
          await envsClient.setRepoSecret(owner, repo, key, value);
        } else {
          await orgsClient.setOrgSecret(owner, key, value);
        }
        variablesProvider.refresh();
        vscode.window.showInformationMessage(`Secret "${key}" set.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to set secret: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.deleteVariable', async (item: VariableTreeItem) => {
      const v = item?.variable;
      if (!v) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete ${v.sensitive ? 'secret' : 'variable'} "${v.key}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      const active = await configManager.getActive();
      if (!active) return;

      const { repoOrg: owner, name: repo } = active.config.repo;

      try {
        if (v.scope === 'environment' && v.environment) {
          if (v.sensitive) {
            await envsClient.deleteEnvironmentSecret(owner, repo, v.environment, v.key);
          } else {
            await envsClient.deleteEnvironmentVariable(owner, repo, v.environment, v.key);
          }
        } else if (v.scope === 'repository') {
          if (v.sensitive) {
            await envsClient.deleteRepoSecret(owner, repo, v.key);
          } else {
            await envsClient.deleteRepoVariable(owner, repo, v.key);
          }
        }
        variablesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.bootstrapWorkspace', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const active = await configManager.getActive();
      const folder = active?.folder ?? folders[0];
      await WorkspaceConfigPanel.open(folder, configManager, context);
    }),

    vscode.commands.registerCommand(
      'terraform.openInGitHub',
      (item: WorkspaceTreeItem | RunTreeItem) => {
        const url = isWorkspaceItem(item) ? item.workspace.htmlUrl : item.run.htmlUrl;
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
    ),

    vscode.commands.registerCommand('terraform.configureGithubApp', async () => {
      await auth.getSession(false);
    }),

    vscode.commands.registerCommand('terraform.configureWorkspace', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const active = await configManager.getActive();
      const folder = active?.folder ?? folders[0];
      await WorkspaceConfigPanel.open(folder, configManager, context);
    }),

    vscode.commands.registerCommand('terraform.syncWorkflows', async () => {
      const active = await configManager.getActive();
      if (!active) {
        vscode.window.showWarningMessage(
          'No workspace config found. Run **Terraform: Configure Workspace** first.',
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Terraform: Syncing workflows…',
          cancellable: false,
        },
        async progress => {
          try {
            const generator = new WorkflowGenerator(envsClient);
            progress.report({ message: 'Fetching variables and secrets from GitHub…' });
            const workflows = await generator.generateAll(active.config);
            progress.report({ message: `Writing ${workflows.length} workflow files…` });
            const uris = await generator.writeToWorkspace(active.folder, workflows);
            vscode.window.showInformationMessage(
              `Synced ${uris.length} workflow(s) to .github/workflows/`,
              'Open Folder',
            ).then(choice => {
              if (choice === 'Open Folder') {
                vscode.commands.executeCommand(
                  'revealFileInOS',
                  vscode.Uri.joinPath(active.folder.uri, '.github', 'workflows'),
                );
              }
            });
          } catch (err) {
            vscode.window.showErrorMessage(`Workflow sync failed: ${String(err)}`);
          }
        },
      );
    }),
  );

  // ── Chat participant ────────────────────────────────────────────────────────

  TerraformChatParticipant.register(context, services, outputChannel);

  // ── Language model tools ────────────────────────────────────────────────────

  registerTerraformTools(context, services, outputChannel);
}

export function deactivate(): void {
  // VS Code disposes context.subscriptions automatically
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function triggerRun(
  type: 'plan' | 'apply',
  workspace: TfWorkspace,
  services: ExtensionServices,
  outputChannel: vscode.OutputChannel,
  runsProvider: RunsTreeProvider,
): Promise<void> {
  const [owner, repo] = workspace.repoSlug.split('/');
  const workflowFile = `terraform-${type}-${workspace.name}.yml`;

  outputChannel.show(true);
  outputChannel.appendLine(`\n[${type.toUpperCase()}] Starting for workspace: ${workspace.name}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Terraform ${type} — ${workspace.name}`,
      cancellable: false,
    },
    async progress => {
      try {
        progress.report({ message: 'Dispatching workflow…' });
        const before = new Date();

        await services.actionsClient.triggerWorkflow(owner, repo, workflowFile, {
          workspace: workspace.name,
          working_directory: workspace.workingDirectory ?? '.',
        });

        progress.report({ message: 'Waiting for run to start…' });
        const run = await services.actionsClient.waitForNewRun(owner, repo, workflowFile, before);

        if (run) {
          outputChannel.appendLine(`Run started: ${run.html_url}`);
          progress.report({ message: 'Run started.' });
          runsProvider.refresh();

          const openLogs = await vscode.window.showInformationMessage(
            `Terraform ${type} started for "${workspace.name}".`,
            'View Logs',
          );
          if (openLogs === 'View Logs') {
            vscode.env.openExternal(vscode.Uri.parse(run.html_url));
          }
        } else {
          outputChannel.appendLine('Run dispatched (could not retrieve run ID).');
          runsProvider.refresh();
        }
      } catch (err) {
        const message = String(err);
        outputChannel.appendLine(`Error: ${message}`);
        vscode.window.showErrorMessage(`Terraform ${type} failed: ${message}`);
      }
    },
  );
}

async function pickEnvironment(
  envsClient: GithubEnvironmentsClient,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  try {
    const envs = await envsClient.listEnvironments(owner, repo);
    if (envs.length === 0) {
      return await vscode.window.showInputBox({ prompt: 'Environment name' });
    }
    return await vscode.window.showQuickPick(
      envs.map(e => e.name),
      { placeHolder: 'Select environment' },
    );
  } catch {
    return await vscode.window.showInputBox({ prompt: 'Environment name' });
  }
}

function isWorkspaceItem(item: WorkspaceTreeItem | RunTreeItem): item is WorkspaceTreeItem {
  return 'workspace' in item;
}
