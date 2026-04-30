import * as vscode from 'vscode';
import { GithubAuthProvider } from './auth/GithubAuthProvider.js';
import { GithubActionsClient } from './github/GithubActionsClient.js';
import { GithubEnvironmentsClient } from './github/GithubEnvironmentsClient.js';
import { GithubOrgsClient } from './github/GithubOrgsClient.js';
import { GithubSearchClient } from './github/GithubSearchClient.js';
import { GithubModuleClient } from './github/GithubModuleClient.js';
import { WorkspaceConfigManager } from './config/WorkspaceConfigManager.js';
import { WorkspaceConfigValidator } from './config/WorkspaceConfigValidator.js';
import { ActionlintRunner } from './workflows/ActionlintRunner.js';
import { DriftDetector } from './workflows/DriftDetector.js';
import { HclDiagnosticsProvider } from './views/HclDiagnosticsProvider.js';
import { TerraformResourceCodeLens } from './views/TerraformResourceCodeLens.js';
import { runBackendBootstrap, runOidcTrustPolicy, runScaffoldFromTemplate } from './workflows/Scaffolders.js';
import { WorkspacesTreeProvider, WorkspaceTreeItem } from './views/WorkspacesTreeProvider.js';
import { VariablesTreeProvider, VariableTreeItem } from './views/VariablesTreeProvider.js';
import { RequiredSetupTreeProvider, RequiredSettingItem, REQUIRED_SETTINGS } from './views/RequiredSetupTreeProvider.js';
import { RunsTreeProvider, RunTreeItem } from './views/RunsTreeProvider.js';
import { WorkspaceConfigPanel } from './views/WorkspaceConfigPanel.js';
import { ModuleComposerPanel } from './views/ModuleComposerPanel.js';
import { CallNotesPanel } from './views/CallNotesPanel.js';
import { TerraformChatParticipant } from './chat/TerraformChatParticipant.js';
import { registerTerraformTools } from './tools/TerraformTools.js';
import { WorkflowGenerator } from './workflows/WorkflowGenerator.js';
import { TerraformFileCache } from './cache/TerraformFileCache.js';
import { RunHistoryStore } from './cache/RunHistoryStore.js';
import { GitRemoteParser } from './auth/GitRemoteParser.js';
import { LocalActionsScaffolder } from './workflows/LocalActionsScaffolder.js';
import { ExtensionServices } from './services.js';
import { TfWorkspace, getWorkspaces } from './types/index.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new GithubAuthProvider();
  const actionsClient = new GithubActionsClient(auth);
  const envsClient = new GithubEnvironmentsClient(auth);
  const orgsClient = new GithubOrgsClient(auth);
  const searchClient = new GithubSearchClient(auth);
  const moduleClient = new GithubModuleClient(auth);
  const configManager = new WorkspaceConfigManager(context);
  let tfCache: TerraformFileCache;
  try {
    tfCache = new TerraformFileCache(context.globalStorageUri.fsPath);
  } catch (err) {
    tfCache = TerraformFileCache.createNoop();
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Terraform Workspace: file cache unavailable (SQLite failed to load: ${msg}). All other features are unaffected.`
    );
  }

  let runHistory: RunHistoryStore;
  try {
    runHistory = new RunHistoryStore(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => runHistory.dispose() });
  } catch (err) {
    // Native SQLite module failed (ABI mismatch or missing binary).
    // Fall back to a no-op store so the rest of the extension still activates.
    runHistory = RunHistoryStore.createNoop();
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Terraform Workspace: run history unavailable (SQLite failed to load: ${msg}). All other features are unaffected.`
    );
  }

  const actionsScaffolder = new LocalActionsScaffolder(context.extensionUri);

  // Warm the cache before anything needs it; watcher keeps it current afterwards
  tfCache.initialize();
  context.subscriptions.push(tfCache);

  const services: ExtensionServices = { auth, actionsClient, envsClient, orgsClient, searchClient, moduleClient, configManager, tfCache, actionsScaffolder };

  const outputChannel = vscode.window.createOutputChannel('Terraform Workspace');
  context.subscriptions.push(outputChannel);

  // Telemetry shim — opt-in, gated on VS Code's global telemetry switch.
  const { Telemetry } = await import('./services/Telemetry.js');
  const telemetry = new Telemetry(outputChannel);
  services.telemetry = telemetry;
  telemetry.event('extension.activate', { version: context.extension?.packageJSON?.version ?? 'unknown' });

  context.subscriptions.push(configManager.startWatching());

  const configValidator = new WorkspaceConfigValidator(context.extensionUri, configManager);
  await configValidator.activate();
  context.subscriptions.push(configValidator);

  const actionlint = new ActionlintRunner();
  context.subscriptions.push(actionlint);
  services.actionlint = actionlint;

  const drift = new DriftDetector(services, outputChannel);
  context.subscriptions.push(drift);
  services.drift = drift;

  const hclDiag = new HclDiagnosticsProvider();
  context.subscriptions.push(hclDiag);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'terraform' }, new TerraformResourceCodeLens()),
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.tf' }, new TerraformResourceCodeLens()),
  );

  // Auto-regenerate workflows when the user edits .vscode/terraform-workspace.json,
  // so dispatching a workspace doesn't 404 because the YAML on the default branch
  // hasn't been re-synced.
  context.subscriptions.push(
    configManager.onDidChange(() => {
      const auto = vscode.workspace
        .getConfiguration('terraformWorkspace')
        .get<boolean>('autoSyncWorkflows', true);
      if (!auto) return;
      void runSyncWorkflows(services, { silent: true });
    }),
  );

  // ── Status bar: active folder indicator ───────────────────────────────────

  const folderStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  folderStatusBar.command = 'terraform.selectFolder';
  folderStatusBar.tooltip = 'Terraform: click to switch workspace folder';
  context.subscriptions.push(folderStatusBar);

  const lastRunStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  lastRunStatusBar.command = 'terraform.runs.focus';
  context.subscriptions.push(lastRunStatusBar);

  const refreshLastRunStatusBar = async () => {
    try {
      const active = await configManager.getActive();
      if (!active) { lastRunStatusBar.hide(); return; }
      const [owner, repo] = active.config.repo.name.split('/');
      if (!owner || !repo) { lastRunStatusBar.hide(); return; }
      const runs = await actionsClient.listRepoRuns(owner, repo, 1);
      const latest = runs[0];
      if (!latest) { lastRunStatusBar.hide(); return; }
      const icon =
        latest.status !== 'completed' ? '$(sync~spin)' :
        latest.conclusion === 'success' ? '$(check)' :
        latest.conclusion === 'neutral' ? '$(diff)' :
        latest.conclusion === 'failure' ? '$(error)' :
        '$(circle-slash)';
      lastRunStatusBar.text = `${icon} ${latest.name ?? 'run'} #${latest.run_number}`;
      lastRunStatusBar.tooltip = `${latest.status}${latest.conclusion ? ` / ${latest.conclusion}` : ''} — click to open Runs view`;
      lastRunStatusBar.show();
    } catch {
      lastRunStatusBar.hide();
    }
  };

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
  await refreshLastRunStatusBar();
  // Refresh the last-run badge every minute so the user gets passive feedback
  // without having to open the Runs view.
  const lastRunTimer = setInterval(refreshLastRunStatusBar, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(lastRunTimer) });

  // ── Call Notes status bar ───────────────────────────────────────────────
  const notesStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  notesStatusBar.command = 'terraform.callNotes.open';
  notesStatusBar.tooltip = 'Open Call Notes';
  notesStatusBar.text = '$(notebook) Call Notes';
  notesStatusBar.show();
  context.subscriptions.push(notesStatusBar);

  // ── Tree views ─────────────────────────────────────────────────────────────

  const workspacesProvider = new WorkspacesTreeProvider(envsClient, configManager);
  const variablesProvider = new VariablesTreeProvider(envsClient, orgsClient, configManager);
  const requiredSetupProvider = new RequiredSetupTreeProvider(envsClient, configManager);
  const runsProvider = new RunsTreeProvider(actionsClient, configManager, runHistory);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('terraform.workspaces', workspacesProvider),
    vscode.window.registerTreeDataProvider('terraform.variables', variablesProvider),
    vscode.window.registerTreeDataProvider('terraform.requiredSetup', requiredSetupProvider),
    vscode.window.registerTreeDataProvider('terraform.runs', runsProvider),
  );

  // Refresh views when config changes on disk
  context.subscriptions.push(
    configManager.onDidChange(() => {
      workspacesProvider.refresh();
      variablesProvider.refresh();
      requiredSetupProvider.refresh();
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
        requiredSetupProvider.refresh();
        runsProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('terraform.refreshWorkspaces', () => {
      workspacesProvider.refresh();
      variablesProvider.refresh();
      requiredSetupProvider.refresh();
      runsProvider.refresh();
    }),

    vscode.commands.registerCommand('terraform.callNotes.open', () => {
      CallNotesPanel.open(context);
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

    vscode.commands.registerCommand('terraform.reviewDeployment', async (item: RunTreeItem) => {
      const active = await configManager.getActive();
      if (!active) { vscode.window.showWarningMessage('No workspace config found.'); return; }
      const [owner, repo] = active.config.repo.name.split('/');
      const runId = item?.run?.workflowRunId;
      if (!runId) { vscode.window.showWarningMessage('Select a run from the Runs view.'); return; }

      const pending = await services.actionsClient.listPendingDeployments(owner, repo, runId);
      const approvable = pending.filter(p => p.current_user_can_approve);
      if (approvable.length === 0) {
        vscode.window.showInformationMessage('No pending deployments awaiting your review on this run.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        approvable.map(p => ({ label: p.environment.name, id: p.environment.id })),
        { canPickMany: true, placeHolder: 'Select environments to review' },
      );
      if (!picked || picked.length === 0) return;

      const action = await vscode.window.showQuickPick(
        [{ label: 'Approve', value: 'approved' as const }, { label: 'Reject', value: 'rejected' as const }],
        { placeHolder: 'Approve or reject?' },
      );
      if (!action) return;

      const comment = await vscode.window.showInputBox({ prompt: `Comment for ${action.label.toLowerCase()}` }) ?? '';

      const ok = await services.actionsClient.reviewDeployments(
        owner, repo, runId, picked.map(p => p.id), action.value, comment,
      );
      vscode.window.showInformationMessage(ok ? `Deployment ${action.value}.` : `Failed to ${action.value} deployment.`);
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
        // Show diff against existing value (if any) and confirm.
        const existing = await getExistingVariable(envsClient, scope, owner, repo, key, () => pickEnvironment(envsClient, owner, repo));
        if (existing.found) {
          const proceed = await vscode.window.showWarningMessage(
            `Overwrite ${scope} variable "${key}"?\nWas: ${existing.value}\nNew: ${value}`,
            { modal: true },
            'Overwrite',
          );
          if (proceed !== 'Overwrite') return;
        }

        if (scope === 'environment') {
          const envName = existing.envName ?? await pickEnvironment(envsClient, owner, repo);
          if (!envName) return;
          await envsClient.setEnvironmentVariable(owner, repo, envName, key, value);
        } else if (scope === 'repository') {
          await envsClient.setRepoVariable(owner, repo, key, value);
        } else {
          await orgsClient.setOrgVariable(owner, key, value);
        }
        variablesProvider.refresh();
        requiredSetupProvider.refresh();
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
        requiredSetupProvider.refresh();
        vscode.window.showInformationMessage(`Secret "${key}" set.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to set secret: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.requiredSetup.refresh', () => {
      requiredSetupProvider.refresh();
    }),

    vscode.commands.registerCommand('terraform.requiredSetup.set', async (item?: RequiredSettingItem) => {
      if (!item) return;
      const active = await configManager.getActive();
      if (!active) {
        vscode.window.showWarningMessage('No workspace config found.');
        return;
      }
      const { repoOrg: owner, name: repo } = active.config.repo;
      const { def, envName, currentValue, isSet } = item;

      const promptSuffix = envName ? ` (env: ${envName})` : ' (repository)';
      const value = await vscode.window.showInputBox({
        prompt: `${def.kind === 'secret' ? 'Secret' : 'Variable'} ${def.name}${promptSuffix} \u2014 ${def.purpose}`,
        password: def.kind === 'secret',
        value: def.kind === 'variable' && isSet ? currentValue ?? '' : '',
        ignoreFocusOut: true,
      });
      if (value === undefined) return;

      try {
        if (def.scope === 'environment') {
          if (!envName) {
            vscode.window.showWarningMessage('Environment-scoped setting requires an environment.');
            return;
          }
          if (def.kind === 'secret') {
            await envsClient.setEnvironmentSecret(owner, repo, envName, def.name, value);
          } else {
            await envsClient.setEnvironmentVariable(owner, repo, envName, def.name, value);
          }
        } else {
          if (def.kind === 'secret') {
            await envsClient.setRepoSecret(owner, repo, def.name, value);
          } else {
            await envsClient.setRepoVariable(owner, repo, def.name, value);
          }
        }
        requiredSetupProvider.refresh();
        variablesProvider.refresh();
        vscode.window.showInformationMessage(`${def.name} set${envName ? ` for ${envName}` : ''}.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to set ${def.name}: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.requiredSetup.setAll', async () => {
      const active = await configManager.getActive();
      if (!active) {
        vscode.window.showWarningMessage('No workspace config found.');
        return;
      }
      const { repoOrg: owner, name: repo } = active.config.repo;

      // Repository-scoped settings
      for (const def of REQUIRED_SETTINGS.filter(d => d.scope === 'repository')) {
        const value = await vscode.window.showInputBox({
          prompt: `[Repository] ${def.kind === 'secret' ? 'Secret' : 'Variable'} ${def.name} \u2014 ${def.purpose}${def.optional ? ' (skip with Esc)' : ''}`,
          password: def.kind === 'secret',
          ignoreFocusOut: true,
        });
        if (value === undefined) {
          if (!def.optional) {
            const cont = await vscode.window.showWarningMessage(
              `Skipped required setting ${def.name}. Continue with the rest?`,
              'Continue', 'Cancel',
            );
            if (cont !== 'Continue') return;
          }
          continue;
        }
        try {
          if (def.kind === 'secret') {
            await envsClient.setRepoSecret(owner, repo, def.name, value);
          } else {
            await envsClient.setRepoVariable(owner, repo, def.name, value);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to set ${def.name}: ${String(err)}`);
        }
      }

      // Environment-scoped settings — ask for each existing env
      try {
        const envs = active.config.useGhaEnvironments === false
          ? []
          : await envsClient.listEnvironments(owner, repo);
        for (const env of envs) {
          for (const def of REQUIRED_SETTINGS.filter(d => d.scope === 'environment')) {
            const value = await vscode.window.showInputBox({
              prompt: `[Env: ${env.name}] ${def.kind === 'secret' ? 'Secret' : 'Variable'} ${def.name} \u2014 ${def.purpose}`,
              password: def.kind === 'secret',
              ignoreFocusOut: true,
            });
            if (value === undefined) continue;
            try {
              if (def.kind === 'secret') {
                await envsClient.setEnvironmentSecret(owner, repo, env.name, def.name, value);
              } else {
                await envsClient.setEnvironmentVariable(owner, repo, env.name, def.name, value);
              }
            } catch (err) {
              vscode.window.showErrorMessage(`Failed to set ${def.name} on ${env.name}: ${String(err)}`);
            }
          }
        }
      } catch {
        // No envs available; ignore
      }

      requiredSetupProvider.refresh();
      variablesProvider.refresh();
      vscode.window.showInformationMessage('Required setup complete.');
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
        requiredSetupProvider.refresh();
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
      // No config yet? Offer auto-discovery before opening an empty form.
      const existing = await configManager.read(folder);
      if (!existing) {
        const choice = await vscode.window.showInformationMessage(
          'No Terraform workspace config found. Auto-discover defaults from this repo?',
          { modal: false },
          'Auto-discover',
          'Open Empty Form',
        );
        if (choice === 'Auto-discover') {
          await runAutoDiscovery(services, configManager, context, outputChannel);
          return;
        }
      }
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

    vscode.commands.registerCommand('terraform.discoverDefaults', async () => {
      await runAutoDiscovery(services, configManager, context, outputChannel);
    }),

    vscode.commands.registerCommand('terraform.syncWorkflows', async () => {
      await runSyncWorkflows(services, { silent: false });
    }),

    vscode.commands.registerCommand('terraform.lintWorkflows', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showWarningMessage('Open a folder to lint workflows.');
        return;
      }
      const active = await configManager.getActive();
      const folder = active?.folder ?? folders[0];
      await actionlint.run(folder);
    }),

    vscode.commands.registerCommand('terraform.checkDrift', async () => {
      const drifted = await drift.checkAll();
      if (drifted.length === 0) {
        vscode.window.showInformationMessage('No drift detected across configured environments.');
      }
    }),

    vscode.commands.registerCommand('terraform.scaffoldBackend', () => runBackendBootstrap()),
    vscode.commands.registerCommand('terraform.scaffoldOidcTrust', () => runOidcTrustPolicy(auth)),
    vscode.commands.registerCommand('terraform.scaffoldFromTemplate', () => runScaffoldFromTemplate(auth)),

    vscode.commands.registerCommand('terraform.composeModules', async () => {
      const active = await configManager.getActive();
      const folders = vscode.workspace.workspaceFolders ?? [];
      const activeFolder = active?.folder ?? folders[0];
      const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
      const defaultOrg = vsConfig.get<string>('repoOrg', '');
      ModuleComposerPanel.open(moduleClient, defaultOrg, activeFolder, context);
    }),

    vscode.commands.registerCommand('terraform.diagnoseAuth', async () => {
      const { AuthDiagnostics } = await import('./auth/AuthDiagnostics.js');
      const diag = new AuthDiagnostics(auth, configManager);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Probing GitHub auth scopes...', cancellable: true },
        async (_progress, token) => {
          const report = await diag.run(token);
          const md = AuthDiagnostics.renderReport(report);
          outputChannel.appendLine('\n' + md.replace(/\*\*/g, ''));
          outputChannel.show(true);
          if (report.summary === 'all_good') {
            vscode.window.showInformationMessage('GitHub auth: all scopes reachable. See Output for details.');
          } else {
            vscode.window.showWarningMessage('GitHub auth: some scopes unreachable. See Output for details.');
          }
        },
      );
    }),

    vscode.commands.registerCommand('terraform.resolveVariable', async () => {
      const active = await configManager.getActive();
      if (!active) { vscode.window.showWarningMessage('No workspace config found.'); return; }
      const key = await vscode.window.showInputBox({ prompt: 'Variable name to trace' });
      if (!key) return;
      const { repoOrg: owner, name: repo } = active.config.repo;
      const envName = await pickEnvironment(envsClient, owner, repo);
      const sources: string[] = [];
      try {
        const orgVars = await envsClient.listOrgVariables(owner);
        if (orgVars.find((v: { name: string }) => v.name === key)) sources.push(`org:${owner}`);
      } catch { /* scope unavailable, skip */ }
      try {
        const repoVars = await envsClient.listRepoVariables(owner, repo);
        if (repoVars.find(v => v.name === key)) sources.push(`repo:${owner}/${repo}`);
      } catch { /* scope unavailable, skip */ }
      if (envName) {
        try {
          const envVars = await envsClient.listEnvironmentVariables(owner, repo, envName);
          if (envVars.find(v => v.name === key)) sources.push(`env:${envName}`);
        } catch { /* scope unavailable, skip */ }
      }
      if (sources.length === 0) {
        vscode.window.showInformationMessage(`Variable "${key}" not found in org/repo${envName ? '/env' : ''} scopes.`);
      } else {
        const winner = sources[sources.length - 1];
        vscode.window.showInformationMessage(`"${key}" defined in: ${sources.join(' → ')}. Effective source: ${winner}.`);
      }
    }),
  );

  // ── Chat participant ────────────────────────────────────────────────────────

  TerraformChatParticipant.register(context, services, outputChannel);

  // ── Language model tools ────────────────────────────────────────────────────

  registerTerraformTools(context, services, outputChannel);

  // ── Autonomous agent (djaboxx replacement protocol) ─────────────────────────

  const { AgentMemory } = await import('./agent/AgentMemory.js');
  const { AgentTaskQueue } = await import('./agent/AgentTaskQueue.js');
  const { AgentRunner } = await import('./agent/AgentRunner.js');
  const { ProactiveAgent } = await import('./agent/ProactiveAgent.js');
  const { RepoLearner } = await import('./agent/RepoLearner.js');

  const agentMemory = new AgentMemory(context.globalStorageUri.fsPath);
  context.subscriptions.push({ dispose: () => agentMemory.close() });

  const agentCfg = vscode.workspace.getConfiguration('terraformWorkspace.agent');
  const agentOwners = agentCfg.get<string[]>('owners', []);
  const agentLabel = agentCfg.get<string>('triggerLabel', 'agent');
  const agentInterval = agentCfg.get<number>('pollIntervalMinutes', 10) * 60 * 1000;
  const agentAutonomy = agentCfg.get<'observe' | 'draft-pr' | 'merge'>('autonomyLevel', 'draft-pr');
  const agentMaxIter = agentCfg.get<number>('maxIterations', 12);

  const learnerCfg = vscode.workspace.getConfiguration('terraformWorkspace.agent.learner');
  const learnerEnabled = learnerCfg.get<boolean>('enabled', true);
  const learnerOwners = learnerCfg.get<string[]>('owners', ['HappyPathway', 'djaboxx']);
  const learnerTopic = learnerCfg.get<string>('topic', 'learning');
  const learnerReposPerTick = learnerCfg.get<number>('reposPerTick', 25);
  const learnerCommitsPerRepo = learnerCfg.get<number>('commitsPerRepo', 20);

  const repoLearner = new RepoLearner(auth, agentMemory, {
    owners: learnerOwners,
    topic: learnerTopic,
    reposPerTick: learnerReposPerTick,
    commitsPerRepo: learnerCommitsPerRepo,
  });

  const agentQueue = new AgentTaskQueue(auth, agentLabel);
  const agentRunner = new AgentRunner(agentMemory, {
    maxIterations: agentMaxIter,
    autonomyLevel: agentAutonomy,
  });
  const proactiveAgent = new ProactiveAgent(agentMemory, agentQueue, agentRunner, {
    owners: agentOwners,
    pollIntervalMs: agentInterval,
    runOnFocus: agentCfg.get<boolean>('runOnFocus', true),
    maxTasksPerTick: agentCfg.get<number>('maxTasksPerTick', 1),
    maxIterations: agentMaxIter,
    autonomyLevel: agentAutonomy,
    learner: learnerEnabled ? repoLearner : undefined,
  });
  context.subscriptions.push(proactiveAgent);

  if (agentCfg.get<boolean>('enabled', false)) {
    proactiveAgent.start();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('terraform.agent.start', () => {
      proactiveAgent.start();
      vscode.window.showInformationMessage('Terraform agent started.');
    }),
    vscode.commands.registerCommand('terraform.agent.stop', () => {
      proactiveAgent.stop();
      vscode.window.showInformationMessage('Terraform agent stopped.');
    }),
    vscode.commands.registerCommand('terraform.agent.runNow', async () => {
      await proactiveAgent.forceTick();
    }),
    vscode.commands.registerCommand('terraform.agent.showStatus', () => {
      proactiveAgent.showOutput();
    }),
    vscode.commands.registerCommand('terraform.agent.showMemory', async () => {
      const open = agentMemory.openItems();
      const failures = agentMemory.recentFailures(10);
      const lines = [
        '# Terraform Agent Memory',
        '',
        `## Open items (${open.length})`,
        ...open.map(e => `- [${e.kind}] (${new Date(e.createdAt).toISOString()}) ${e.content}`),
        '',
        `## Recent failures (${failures.length})`,
        ...failures.map(e => `- (${new Date(e.createdAt).toISOString()}) ${e.content}`),
      ];
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('terraform.agent.learnNow', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Terraform: ingesting learning repos…' },
        async () => {
          const result = await repoLearner.tick();
          vscode.window.showInformationMessage(
            `Learner scanned ${result.reposScanned} repo(s), updated ${result.reposUpdated}.` +
            (result.errors.length ? ` (${result.errors.length} error(s) — see Output)` : ''),
          );
        },
      );
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes context.subscriptions automatically
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Single-flight guard for `runSyncWorkflows`. Multiple invocations while a
 * sync is in flight are coalesced into the same promise so we don't race two
 * concurrent writes against `.github/workflows/`.
 */
let syncInFlight: Promise<void> | undefined;

/**
 * Auto-discover defaults for the active folder, show the user a summary, and
 * (with confirmation) apply them to `.vscode/terraform-workspace.json` before
 * opening the configuration panel for review.
 */
async function runAutoDiscovery(
  services: ExtensionServices,
  configManager: WorkspaceConfigManager,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return;
  }
  const folder = configManager.getActiveFolder() ?? folders[0];

  const { WorkspaceAutoDiscovery } = await import('./discovery/WorkspaceAutoDiscovery.js');
  const { buildConfigFromDiscovery, summarizeDiscovery } = await import(
    './discovery/buildConfigFromDiscovery.js'
  );

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Discovering Terraform defaults…' },
    () => new WorkspaceAutoDiscovery({ envsClient: services.envsClient }).discover(folder),
  );

  outputChannel.appendLine('--- Auto-discovery ---');
  outputChannel.appendLine(summarizeDiscovery(result).replace(/\*\*/g, ''));

  const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
  const suggested = buildConfigFromDiscovery(result, {
    compositeActionOrg: vsConfig.get<string>('compositeActionOrg', 'HappyPathway'),
    defaultStateRegion: vsConfig.get<string>('defaultStateRegion', 'us-east-1'),
    defaultRunnerGroup: vsConfig.get<string>('defaultRunnerGroup', 'self-hosted'),
  });

  const existing = await configManager.read(folder);
  const summary = [
    result.repoSlug ? `Repo: ${result.repoSlug}` : 'Repo: <not detected>',
    `Environments: ${getWorkspaces(suggested).length}`,
    `Backend: ${suggested.stateConfig?.bucket ?? 'n/a'} (${suggested.stateConfig?.region ?? 'n/a'})`,
    result.warnings.length ? `Warnings: ${result.warnings.length}` : null,
  ]
    .filter(Boolean)
    .join(' • ');

  const action = existing ? 'Merge & Open' : 'Apply & Open';
  const choice = await vscode.window.showInformationMessage(
    `Auto-discovery complete. ${summary}`,
    { modal: false },
    action,
    'Show Details',
    'Cancel',
  );

  if (choice === 'Cancel' || !choice) return;

  if (choice === 'Show Details') {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content:
        `# Terraform Workspace — Discovery Report\n\n${summarizeDiscovery(result)}\n\n` +
        `## Suggested config\n\n\`\`\`json\n${JSON.stringify(suggested, null, 2)}\n\`\`\`\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }

  // Merge: preserve user-set fields when they exist; otherwise use suggested.
  const finalConfig = (existing
    ? (mergeConfig(existing as unknown as Record<string, unknown>, suggested as unknown as Record<string, unknown>) as unknown as typeof suggested)
    : suggested);
  await configManager.write(folder, finalConfig);
  await WorkspaceConfigPanel.open(folder, configManager, context);
}

/**
 * Shallow-merge: `existing` wins for scalar fields it has set; arrays from
 * `suggested` are used when the existing array is empty.
 */
function mergeConfig(
  existing: Record<string, unknown>,
  suggested: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...suggested };
  for (const [key, value] of Object.entries(existing)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      out[key] = value.length > 0 ? value : suggested[key];
    } else if (typeof value === 'object') {
      const sugg = suggested[key];
      out[key] =
        sugg && typeof sugg === 'object' && !Array.isArray(sugg)
          ? mergeConfig(value as Record<string, unknown>, sugg as Record<string, unknown>)
          : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function runSyncWorkflows(
  services: ExtensionServices,
  opts: { silent: boolean },
): Promise<void> {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const active = await services.configManager.getActive();
    if (!active) {
      if (!opts.silent) {
        vscode.window.showWarningMessage(
          'No workspace config found. Run **Terraform: Configure Workspace** first.',
        );
      }
      return;
    }

    await vscode.window.withProgress(
      {
        location: opts.silent
          ? vscode.ProgressLocation.Window
          : vscode.ProgressLocation.Notification,
        title: 'Terraform: Syncing workflows…',
        cancellable: false,
      },
      async progress => {
        try {
          const generator = new WorkflowGenerator(
            services.envsClient,
            services.actionsScaffolder,
          );
          progress.report({ message: 'Fetching variables and secrets from GitHub…' });
          const workflows = await generator.generateAll(active.config);
          progress.report({ message: `Writing ${workflows.length} workflow files…` });
          const uris = await generator.writeToWorkspace(active.folder, workflows);
          if (!opts.silent) {
            vscode.window
              .showInformationMessage(
                `Synced ${uris.length} workflow(s) to .github/workflows/`,
                'Open Folder',
              )
              .then(choice => {
                if (choice === 'Open Folder') {
                  vscode.commands.executeCommand(
                    'revealFileInOS',
                    vscode.Uri.joinPath(active.folder.uri, '.github', 'workflows'),
                  );
                }
              });
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Workflow sync failed: ${String(err)}`);
        }
      },
    );
  })().finally(() => {
    syncInFlight = undefined;
  });

  return syncInFlight;
}

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

        // workflow_dispatch requires the workflow file to exist on the dispatched
        // ref. Only the default branch is guaranteed to have it after a sync.
        const ref = await GitRemoteParser.getDefaultBranch(
          (await services.configManager.getActive())?.folder.uri.fsPath,
        );

        await services.actionsClient.triggerWorkflow(owner, repo, workflowFile, {
          workspace: workspace.name,
          working_directory: workspace.workingDirectory ?? '.',
        }, ref);

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

/**
 * Looks up the current value of a variable across the chosen scope so the
 * user sees a before/after diff before overwriting. Secrets cannot be read
 * back from GitHub — this is variables-only.
 */
async function getExistingVariable(
  envsClient: GithubEnvironmentsClient,
  scope: string,
  owner: string,
  repo: string,
  key: string,
  pickEnv: () => Promise<string | undefined>,
): Promise<{ found: boolean; value?: string; envName?: string }> {
  try {
    if (scope === 'environment') {
      const envName = await pickEnv();
      if (!envName) return { found: false };
      const list = await envsClient.listEnvironmentVariables(owner, repo, envName);
      const hit = list.find(v => v.name === key);
      return hit ? { found: true, value: hit.value, envName } : { found: false, envName };
    } else if (scope === 'repository') {
      const list = await envsClient.listRepoVariables(owner, repo);
      const hit = list.find(v => v.name === key);
      return hit ? { found: true, value: hit.value } : { found: false };
    } else {
      const list = await envsClient.listOrgVariables(owner);
      const hit = list.find(v => v.name === key);
      return hit ? { found: true, value: hit.value } : { found: false };
    }
  } catch {
    return { found: false };
  }
}
