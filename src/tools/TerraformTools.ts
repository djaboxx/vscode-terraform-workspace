import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { VariableScope } from '../types/index.js';

export function registerTerraformTools(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
  outputChannel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('terraform_run_plan', new RunPlanTool(services, outputChannel)),
    vscode.lm.registerTool('terraform_run_apply', new RunApplyTool(services, outputChannel)),
    vscode.lm.registerTool('terraform_get_state', new GetStateTool(services)),
    vscode.lm.registerTool('terraform_list_workspaces', new ListWorkspacesTool(services)),
    vscode.lm.registerTool('terraform_list_variables', new ListVariablesTool(services)),
    vscode.lm.registerTool('terraform_set_variable', new SetVariableTool(services)),
    vscode.lm.registerTool('terraform_generate_code', new GenerateCodeTool(services)),
    vscode.lm.registerTool('terraform_bootstrap_workspace', new BootstrapWorkspaceTool(services, context)),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getRepoContext(services: ExtensionServices): Promise<{ owner: string; repo: string } | undefined> {
  const active = await services.configManager.getActive();
  if (!active) return undefined;
  const { repoOrg: owner, name: repo } = active.config.repo;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

// ─── terraform_run_plan ───────────────────────────────────────────────────────

interface RunPlanInput {
  workspace?: string;
  workingDirectory?: string;
}

class RunPlanTool implements vscode.LanguageModelTool<RunPlanInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunPlanInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found. Configure a workspace first.');
    }

    const { owner, repo } = ctx;
    const active = await this.services.configManager.getActive();
    const workspace =
      options.input.workspace ?? active?.config.environments[0]?.name;

    if (!workspace) {
      return textResult('No workspace specified and no environments configured.');
    }

    const workingDirectory = options.input.workingDirectory ?? '.';

    try {
      const before = new Date();
      await this.services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        { workspace, working_directory: workingDirectory },
      );

      const run = await this.services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        before,
      );

      if (run) {
        this.outputChannel.appendLine(`[tool:plan] Run ${run.id}: ${run.html_url}`);
        return textResult(
          `Plan triggered for workspace "${workspace}". Run URL: ${run.html_url}`,
        );
      }
      return textResult(`Plan triggered for workspace "${workspace}". Check GitHub Actions for status.`);
    } catch (err) {
      return textResult(`Error triggering plan: ${String(err)}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunPlanInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const ws = options.input.workspace ?? 'current workspace';
    return {
      invocationMessage: `Triggering Terraform plan for **${ws}**`,
      confirmationMessages: {
        title: 'Run Terraform Plan',
        message: new vscode.MarkdownString(`Trigger a Terraform **plan** for workspace \`${ws}\`?`),
      },
    };
  }
}

// ─── terraform_run_apply ──────────────────────────────────────────────────────

interface RunApplyInput {
  workspace: string;
  workingDirectory?: string;
}

class RunApplyTool implements vscode.LanguageModelTool<RunApplyInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunApplyInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;
    const workspace = options.input.workspace;
    const workingDirectory = options.input.workingDirectory ?? '.';

    try {
      const before = new Date();
      await this.services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        { workspace, working_directory: workingDirectory },
      );

      const run = await this.services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        before,
      );

      if (run) {
        this.outputChannel.appendLine(`[tool:apply] Run ${run.id}: ${run.html_url}`);
        return textResult(`Apply triggered for workspace "${workspace}". Run URL: ${run.html_url}`);
      }
      return textResult(`Apply triggered for workspace "${workspace}".`);
    } catch (err) {
      return textResult(`Error triggering apply: ${String(err)}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunApplyInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Triggering Terraform apply for **${options.input.workspace}**`,
      confirmationMessages: {
        title: 'Run Terraform Apply',
        message: new vscode.MarkdownString(
          `⚠️ This will trigger a Terraform **apply** for workspace \`${options.input.workspace}\`. Continue?`,
        ),
      },
    };
  }
}

// ─── terraform_get_state ──────────────────────────────────────────────────────

interface GetStateInput {
  workspace?: string;
}

class GetStateTool implements vscode.LanguageModelTool<GetStateInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetStateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const active = await this.services.configManager.getActive();
    const workspace = options.input.workspace ?? active?.config.environments[0]?.name;

    if (!workspace) {
      return textResult('No workspace specified.');
    }

    const { owner, repo } = ctx;

    try {
      // Get the most recent successful apply run and link to it
      const runs = await this.services.actionsClient.getWorkflowRuns(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        5,
      );

      const lastSuccess = runs.find(
        r => r.conclusion === 'success' && r.status === 'completed',
      );

      if (!lastSuccess) {
        return textResult(
          `No successful apply runs found for workspace "${workspace}". Run a plan and apply first.`,
        );
      }

      return textResult(
        `Last successful apply for "${workspace}":\n` +
          `- Run ID: ${lastSuccess.id}\n` +
          `- Commit: ${lastSuccess.head_sha.slice(0, 8)}\n` +
          `- URL: ${lastSuccess.html_url}\n\n` +
          `Terraform state is managed in the S3 backend. ` +
          `Use \`terraform state list\` locally with the correct backend config to inspect resources.`,
      );
    } catch (err) {
      return textResult(`Error fetching state info: ${String(err)}`);
    }
  }
}

// ─── terraform_list_workspaces ────────────────────────────────────────────────

class ListWorkspacesTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;

    try {
      const envs = await this.services.envsClient.listEnvironments(owner, repo);
      if (envs.length === 0) {
        return textResult(`No GitHub Environments found for ${owner}/${repo}.`);
      }

      const list = envs
        .map(e => `- ${e.name} (${e.html_url})`)
        .join('\n');

      return textResult(`Workspaces for ${owner}/${repo}:\n${list}`);
    } catch (err) {
      return textResult(`Error listing workspaces: ${String(err)}`);
    }
  }
}

// ─── terraform_list_variables ─────────────────────────────────────────────────

interface ListVariablesInput {
  workspace?: string;
  scope?: VariableScope;
}

class ListVariablesTool implements vscode.LanguageModelTool<ListVariablesInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListVariablesInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;
    const scope = options.input.scope ?? 'environment';
    const active = await this.services.configManager.getActive();
    const workspace = options.input.workspace ?? active?.config.environments[0]?.name;

    try {
      let lines: string[] = [];

      if (scope === 'environment' && workspace) {
        const [secrets, variables] = await Promise.all([
          this.services.envsClient.listEnvironmentSecrets(owner, repo, workspace),
          this.services.envsClient.listEnvironmentVariables(owner, repo, workspace),
        ]);
        lines = [
          ...secrets.map(s => `- ${s.name} (secret, env: ${workspace})`),
          ...variables.map(v => `- ${v.name} = ${v.value} (variable, env: ${workspace})`),
        ];
      } else if (scope === 'repository') {
        const [secrets, variables] = await Promise.all([
          this.services.envsClient.listRepoSecrets(owner, repo),
          this.services.envsClient.listRepoVariables(owner, repo),
        ]);
        lines = [
          ...secrets.map(s => `- ${s.name} (secret, repo)`),
          ...variables.map(v => `- ${v.name} = ${v.value} (variable, repo)`),
        ];
      } else if (scope === 'organization') {
        const varSet = await this.services.orgsClient.getOrgVariableSet(owner);
        lines = varSet.variables.map(
          v => `- ${v.key}${v.sensitive ? ' (secret)' : ` = ${v.value ?? ''}`} (org)`,
        );
      }

      if (lines.length === 0) {
        return textResult('No variables or secrets found for the specified scope.');
      }

      return textResult(`Variables/secrets:\n${lines.join('\n')}`);
    } catch (err) {
      return textResult(`Error listing variables: ${String(err)}`);
    }
  }
}

// ─── terraform_set_variable ───────────────────────────────────────────────────

interface SetVariableInput {
  key: string;
  value: string;
  sensitive: boolean;
  workspace?: string;
  scope?: VariableScope;
  category?: 'terraform' | 'env';
}

class SetVariableTool implements vscode.LanguageModelTool<SetVariableInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SetVariableInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;
    const { key, value, sensitive, scope = 'environment', workspace } = options.input;

    try {
      if (scope === 'environment' && workspace) {
        if (sensitive) {
          await this.services.envsClient.setEnvironmentSecret(owner, repo, workspace, key, value);
        } else {
          await this.services.envsClient.setEnvironmentVariable(owner, repo, workspace, key, value);
        }
      } else if (scope === 'repository') {
        if (sensitive) {
          await this.services.envsClient.setRepoSecret(owner, repo, key, value);
        } else {
          await this.services.envsClient.setRepoVariable(owner, repo, key, value);
        }
      } else if (scope === 'organization') {
        if (sensitive) {
          await this.services.orgsClient.setOrgSecret(owner, key, value);
        } else {
          await this.services.orgsClient.setOrgVariable(owner, key, value);
        }
      } else {
        return textResult('Invalid scope or missing workspace name for environment scope.');
      }

      return textResult(
        `${sensitive ? 'Secret' : 'Variable'} "${key}" set in scope "${scope}"${workspace ? ` / environment "${workspace}"` : ''}.`,
      );
    } catch (err) {
      return textResult(`Error setting variable: ${String(err)}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SetVariableInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const { key, sensitive } = options.input;
    return {
      invocationMessage: `Setting ${sensitive ? 'secret' : 'variable'} **${key}**`,
      confirmationMessages: sensitive
        ? {
            title: 'Set Secret',
            message: new vscode.MarkdownString(
              `Store \`${key}\` as an encrypted GitHub Secret?`,
            ),
          }
        : undefined,
    };
  }
}

// ─── terraform_generate_code ──────────────────────────────────────────────────

interface GenerateCodeInput {
  description: string;
  targetFile?: string;
  useModules?: boolean;
}

class GenerateCodeTool implements vscode.LanguageModelTool<GenerateCodeInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GenerateCodeInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { description, targetFile, useModules = true } = options.input;

    const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
    const model = models[0];

    if (!model) {
      return textResult('No language model available to generate code.');
    }

    const active = await this.services.configManager.getActive();
    let context =
      'You are a Terraform expert. Generate idiomatic HCL based on the description.\n' +
      'Output ONLY the HCL code, no explanation. Use valid Terraform syntax.\n';

    if (useModules) {
      context += 'Prefer HappyPathway registry modules (registry.terraform.io/HappyPathway/) when applicable.\n';
    }

    if (active) {
      context += `Repository: ${active.config.repo.repoOrg}/${active.config.repo.name}\n`;
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(context),
      vscode.LanguageModelChatMessage.User(
        `Generate Terraform HCL for: ${description}${targetFile ? `\nTarget file: ${targetFile}` : ''}`,
      ),
    ];

    try {
      const response = await model.sendRequest(messages, {}, token);
      let code = '';
      for await (const chunk of response.text) {
        code += chunk;
      }
      return textResult(code);
    } catch (err) {
      return textResult(`Error generating code: ${String(err)}`);
    }
  }
}

// ─── terraform_bootstrap_workspace ───────────────────────────────────────────

interface BootstrapWorkspaceInput {
  repoName: string;
  repoOrg: string;
  environments: Array<{
    name: string;
    branch?: string;
    enforceReviewers?: boolean;
    reviewerTeams?: string[];
    cacheBucket?: string;
  }>;
  stateBucket?: string;
  stateRegion?: string;
}

class BootstrapWorkspaceTool implements vscode.LanguageModelTool<BootstrapWorkspaceInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly context: vscode.ExtensionContext,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BootstrapWorkspaceInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { repoName, repoOrg, environments, stateBucket, stateRegion } = options.input;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return textResult('No workspace folder open.');
    }

    const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
    const compositeOrg = vsConfig.get<string>('compositeActionOrg', 'HappyPathway');
    const defaultRegion = vsConfig.get<string>('defaultStateRegion', 'us-east-1');

    try {
      const config = await this.services.configManager.createDefault(
        folders[0],
        `${repoOrg}/${repoName}`,
        compositeOrg,
      );

      // Merge in provided environments
      config.repo.name = repoName;
      config.repo.repoOrg = repoOrg;

      if (stateRegion ?? defaultRegion) {
        config.stateConfig = {
          ...config.stateConfig,
          bucket: stateBucket ?? `inf-tfstate-${stateRegion ?? defaultRegion}`,
          region: stateRegion ?? defaultRegion,
        };
      }

      config.environments = environments.map(e => ({
        name: e.name,
        cacheBucket: e.cacheBucket ?? `terraform-cache-${e.name}`,
        runnerGroup: 'self-hosted',
        reviewers: e.enforceReviewers
          ? { teams: e.reviewerTeams ?? [], enforceReviewers: true }
          : undefined,
        deploymentBranchPolicy: e.branch
          ? { branch: e.branch, protectedBranches: true }
          : undefined,
      }));

      await this.services.configManager.write(folders[0], config);

      return textResult(
        `Workspace bootstrapped for ${repoOrg}/${repoName}.\n` +
          `Created .vscode/terraform-workspace.json with ${environments.length} environment(s): ` +
          environments.map(e => e.name).join(', ') +
          `.\n\nOpen the Terraform Workspace panel to review and refine the configuration.`,
      );
    } catch (err) {
      return textResult(`Error bootstrapping workspace: ${String(err)}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BootstrapWorkspaceInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Bootstrapping workspace for **${options.input.repoOrg}/${options.input.repoName}**`,
      confirmationMessages: {
        title: 'Bootstrap Terraform Workspace',
        message: new vscode.MarkdownString(
          `Create \`.vscode/terraform-workspace.json\` for \`${options.input.repoOrg}/${options.input.repoName}\` ` +
            `with ${options.input.environments.length} environment(s)?`,
        ),
      },
    };
  }
}
