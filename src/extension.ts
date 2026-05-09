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
import { runBackendBootstrap, runOidcTrustPolicy, runScaffoldFromTemplate, codebuildExecutorTf, codebuildExecutorBuildspec } from './workflows/Scaffolders.js';
import { WorkspacesTreeProvider, WorkspaceTreeItem } from './views/WorkspacesTreeProvider.js';
import { VariablesTreeProvider, VariableTreeItem } from './views/VariablesTreeProvider.js';
import { RequiredSetupTreeProvider, RequiredSettingItem, requiredSettingsFor } from './views/RequiredSetupTreeProvider.js';
import { RunsTreeProvider, RunTreeItem } from './views/RunsTreeProvider.js';
import { WorkspaceConfigPanel } from './views/WorkspaceConfigPanel.js';
import { ModuleComposerPanel } from './views/ModuleComposerPanel.js';
import { CallNotesPanel } from './views/CallNotesPanel.js';
import { DriftPlanPanel } from './views/DriftPlanPanel.js';
import { TerraformChatParticipant } from './chat/TerraformChatParticipant.js';
import { DaveChatParticipant } from './chat/DaveChatParticipant.js';
import { registerTerraformTools } from './tools/TerraformTools.js';
import { registerRunnerTools } from './tools/RunnerTools.js';
import { GheRunnersClient } from './runners/GheRunnersClient.js';
import { RunnersTreeProvider, RunnerEnvironmentItem } from './views/RunnersTreeProvider.js';
import { WorkflowGenerator } from './workflows/WorkflowGenerator.js';
import { TerraformFileCache } from './cache/TerraformFileCache.js';
import { RunHistoryStore } from './cache/RunHistoryStore.js';
import { GitRemoteParser } from './auth/GitRemoteParser.js';
import { LocalActionsScaffolder } from './workflows/LocalActionsScaffolder.js';
import { ExtensionServices } from './services.js';
import { TfWorkspace, getWorkspaces } from './types/index.js';
import { Telemetry } from './services/Telemetry.js';
import { ProviderDocsCache } from './providers/ProviderDocsCache.js';

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

  const runnersClient = new GheRunnersClient(auth);

  const services: ExtensionServices = { auth, actionsClient, envsClient, orgsClient, searchClient, moduleClient, configManager, tfCache, actionsScaffolder, runnersClient };

  const outputChannel = vscode.window.createOutputChannel('Terraform Workspace');
  context.subscriptions.push(outputChannel);

  // Telemetry shim — opt-in, gated on VS Code's global telemetry switch.
  const telemetry = new Telemetry(outputChannel);
  services.telemetry = telemetry;
  telemetry.event('extension.activate', { version: context.extension?.packageJSON?.version ?? 'unknown' });

  context.subscriptions.push(configManager.startWatching());

  // Fire-and-forget — schema load reads from disk; don't block activation.
  const configValidator = new WorkspaceConfigValidator(context.extensionUri, configManager);
  configValidator.activate().catch(err =>
    outputChannel.appendLine(`[config-validator] init failed: ${err}`),
  );
  context.subscriptions.push(configValidator);

  const actionlint = new ActionlintRunner();
  context.subscriptions.push(actionlint);
  services.actionlint = actionlint;

  const drift = new DriftDetector(services, outputChannel);
  context.subscriptions.push(drift);
  services.drift = drift;

  const providerDocs = new ProviderDocsCache(context.globalStorageUri.fsPath);
  services.providerDocs = providerDocs;

  // Auto-refresh provider docs whenever a `.terraform.lock.hcl` changes.
  // Fire-and-forget; runs in the background and does nothing if already cached.
  const lockWatcher = vscode.workspace.createFileSystemWatcher('**/.terraform.lock.hcl');
  context.subscriptions.push(lockWatcher);
  const refreshDocsForLock = (uri: vscode.Uri): void => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    void providerDocs.refreshAll(folder, {
      onProgress: (msg) => outputChannel.appendLine(`[provider-docs] ${msg}`),
    }).then((res) => {
      if (res.updated.length) {
        outputChannel.appendLine(
          `[provider-docs] Updated docs for: ${res.updated.map((p) => `${p.namespace}/${p.name}@${p.version}`).join(', ')}`,
        );
      }
      for (const f of res.failed) {
        outputChannel.appendLine(`[provider-docs] Failed ${f.provider.namespace}/${f.provider.name}@${f.provider.version}: ${f.error}`);
      }
    }).catch((err) => outputChannel.appendLine(`[provider-docs] error: ${err}`));
  };
  context.subscriptions.push(lockWatcher.onDidCreate(refreshDocsForLock));
  context.subscriptions.push(lockWatcher.onDidChange(refreshDocsForLock));

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
      runSyncWorkflows(services, { silent: true }).catch(err =>
        outputChannel.appendLine(`[auto-sync-workflows] ${err}`),
      );
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

  // Fire-and-forget — don't block extension activation on GitHub network calls
  // or auth prompts. If these hang, the tree providers below would never get
  // registered and the user would see "no data provider registered" forever.
  void refreshFolderStatusBar();
  void refreshLastRunStatusBar();
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

  const runnersProvider = new RunnersTreeProvider(runnersClient);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('terraform.workspaces', workspacesProvider),
    vscode.window.registerTreeDataProvider('terraform.variables', variablesProvider),
    vscode.window.registerTreeDataProvider('terraform.requiredSetup', requiredSetupProvider),
    vscode.window.registerTreeDataProvider('terraform.runs', runsProvider),
    vscode.window.registerTreeDataProvider('terraform.runners', runnersProvider),
    runnersProvider.startAutoRefresh(),
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

    vscode.commands.registerCommand('terraform.pinTerraformVersion', async () => {
      const active = await configManager.getActive();
      const folder = active?.folder ?? vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const pinUri = vscode.Uri.joinPath(folder.uri, '.terraform-version');
      let current = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(pinUri);
        current = Buffer.from(bytes).toString('utf-8').trim();
      } catch {
        // file doesn't exist yet
      }
      const value = await vscode.window.showInputBox({
        prompt: 'Terraform / OpenTofu version to pin (written to .terraform-version, honored by tfenv, asdf, and the workflow runner)',
        value: current,
        placeHolder: 'e.g. 1.9.5',
        ignoreFocusOut: true,
        validateInput: v => v.trim() === '' ? 'Version is required' : undefined,
      });
      if (!value) return;
      try {
        await vscode.workspace.fs.writeFile(pinUri, Buffer.from(value.trim() + '\n', 'utf-8'));
        vscode.window.showInformationMessage(
          `Pinned Terraform version to ${value.trim()} in .terraform-version. Re-run "Terraform: Sync Workflows" to propagate.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to write .terraform-version: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('terraform.refreshProviderDocs', async (arg?: { force?: boolean }) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      if (!services.providerDocs) {
        vscode.window.showWarningMessage('Provider docs cache is not initialized.');
        return;
      }
      const force = arg?.force === true;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing provider docs\u2026' },
        async (progress) => {
          const res = await services.providerDocs!.refreshAll(folder, {
            force,
            onProgress: (msg) => progress.report({ message: msg }),
          });
          const parts: string[] = [];
          if (res.updated.length) parts.push(`updated ${res.updated.length}`);
          if (res.skipped.length) parts.push(`cached ${res.skipped.length}`);
          if (res.failed.length) parts.push(`failed ${res.failed.length}`);
          if (!parts.length) parts.push('no providers found in any .terraform.lock.hcl');
          vscode.window.showInformationMessage(`Provider docs: ${parts.join(', ')}.`);
          for (const f of res.failed) {
            outputChannel.appendLine(
              `[provider-docs] ${f.provider.namespace}/${f.provider.name}@${f.provider.version}: ${f.error}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand('terraform.scaffoldCodebuildExecutor', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const active = await configManager.getActive();
      const defaultRepo = active ? `${active.config.repo.repoOrg}/${active.config.repo.name}` : '';
      const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1' });
      if (!region) return;
      const repoFullName = await vscode.window.showInputBox({ prompt: 'GitHub <owner>/<repo>', value: defaultRepo });
      if (!repoFullName) return;
      const projectName = await vscode.window.showInputBox({ prompt: 'CodeBuild project name', value: `tf-executor-${(active?.config.repo.name ?? 'workspace')}` });
      if (!projectName) return;
      const sourceBucketName = await vscode.window.showInputBox({ prompt: 'S3 source/artifact bucket name (will be created)', value: `${projectName}-src` });
      if (!sourceBucketName) return;
      const tfModule = codebuildExecutorTf({ region, repoFullName, projectName, sourceBucketName });
      const buildspec = codebuildExecutorBuildspec();
      const dir = vscode.Uri.joinPath(folder.uri, 'infra', `codebuild-executor-${projectName}`);
      await vscode.workspace.fs.createDirectory(dir);
      const mainUri = vscode.Uri.joinPath(dir, 'main.tf');
      const buildspecUri = vscode.Uri.joinPath(dir, 'buildspec.yml');
      await vscode.workspace.fs.writeFile(mainUri, Buffer.from(tfModule, 'utf-8'));
      await vscode.workspace.fs.writeFile(buildspecUri, Buffer.from(buildspec, 'utf-8'));
      const doc = await vscode.workspace.openTextDocument(mainUri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `CodeBuild executor scaffolded at ${dir.fsPath}. Run \`terraform init && terraform apply\` there, then add the "executor"/"codebuild" block to .vscode/terraform-workspace.json.`,
      );
    }),

    vscode.commands.registerCommand('terraform.runPlanInCodeBuild',  () => runInCodeBuild('plan',  configManager, outputChannel)),
    vscode.commands.registerCommand('terraform.runApplyInCodeBuild', () => runInCodeBuild('apply', configManager, outputChannel)),

    vscode.commands.registerCommand('terraform.scaffoldLambdaImage', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const functionName = await vscode.window.showInputBox({
        prompt: 'Lambda function name (used for the dir, ECR repo, and Lambda name)',
        validateInput: (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : 'Use 1-64 chars: letters, digits, _ or -',
      });
      if (!functionName) return;
      const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1' });
      if (!region) return;
      const packerCodebuildProject = await vscode.window.showInputBox({
        prompt: 'Existing packer-pipeline CodeBuild project name',
        value: 'packer-pipeline',
      });
      if (!packerCodebuildProject) return;
      const packerSourceBucket = await vscode.window.showInputBox({
        prompt: 'S3 bucket the packer-pipeline project reads sources from',
        value: `${packerCodebuildProject}-src`,
      });
      if (!packerSourceBucket) return;
      const baseImage = await vscode.window.showInputBox({
        prompt: 'Lambda base image (Enter for python:3.12)',
        value: 'public.ecr.aws/lambda/python:3.12',
      });
      if (baseImage === undefined) return;

      const m = await import('./lambda/LambdaImageScaffolder.js');
      const inputs = { functionName, region, packerCodebuildProject, packerSourceBucket, baseImage };
      const dir = vscode.Uri.joinPath(folder.uri, 'infra', `lambda-image-${functionName}`);
      const srcDir = vscode.Uri.joinPath(dir, 'src');
      await vscode.workspace.fs.createDirectory(srcDir);
      const writes: Array<[vscode.Uri, string]> = [
        [vscode.Uri.joinPath(dir, 'packer.pkr.hcl'), m.lambdaImagePackerHcl(inputs)],
        [vscode.Uri.joinPath(dir, 'build.hcl'), m.lambdaImageBuildHcl(inputs)],
        [vscode.Uri.joinPath(dir, 'ecr.tf'), m.lambdaImageEcrTf(inputs)],
        [vscode.Uri.joinPath(dir, 'lambda.tf'), m.lambdaImageLambdaTf(inputs)],
      ];
      for (const [uri, content] of writes) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      }
      const handlerUri = vscode.Uri.joinPath(srcDir, 'handler.py');
      try { await vscode.workspace.fs.stat(handlerUri); }
      catch { await vscode.workspace.fs.writeFile(handlerUri, Buffer.from(m.lambdaHandlerSkeleton(inputs), 'utf-8')); }
      const reqUri = vscode.Uri.joinPath(srcDir, 'requirements.txt');
      try { await vscode.workspace.fs.stat(reqUri); }
      catch { await vscode.workspace.fs.writeFile(reqUri, Buffer.from(m.lambdaImageRequirementsTxt(), 'utf-8')); }

      const handler = await vscode.workspace.openTextDocument(handlerUri);
      await vscode.window.showTextDocument(handler);
      vscode.window.showInformationMessage(
        `Lambda image scaffolded at ${dir.fsPath}. Edit src/handler.py, then run "Terraform: Build & Publish Lambda Image" once the ECR repo exists.`,
      );
    }),

    vscode.commands.registerCommand('terraform.buildLambdaImage', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }

      // Discover existing infra/lambda-image-* dirs and offer them.
      let dirChoice: string | undefined;
      try {
        const infra = vscode.Uri.joinPath(folder.uri, 'infra');
        const entries = await vscode.workspace.fs.readDirectory(infra);
        const candidates = entries
          .filter(([n, t]) => t === vscode.FileType.Directory && n.startsWith('lambda-image-'))
          .map(([n]) => `infra/${n}`);
        if (candidates.length === 1) {
          dirChoice = candidates[0];
        } else if (candidates.length > 1) {
          dirChoice = await vscode.window.showQuickPick(candidates, { placeHolder: 'Lambda image directory' });
          if (!dirChoice) return;
        }
      } catch { /* no infra dir; fall through to manual entry */ }

      const directory = dirChoice ?? await vscode.window.showInputBox({
        prompt: 'Workspace-relative path to the lambda image dir',
        value: 'infra/lambda-image-',
      });
      if (!directory) return;

      const inferredName = directory.split('/').pop()?.replace(/^lambda-image-/, '') ?? '';
      const functionName = await vscode.window.showInputBox({
        prompt: 'Function name (also the ECR repo name)',
        value: inferredName,
        validateInput: (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : 'Use 1-64 chars: letters, digits, _ or -',
      });
      if (!functionName) return;
      const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1' });
      if (!region) return;
      const packerCodebuildProject = await vscode.window.showInputBox({
        prompt: 'packer-pipeline CodeBuild project name',
        value: 'packer-pipeline',
      });
      if (!packerCodebuildProject) return;
      const packerSourceBucket = await vscode.window.showInputBox({
        prompt: 'packer-pipeline source S3 bucket',
        value: `${packerCodebuildProject}-src`,
      });
      if (!packerSourceBucket) return;

      const { LambdaImageDispatcher } = await import('./lambda/LambdaImageDispatcher.js');
      const dispatcher = new LambdaImageDispatcher(outputChannel);
      const dirUri = vscode.Uri.joinPath(folder.uri, directory);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building Lambda image: ${functionName}`, cancellable: true },
        async (_progress, token) => {
          try {
            const res = await dispatcher.buildAndPublish({
              region,
              packerCodebuildProject,
              sourceBucket: packerSourceBucket,
              ecrRepoName: functionName,
              imageTag: `build-${Date.now()}`,
              workingDirectory: dirUri,
              functionName,
            }, token);
            if (res.status === 'SUCCEEDED' && res.imageDigest) {
              vscode.window.showInformationMessage(
                `Image published: ${res.imageDigest}. Run \`terraform apply\` in ${directory} to deploy.`,
              );
            } else {
              vscode.window.showErrorMessage(`Lambda image build ended: ${res.status}. See output channel.`);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Lambda image build failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('terraform.scaffoldServiceCatalogProduct', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const productSlug = await vscode.window.showInputBox({
        prompt: 'Product slug (lowercase, hyphens OK — used for resource names and S3 bucket)',
        validateInput: (v) => /^[a-z0-9-]{1,60}$/.test(v) ? null : 'Lowercase letters, digits, and hyphens only',
      });
      if (!productSlug) return;
      const portfolioName = await vscode.window.showInputBox({ prompt: 'Portfolio name (shown in SC console)' });
      if (!portfolioName) return;
      const owner = await vscode.window.showInputBox({ prompt: 'Owner / team (shown in SC console)' });
      if (!owner) return;
      const templateKey = await vscode.window.showInputBox({
        prompt: 'S3 key for the CFN template (e.g. 2-0-0.yaml)',
        value: '1-0-0.yaml',
      });
      if (!templateKey) return;
      const lambdaArn = await vscode.window.showInputBox({
        prompt: 'Lambda ARN the product invokes (leave blank to skip InvokeFunction policy)',
      });
      const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-gov-west-1' });
      if (!region) return;

      const { scProductTf } = await import('./servicecatalog/SCProductScaffolder.js');
      const dir = vscode.Uri.joinPath(folder.uri, 'infra', `sc-product-${productSlug}`);
      await vscode.workspace.fs.createDirectory(dir);
      const tfPath = vscode.Uri.joinPath(dir, 'product.tf');
      await vscode.workspace.fs.writeFile(
        tfPath,
        Buffer.from(scProductTf({
          productSlug, portfolioName, owner, templateKey, region,
          lambdaArn: lambdaArn || undefined,
        }), 'utf-8'),
      );
      const doc = await vscode.workspace.openTextDocument(tfPath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `Service Catalog product scaffolded at ${dir.fsPath}.\n` +
        `Copy your product-template.yaml there, then \`terraform init && terraform apply\`.`,
      );
    }),

    vscode.commands.registerCommand('terraform.bumpServiceCatalogArtifact', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }

      // Discover existing infra/sc-product-* dirs.
      let dirChoice: string | undefined;
      try {
        const infra = vscode.Uri.joinPath(folder.uri, 'infra');
        const entries = await vscode.workspace.fs.readDirectory(infra);
        const candidates = entries
          .filter(([n, t]) => t === vscode.FileType.Directory && n.startsWith('sc-product-'))
          .map(([n]) => `infra/${n}`);
        if (candidates.length === 1) {
          dirChoice = candidates[0];
        } else if (candidates.length > 1) {
          dirChoice = await vscode.window.showQuickPick(candidates, { placeHolder: 'SC product directory' });
          if (!dirChoice) return;
        }
      } catch { /* no infra dir */ }

      const directory = dirChoice ?? await vscode.window.showInputBox({
        prompt: 'Workspace-relative SC product dir (containing product.tf)',
        value: 'infra/sc-product-',
      });
      if (!directory) return;

      const productResourceName = await vscode.window.showInputBox({
        prompt: 'Terraform resource name of the existing product',
        value: 'this',
        validateInput: (v) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v) ? null : 'Must be a valid HCL identifier',
      });
      if (!productResourceName) return;
      const newVersion = await vscode.window.showInputBox({
        prompt: 'New version (semver: MAJOR.MINOR.PATCH)',
        validateInput: (v) => /^\d+\.\d+\.\d+$/.test(v) ? null : 'Must be MAJOR.MINOR.PATCH',
      });
      if (!newVersion) return;
      const templateBucket = await vscode.window.showInputBox({ prompt: 'S3 template bucket' });
      if (!templateBucket) return;
      const templateKey = await vscode.window.showInputBox({ prompt: 'S3 key for the new template artifact' });
      if (!templateKey) return;
      const description = await vscode.window.showInputBox({ prompt: 'Optional description', value: `Bumped to ${newVersion}` });

      const { scArtifactBumpTf } = await import('./servicecatalog/SCProductScaffolder.js');
      const dir = vscode.Uri.joinPath(folder.uri, directory);
      const out = vscode.Uri.joinPath(dir, `artifact-v${newVersion.replace(/\./g, '_')}.tf`);
      try {
        await vscode.workspace.fs.stat(out);
        vscode.window.showWarningMessage(`Refusing to overwrite existing ${out.fsPath}.`);
        return;
      } catch { /* not present, proceed */ }
      await vscode.workspace.fs.writeFile(
        out,
        Buffer.from(scArtifactBumpTf({ productResourceName, newVersion, templateBucket, templateKey, description }), 'utf-8'),
      );
      const doc = await vscode.workspace.openTextDocument(out);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Wrote ${out.fsPath}. Run \`terraform plan\` to preview, then \`apply\`.`);
    }),

    vscode.commands.registerCommand('terraform.dryRenderServiceCatalogProduct', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }

      const schemaUri = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectMany: false,
        filters: { 'JSON Schema': ['json'] },
        openLabel: 'Select JSON schema describing the SC form',
      });
      if (!schemaUri || schemaUri.length === 0) return;
      const sampleUri = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectMany: false,
        filters: { 'Sample inputs JSON': ['json'] },
        openLabel: 'Select sample inputs JSON to validate',
      });
      if (!sampleUri || sampleUri.length === 0) return;

      let schema: Record<string, unknown>;
      let sample: Record<string, unknown>;
      try {
        schema = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(schemaUri[0])).toString('utf-8'));
        sample = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(sampleUri[0])).toString('utf-8'));
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to parse JSON: ${(err as Error).message}`);
        return;
      }

      const { scDryRender } = await import('./servicecatalog/SCProductScaffolder.js');
      const result = scDryRender(schema as never, sample);
      outputChannel.show(true);
      outputChannel.appendLine('─── SC Form Dry-Render ───');
      outputChannel.appendLine(`Schema: ${schemaUri[0].fsPath}`);
      outputChannel.appendLine(`Sample: ${sampleUri[0].fsPath}`);
      if (result.ok) {
        outputChannel.appendLine('✓ Sample inputs are valid against the schema.');
        vscode.window.showInformationMessage('Sample inputs are valid against the schema.');
      } else {
        outputChannel.appendLine('✗ Validation failed.');
        if (result.missing.length) outputChannel.appendLine(`  Missing required: ${result.missing.join(', ')}`);
        for (const inv of result.invalid) outputChannel.appendLine(`  ${inv.field}: ${inv.reason}`);
        vscode.window.showErrorMessage(
          `Form validation failed (${result.missing.length + result.invalid.length} issue(s)). See output.`,
        );
      }
    }),

    vscode.commands.registerCommand('terraform.scaffoldPythonDevEnv', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }

      let dirChoice: string | undefined;
      try {
        const infra = vscode.Uri.joinPath(folder.uri, 'infra');
        const entries = await vscode.workspace.fs.readDirectory(infra);
        const candidates = entries
          .filter(([n, t]) => t === vscode.FileType.Directory && n.startsWith('lambda-image-'))
          .map(([n]) => `infra/${n}`);
        if (candidates.length === 1) {
          dirChoice = candidates[0];
        } else if (candidates.length > 1) {
          dirChoice = await vscode.window.showQuickPick(candidates, { placeHolder: 'Lambda image directory' });
          if (!dirChoice) return;
        }
      } catch { /* no infra dir */ }

      const directory = dirChoice ?? await vscode.window.showInputBox({
        prompt: 'Workspace-relative path to the lambda image dir',
        value: 'infra/lambda-image-',
      });
      if (!directory) return;

      const inferredName = directory.split('/').pop()?.replace(/^lambda-image-/, '') ?? '';
      const functionName = await vscode.window.showInputBox({
        prompt: 'Function name',
        value: inferredName,
        validateInput: (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : 'Use 1-64 chars: letters, digits, _ or -',
      });
      if (!functionName) return;

      // Try to detect python version from the existing packer.pkr.hcl base image.
      let detectedPy = '3.12';
      try {
        const packerHcl = vscode.Uri.joinPath(folder.uri, directory, 'packer.pkr.hcl');
        const text = Buffer.from(await vscode.workspace.fs.readFile(packerHcl)).toString('utf-8');
        const { detectPythonVersionFromBaseImage } = await import('./lambda/PythonDevScaffolder.js');
        const m = text.match(/image\s*=\s*"([^"]+)"/);
        if (m) detectedPy = detectPythonVersionFromBaseImage(m[1]);
      } catch { /* no packer.pkr.hcl yet */ }

      const pythonVersion = await vscode.window.showInputBox({
        prompt: 'Python version (must match the Lambda base image)',
        value: detectedPy,
        validateInput: (v) => /^3\.\d+$/.test(v) ? null : 'Must look like 3.12',
      });
      if (!pythonVersion) return;
      const handler = await vscode.window.showInputBox({
        prompt: 'Handler dotted path',
        value: 'handler.lambda_handler',
        validateInput: (v) => /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(v)
          ? null : 'Must be dotted, e.g. handler.lambda_handler',
      });
      if (!handler) return;
      const region = await vscode.window.showInputBox({
        prompt: 'AWS region (optional, baked into devcontainer env)',
        value: 'us-east-1',
      });

      const m = await import('./lambda/PythonDevScaffolder.js');
      const inputs = { functionName, pythonVersion, handler, region: region || undefined };
      const dir = vscode.Uri.joinPath(folder.uri, directory);
      const writes: Array<[vscode.Uri, string]> = [
        [vscode.Uri.joinPath(dir, 'pyproject.toml'), m.pythonPyprojectToml(inputs)],
        [vscode.Uri.joinPath(dir, '.python-version'), m.pythonVersionFile(inputs)],
        [vscode.Uri.joinPath(dir, 'Makefile'), m.pythonMakefile(inputs)],
        [vscode.Uri.joinPath(dir, '.devcontainer', 'devcontainer.json'), m.pythonDevcontainer(inputs)],
        [vscode.Uri.joinPath(dir, '.vscode', 'launch.json'), m.pythonLaunchJson(inputs)],
        [vscode.Uri.joinPath(dir, 'tests', 'conftest.py'), m.pythonConftest()],
        [vscode.Uri.joinPath(dir, 'tests', 'test_handler.py'), m.pythonTestHandler(inputs)],
        [vscode.Uri.joinPath(dir, 'tests', 'events', 'sample.json'), m.pythonSampleEvent()],
        [vscode.Uri.joinPath(dir, 'scripts', 'local_invoke.py'), m.pythonLocalInvokeScript()],
      ];
      const skipped: string[] = [];
      const written: string[] = [];
      for (const [uri, content] of writes) {
        try {
          await vscode.workspace.fs.stat(uri);
          skipped.push(vscode.workspace.asRelativePath(uri));
          continue;
        } catch { /* not present */ }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        written.push(vscode.workspace.asRelativePath(uri));
      }

      const pyproj = vscode.Uri.joinPath(dir, 'pyproject.toml');
      const doc = await vscode.workspace.openTextDocument(pyproj);
      await vscode.window.showTextDocument(doc);
      const summary = `Python dev env scaffolded (${written.length} written, ${skipped.length} skipped). Run \`make install && make test\` in ${directory}.`;
      vscode.window.showInformationMessage(summary);
    }),

    vscode.commands.registerCommand('terraform.invokeLambdaLocally', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }

      let dirChoice: string | undefined;
      try {
        const infra = vscode.Uri.joinPath(folder.uri, 'infra');
        const entries = await vscode.workspace.fs.readDirectory(infra);
        const candidates = entries
          .filter(([n, t]) => t === vscode.FileType.Directory && n.startsWith('lambda-image-'))
          .map(([n]) => `infra/${n}`);
        if (candidates.length === 1) {
          dirChoice = candidates[0];
        } else if (candidates.length > 1) {
          dirChoice = await vscode.window.showQuickPick(candidates, { placeHolder: 'Lambda image directory' });
          if (!dirChoice) return;
        }
      } catch { /* no infra dir */ }

      const directory = dirChoice ?? await vscode.window.showInputBox({
        prompt: 'Workspace-relative path to the lambda image dir',
        value: 'infra/lambda-image-',
      });
      if (!directory) return;
      const inferredName = directory.split('/').pop()?.replace(/^lambda-image-/, '') ?? 'local';

      // Offer events/*.json files via QuickPick.
      let eventPath: string | undefined;
      const eventsDir = vscode.Uri.joinPath(folder.uri, directory, 'tests', 'events');
      try {
        const entries = await vscode.workspace.fs.readDirectory(eventsDir);
        const jsons = entries
          .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json'))
          .map(([n]) => `${directory}/tests/events/${n}`);
        if (jsons.length > 0) {
          jsons.push('Browse\u2026');
          const pick = await vscode.window.showQuickPick(jsons, { placeHolder: 'Event JSON' });
          if (!pick) return;
          if (pick !== 'Browse\u2026') eventPath = pick;
        }
      } catch { /* no events dir */ }
      if (!eventPath) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectMany: false,
          filters: { 'Event JSON': ['json'] },
          openLabel: 'Select event JSON',
        });
        if (!picked || picked.length === 0) return;
        eventPath = picked[0].fsPath;
      }

      const handler = await vscode.window.showInputBox({
        prompt: 'Handler dotted path',
        value: 'handler.lambda_handler',
        validateInput: (v) => /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(v)
          ? null : 'Must be dotted, e.g. handler.lambda_handler',
      });
      if (!handler) return;

      const { LambdaLocalInvoker } = await import('./lambda/LambdaLocalInvoker.js');
      const invoker = new LambdaLocalInvoker(outputChannel);
      const dir = vscode.Uri.joinPath(folder.uri, directory);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Invoking ${inferredName}\u2026`, cancellable: true },
        async (_p, token) => {
          try {
            const res = await invoker.invoke({
              workingDirectory: dir,
              handler,
              eventPath: eventPath!,
              functionName: inferredName,
            }, token);
            if (res.exitCode === 0) {
              vscode.window.showInformationMessage(`Local invoke succeeded (exit 0). See output.`);
            } else {
              vscode.window.showErrorMessage(`Local invoke exited ${res.exitCode}. See output.`);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Local invoke failed: ${(err as Error).message}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('terraform.tailLambdaLogs', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      let suggestedFn = '';
      if (folder) {
        try {
          const infra = vscode.Uri.joinPath(folder.uri, 'infra');
          const entries = await vscode.workspace.fs.readDirectory(infra);
          const fns = entries
            .filter(([n, t]) => t === vscode.FileType.Directory && n.startsWith('lambda-image-'))
            .map(([n]) => n.replace(/^lambda-image-/, ''));
          if (fns.length === 1) {
            suggestedFn = fns[0];
          } else if (fns.length > 1) {
            const pick = await vscode.window.showQuickPick([...fns, 'Other\u2026'], { placeHolder: 'Function to tail' });
            if (!pick) return;
            if (pick !== 'Other\u2026') suggestedFn = pick;
          }
        } catch { /* no infra dir */ }
      }

      const functionName = suggestedFn || await vscode.window.showInputBox({
        prompt: 'Lambda function name',
        validateInput: (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : 'Use 1-64 chars: letters, digits, _ or -',
      });
      if (!functionName) return;
      const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1' });
      if (!region) return;
      const sinceStr = await vscode.window.showInputBox({
        prompt: 'Look back this many minutes',
        value: '5',
        validateInput: (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1440 ? null : '1-1440 minutes',
      });
      if (!sinceStr) return;

      const { LambdaLogTailer } = await import('./lambda/LambdaLogTailer.js');
      const tailer = new LambdaLogTailer(outputChannel);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Tailing /aws/lambda/${functionName}`, cancellable: true },
        async (_p, token) => {
          try {
            await tailer.tail({
              region,
              functionName,
              sinceMinutes: Number(sinceStr),
            }, token);
          } catch (err) {
            vscode.window.showErrorMessage(`Tail failed: ${(err as Error).message}`);
          }
        },
      );
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
      const settings = requiredSettingsFor(active.config.awsAuthMode ?? 'oidc');

      // Repository-scoped settings
      for (const def of settings.filter(d => d.scope === 'repository')) {
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
          for (const def of settings.filter(d => d.scope === 'environment')) {
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
      await WorkspaceConfigPanel.open(folder, configManager, context, envsClient, orgsClient);
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
      await WorkspaceConfigPanel.open(folder, configManager, context, envsClient, orgsClient);
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
      const results = await drift.checkAll();
      if (results.length === 0) {
        vscode.window.showInformationMessage('No drift detected across configured environments.');
      } else {
        DriftPlanPanel.show(results, context);
      }
    }),

    vscode.commands.registerCommand('terraform.showDriftDiff', (results) => {
      DriftPlanPanel.show(results as Parameters<typeof DriftPlanPanel.show>[0], context);
    }),

    vscode.commands.registerCommand('terraform.openWalkthrough', () => {
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'HappyPathway.terraform-workspace#terraform-workspace.getStarted');
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

  // ── Runner management commands ─────────────────────────────────────────────

  context.subscriptions.push(

    vscode.commands.registerCommand('terraform.runners.refresh', () => {
      runnersProvider.refresh();
    }),

    vscode.commands.registerCommand('terraform.runners.refreshEnvironment', (item?: RunnerEnvironmentItem) => {
      if (item) {
        runnersProvider.refreshEnvironment(item.environment.ecsCluster);
      } else {
        runnersProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('terraform.runners.forceTokenRefresh', async (item?: RunnerEnvironmentItem) => {
      const envs = item ? [item.environment] : runnersProvider.getEnvironments();
      if (envs.length === 0) {
        vscode.window.showWarningMessage('No runner environments found.');
        return;
      }

      let env = envs[0];
      if (!item && envs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          envs.map(e => ({ label: e.name, description: e.ecsCluster, env: e })),
          { placeHolder: 'Select runner environment' },
        );
        if (!pick) return;
        env = pick.env;
      }

      if (!env.lambdaFunctionName) {
        vscode.window.showWarningMessage(
          `Token refresh Lambda is not enabled for "${env.name}". ` +
          `Set enable_lambda_token_refresh = true in default.auto.tfvars and re-apply.`,
        );
        return;
      }

      outputChannel.show(true);
      outputChannel.appendLine(`▶ Invoking Lambda token refresh for ${env.name}…`);
      try {
        const payload = await runnersClient.forceTokenRefresh(env);
        outputChannel.appendLine(`✓ Done. Payload: ${payload}`);
        vscode.window.showInformationMessage(`✅ Token refresh complete for "${env.name}".`);
        runnersProvider.refreshEnvironment(env.ecsCluster);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`✗ Error: ${msg}`);
        vscode.window.showErrorMessage(`Token refresh failed: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('terraform.runners.forceRedeploy', async (item?: RunnerEnvironmentItem) => {
      const envs = item ? [item.environment] : runnersProvider.getEnvironments();
      if (envs.length === 0) {
        vscode.window.showWarningMessage('No runner environments found.');
        return;
      }

      let env = envs[0];
      if (!item && envs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          envs.map(e => ({ label: e.name, description: e.ecsCluster, env: e })),
          { placeHolder: 'Select runner environment' },
        );
        if (!pick) return;
        env = pick.env;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Force-redeploy all runner tasks in "${env.name}"? ` +
        `This will restart all ECS tasks and briefly interrupt running jobs.`,
        { modal: true },
        'Redeploy',
      );
      if (confirm !== 'Redeploy') return;

      outputChannel.show(true);
      outputChannel.appendLine(`▶ Force-redeploying ${env.name} (${env.ecsCluster} / ${env.ecsService})…`);
      try {
        await runnersClient.forceRedeploy(env);
        outputChannel.appendLine('✓ Force-new-deployment triggered.');
        vscode.window.showInformationMessage(`✅ Redeployment triggered for "${env.name}".`);
        runnersProvider.refreshEnvironment(env.ecsCluster);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`✗ Error: ${msg}`);
        vscode.window.showErrorMessage(`Force redeploy failed: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('terraform.runners.scale', async (item?: RunnerEnvironmentItem) => {
      const envs = item ? [item.environment] : runnersProvider.getEnvironments();
      if (envs.length === 0) {
        vscode.window.showWarningMessage('No runner environments found.');
        return;
      }

      let env = envs[0];
      if (!item && envs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          envs.map(e => ({ label: e.name, description: e.ecsCluster, env: e })),
          { placeHolder: 'Select runner environment' },
        );
        if (!pick) return;
        env = pick.env;
      }

      const countStr = await vscode.window.showInputBox({
        title: `Scale runners for "${env.name}"`,
        prompt: `Enter desired runner count (current: ${env.desiredCount})`,
        value: String(env.desiredCount),
        validateInput: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > 20) return 'Enter a number between 0 and 20';
          return null;
        },
      });
      if (countStr === undefined) return;

      const newCount = Number(countStr);
      outputChannel.show(true);
      outputChannel.appendLine(`▶ Scaling "${env.name}" to ${newCount} runner(s)…`);
      try {
        await runnersClient.scaleRunners(env, newCount);
        outputChannel.appendLine(`✓ Desired count set to ${newCount}.`);
        vscode.window.showInformationMessage(
          newCount === 0
            ? `⚠️ Runners for "${env.name}" scaled to zero. Workflows are paused.`
            : `✅ Runners for "${env.name}" scaled to ${newCount}.`,
        );
        runnersProvider.refreshEnvironment(env.ecsCluster);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`✗ Error: ${msg}`);
        vscode.window.showErrorMessage(`Scale failed: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('terraform.runners.viewLogs', async (item?: RunnerEnvironmentItem) => {
      const envs = item ? [item.environment] : runnersProvider.getEnvironments();
      if (envs.length === 0) {
        vscode.window.showWarningMessage('No runner environments found.');
        return;
      }

      let env = envs[0];
      if (!item && envs.length > 1) {
        const pick = await vscode.window.showQuickPick(
          envs.map(e => ({ label: e.name, description: e.ecsCluster, env: e })),
          { placeHolder: 'Select runner environment' },
        );
        if (!pick) return;
        env = pick.env;
      }

      const groups = await runnersClient.listLogGroups(env);
      if (groups.length === 0) {
        vscode.window.showWarningMessage(`No log groups found in ${env.awsRegion} matching /ecs-ghe-runners*.`);
        return;
      }

      let logGroup = groups[0];
      if (groups.length > 1) {
        const pick = await vscode.window.showQuickPick(groups, { placeHolder: 'Select log group' });
        if (!pick) return;
        logGroup = pick;
      }

      const filterPick = await vscode.window.showQuickPick(
        [
          { label: 'All logs', pattern: undefined },
          { label: 'Errors only', pattern: 'error' },
          { label: 'Job events', pattern: 'Job' },
          { label: 'Registration', pattern: 'Registering' },
          { label: 'Custom filter…', pattern: '__custom__' },
        ],
        { placeHolder: 'Filter log output' },
      );
      if (!filterPick) return;

      let filterPattern: string | undefined;
      if (filterPick.pattern === '__custom__') {
        filterPattern = await vscode.window.showInputBox({ prompt: 'Enter CloudWatch filter pattern' }) ?? undefined;
      } else {
        filterPattern = filterPick.pattern;
      }

      const logsChannel = vscode.window.createOutputChannel(`Runners: ${env.name}`);
      context.subscriptions.push(logsChannel);
      logsChannel.show(true);

      const cts = new vscode.CancellationTokenSource();
      context.subscriptions.push(cts);

      void runnersClient.tailLogs(env, logGroup, logsChannel, filterPattern, 30, cts.token);
    }),

  );

  // ── Chat participant ────────────────────────────────────────────────────────

  TerraformChatParticipant.register(context, services, outputChannel);
  DaveChatParticipant.register(context, services, outputChannel);

  // ── Language model tools ────────────────────────────────────────────────────

  registerTerraformTools(context, services, outputChannel);
  registerRunnerTools(context, services, outputChannel);

  // ── Autonomous agent (djaboxx replacement protocol) ─────────────────────────

  const { AgentMemory } = await import('./agent/AgentMemory.js');
  const { AgentTaskQueue } = await import('./agent/AgentTaskQueue.js');
  const { AgentRunner } = await import('./agent/AgentRunner.js');
  const { ProactiveAgent } = await import('./agent/ProactiveAgent.js');
  const { RepoLearner } = await import('./agent/RepoLearner.js');

  const agentMemory = new AgentMemory(context.globalStorageUri.fsPath);
  context.subscriptions.push({ dispose: () => agentMemory.close() });
  // Attach to the shared services object so chat participants and LM tools
  // (registered above before agentMemory existed) can read it lazily.
  services.agentMemory = agentMemory;

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

  // Proactive digest surface — runs independently of the issue-queue
  // ProactiveAgent (which is opt-in). Whether or not the user has enabled
  // autonomous task running, Dave can still pop up to say "hey, you've
  // got 3 open todos and a recent failure — want to look?" Lazy-loaded
  // so activation stays fast.
  const { DigestWatcher } = await import('./agent/DigestWatcher.js');
  const digestEnabled = vscode.workspace
    .getConfiguration('terraformWorkspace')
    .get<boolean>('dave.proactiveDigest', true);
  const digestWatcher = new DigestWatcher(agentMemory, context);
  context.subscriptions.push(digestWatcher);
  if (digestEnabled) {
    digestWatcher.start();
  }

  // Failure auto-capture: when RunHistoryStore observes a workflow run
  // transition to a failed conclusion, drop a memory entry under the
  // repo's topic. DigestWatcher then surfaces it. Dedup by run ID so
  // re-poll of the same failure doesn't re-fire.
  runHistory.setFailureObserver(run => {
    const reason = run.conclusion === 'timed_out' ? 'timed out' : 'failed';
    const summary = `${run.type} run ${reason} on ${run.repoSlug} — ${run.htmlUrl}`;
    agentMemory.recordOnce(
      `repo:${run.repoSlug}`,
      'failure',
      summary,
      `tfrun:${run.id}`,
      {
        source: 'tf-run',
        runId: run.id,
        type: run.type,
        conclusion: run.conclusion,
        url: run.htmlUrl,
        sha: run.commitSha,
      },
    );
  });

  // Inbox watcher — polls GitHub for PRs awaiting your review and files
  // them as todos under the `inbox` topic. Surfaces via DigestWatcher.
  // If auth isn't ready, the first tick simply fails into a memory note;
  // subsequent ticks recover automatically once the user signs in.
  const inboxEnabled = vscode.workspace
    .getConfiguration('terraformWorkspace')
    .get<boolean>('dave.inboxWatcher', true);
  if (inboxEnabled) {
    const { InboxWatcher } = await import('./agent/InboxWatcher.js');
    const inboxWatcher = new InboxWatcher(agentMemory, auth);
    context.subscriptions.push(inboxWatcher);
    inboxWatcher.start();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('terraform.dave.showDigest', async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: '@dave /digest',
        });
      } catch {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', '@dave /digest');
        } catch {
          vscode.window.showWarningMessage('Could not open Copilot Chat. Open it manually and type `@dave /digest`.');
        }
      }
    }),
    vscode.commands.registerCommand('terraform.dave.checkDigestNow', async () => {
      await digestWatcher.forceCheck();
    }),
  );

  // Dave status bar + inbox QuickPick. Lazy-loaded so a failure here can't
  // block activation. The status bar reflects open todos / unresolved
  // failures from AgentMemory and tints warning-yellow when high-priority
  // items exist (mirroring the IRON STATIC homework scheduler pattern).
  const { DaveStatusBar, showInboxQuickPick } = await import('./agent/DaveStatusBar.js');
  const daveStatusBar = new DaveStatusBar(agentMemory);
  context.subscriptions.push(daveStatusBar);
  context.subscriptions.push(
    vscode.commands.registerCommand('terraform.dave.showInbox', async () => {
      await showInboxQuickPick(agentMemory, () => daveStatusBar.refresh());
    }),
    vscode.commands.registerCommand('terraform.dave.seedMemory', async () => {
      const { seedAgentMemory } = await import('./agent/seedContent.js');
      const report = seedAgentMemory(agentMemory);
      daveStatusBar.refresh();
      const total = report.decisionsAdded + report.playbooksAdded + report.factsAdded;
      const skipped = report.decisionsSkipped + report.playbooksSkipped + report.factsSkipped;
      vscode.window.showInformationMessage(
        `Dave's memory seeded: ${total} new entries (${report.decisionsAdded} decisions, ` +
        `${report.playbooksAdded} playbooks, ${report.factsAdded} facts). ` +
        `${skipped} already present.`,
      );
    }),
  );

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
 * Dispatches a Terraform plan/apply into the configured CodeBuild executor —
 * same shape as the generated GHA workflow, but invoked locally from VS Code
 * using the user's already-exported AWS env (e.g. via `awscreds`).
 */
async function runInCodeBuild(
  command: 'plan' | 'apply',
  configManager: WorkspaceConfigManager,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const active = await configManager.getActive();
  if (!active) { vscode.window.showWarningMessage('No workspace config found.'); return; }
  const cb = active.config.codebuild;
  if (!cb) {
    const pick = await vscode.window.showWarningMessage(
      'No "codebuild" block in .vscode/terraform-workspace.json. Scaffold an executor first?',
      'Scaffold Executor', 'Cancel',
    );
    if (pick === 'Scaffold Executor') vscode.commands.executeCommand('terraform.scaffoldCodebuildExecutor');
    return;
  }
  const envs = getWorkspaces(active.config);
  const envName = envs.length === 1
    ? envs[0].name
    : await vscode.window.showQuickPick(envs.map((e) => e.name), { title: `CodeBuild ${command}: workspace` });
  if (!envName) return;
  const region = cb.region ?? active.config.stateConfig?.region ?? 'us-east-1';
  if (command === 'apply') {
    const ok = await vscode.window.showWarningMessage(
      `Run \`terraform apply\` for "${envName}" in CodeBuild project "${cb.project}"? This will modify infrastructure.`,
      { modal: true }, 'Apply',
    );
    if (ok !== 'Apply') return;
  }
  const { CodeBuildDispatcher } = await import('./codebuild/CodeBuildDispatcher.js');
  const dispatcher = new CodeBuildDispatcher(outputChannel);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `CodeBuild ${command}: ${envName}`, cancellable: true },
    async (_progress, token) => {
      try {
        const res = await dispatcher.dispatch({
          region, project: cb.project, sourceBucket: cb.sourceBucket, artifactBucket: cb.artifactBucket,
          workspace: envName, command, workingDirectory: active.folder.uri,
        }, token);
        if (res.status === 'SUCCEEDED') {
          vscode.window.showInformationMessage(`CodeBuild ${command} succeeded for "${envName}". Artifacts: ${res.artifactsDir.fsPath}`);
        } else {
          vscode.window.showErrorMessage(`CodeBuild ${command} ended with status ${res.status} for "${envName}".`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`CodeBuild ${command} failed: ${(err as Error).message}`);
      }
    },
  );
}

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
  await WorkspaceConfigPanel.open(folder, configManager, context, services.envsClient, services.orgsClient);
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
