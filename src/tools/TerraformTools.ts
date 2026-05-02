import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { VariableScope, getWorkspaces } from '../types/index.js';
import { WorkflowGenerator } from '../workflows/WorkflowGenerator.js';
import { GitRemoteParser } from '../auth/GitRemoteParser.js';
import { backendBootstrapTf, defaultOidcProvider, oidcTrustPolicy } from '../workflows/Scaffolders.js';
import { writeModuleRepoFiles } from '../workflows/ModuleRepoScaffolder.js';
import {
  RunApplyInputSchema,
  SetVariableInputSchema,
  GenerateCodeInputSchema,
  BootstrapWorkspaceInputSchema,
  SearchTfCodeInputSchema,
  DiscoverWorkspaceInputSchema,
  DiscoverWorkspaceInput,
  DeleteVariableInputSchema,
  DeleteVariableInput,
  ResolveVariableInputSchema,
  ResolveVariableInput,
  ReviewDeploymentInputSchema,
  ReviewDeploymentInput,
  LintWorkflowsInputSchema,
  LintWorkflowsInput,
  CheckDriftInputSchema,
  CheckDriftInput,
  ScaffoldBackendInputSchema,
  ScaffoldBackendInput,
  ScaffoldOidcTrustInputSchema,
  ScaffoldOidcTrustInput,
  ScaffoldFromTemplateInputSchema,
  ScaffoldFromTemplateInput,
  ScaffoldModuleRepoInputSchema,
  ScaffoldModuleRepoInput,
  LookupProviderDocInputSchema,
  LookupProviderDocInput,
  ScaffoldCodebuildExecutorInputSchema,
  ScaffoldCodebuildExecutorInput,
  DispatchCodebuildRunInputSchema,
  DispatchCodebuildRunInput,
  ScaffoldLambdaImageInputSchema,
  ScaffoldLambdaImageInput,
  BuildLambdaImageInputSchema,
  BuildLambdaImageInput,
  ScaffoldScProductInputSchema,
  ScaffoldScProductInput,
  BumpScArtifactInputSchema,
  BumpScArtifactInput,
  DryRenderScProductInputSchema,
  DryRenderScProductInput,
  ScaffoldPythonDevEnvInputSchema,
  ScaffoldPythonDevEnvInput,
  InvokeLambdaLocallyInputSchema,
  InvokeLambdaLocallyInput,
  TailLambdaLogsInputSchema,
  TailLambdaLogsInput,
  SelfIntrospectInputSchema,
  SelfIntrospectInput,
  RememberInputSchema,
  RememberInput,
  RecallInputSchema,
  RecallInput,
  MatchPlaybookInputSchema,
  MatchPlaybookInput,
  RecallDecisionsInputSchema,
  RecallDecisionsInput,
} from '../schemas/toolInputs.js';
import { CompiledSchema, formatSchemaErrors } from '../schemas/defineSchema.js';
import { WorkspaceAutoDiscovery } from '../discovery/WorkspaceAutoDiscovery.js';
import { buildConfigFromDiscovery, summarizeDiscovery } from '../discovery/buildConfigFromDiscovery.js';

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
    vscode.lm.registerTool('terraform_read_config', new ReadConfigTool(services)),
    vscode.lm.registerTool('terraform_update_config', new UpdateConfigTool(services)),
    vscode.lm.registerTool('terraform_sync_workflows', new SyncWorkflowsTool(services)),
    vscode.lm.registerTool('terraform_get_run_status', new GetRunStatusTool(services)),
    vscode.lm.registerTool('terraform_search_tf_code', new SearchTfCodeTool(services)),
    vscode.lm.registerTool('terraform_discover_workspace', new DiscoverWorkspaceTool(services)),
    vscode.lm.registerTool('terraform_delete_variable', new DeleteVariableTool(services)),
    vscode.lm.registerTool('terraform_resolve_variable', new ResolveVariableTool(services)),
    vscode.lm.registerTool('terraform_review_deployment', new ReviewDeploymentTool(services)),
    vscode.lm.registerTool('terraform_lint_workflows', new LintWorkflowsTool(services)),
    vscode.lm.registerTool('terraform_check_drift', new CheckDriftTool(services)),
    vscode.lm.registerTool('terraform_scaffold_backend', new ScaffoldBackendTool()),
    vscode.lm.registerTool('terraform_scaffold_oidc_trust', new ScaffoldOidcTrustTool(services)),
    vscode.lm.registerTool('terraform_scaffold_from_template', new ScaffoldFromTemplateTool(services)),
    vscode.lm.registerTool('terraform_scaffold_module_repo', new ScaffoldModuleRepoTool(services)),
    vscode.lm.registerTool('terraform_lookup_provider_doc', new LookupProviderDocTool(services)),
    vscode.lm.registerTool('terraform_scaffold_codebuild_executor', new ScaffoldCodebuildExecutorTool()),
    vscode.lm.registerTool('terraform_dispatch_codebuild_run', new DispatchCodebuildRunTool(services, outputChannel)),
    vscode.lm.registerTool('terraform_scaffold_lambda_image', new ScaffoldLambdaImageTool()),
    vscode.lm.registerTool('terraform_build_lambda_image', new BuildLambdaImageTool(outputChannel)),
    vscode.lm.registerTool('terraform_scaffold_sc_product', new ScaffoldScProductTool()),
    vscode.lm.registerTool('terraform_bump_sc_artifact', new BumpScArtifactTool()),
    vscode.lm.registerTool('terraform_dry_render_sc_product', new DryRenderScProductTool()),
    vscode.lm.registerTool('terraform_scaffold_python_dev_env', new ScaffoldPythonDevEnvTool()),
    vscode.lm.registerTool('terraform_invoke_lambda_locally', new InvokeLambdaLocallyTool(outputChannel)),
    vscode.lm.registerTool('terraform_tail_lambda_logs', new TailLambdaLogsTool(outputChannel)),
    vscode.lm.registerTool('terraform_self_introspect', new SelfIntrospectTool(services)),
    vscode.lm.registerTool('terraform_remember', new RememberTool(services)),
    vscode.lm.registerTool('terraform_recall', new RecallTool(services)),
    vscode.lm.registerTool('terraform_match_playbook', new MatchPlaybookTool(services)),
    vscode.lm.registerTool('terraform_recall_decisions', new RecallDecisionsTool(services)),
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

/**
 * Hard cap on text returned to the language model so a runaway state file or
 * search result never blows the context window. Conservatively chosen — most
 * model context windows are ~128k tokens (~512KB), but a single tool result
 * shouldn't dominate. Truncated results get a clear marker so the model
 * knows it's seeing partial data and can ask for a narrower query.
 */
const TOOL_RESULT_CHAR_CAP = 60_000;

function cappedTextResult(text: string, label = 'result'): vscode.LanguageModelToolResult {
  if (text.length <= TOOL_RESULT_CHAR_CAP) return textResult(text);
  const head = text.slice(0, TOOL_RESULT_CHAR_CAP);
  const elided = text.length - TOOL_RESULT_CHAR_CAP;
  return textResult(
    `${head}\n\n...\n\n[truncated ${elided.toLocaleString()} characters from ${label}; ` +
    `narrow your query or paginate to see the rest]`,
  );
}

function cancelledResult(): vscode.LanguageModelToolResult {
  return textResult('Tool invocation was cancelled before completion.');
}

/**
 * Validate a tool input against its schema. On failure, returns a
 * `LanguageModelToolResult` with a field-pointed error message that the LM
 * can read and self-correct from. On success, returns the typed input.
 */
function validateToolInput<T>(
  schema: CompiledSchema<T>,
  input: unknown,
  toolName: string,
): { ok: true; value: T } | { ok: false; result: vscode.LanguageModelToolResult } {
  const r = schema.validate(input);
  if (r.ok) return { ok: true, value: r.value };
  return {
    ok: false,
    result: textResult(
      `Invalid input for \`${toolName}\`:\n${formatSchemaErrors(r.errors)}`,
    ),
  };
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
      options.input.workspace ?? getWorkspaces(active!.config)[0]?.name;

    if (!workspace) {
      return textResult('No workspace specified and no environments configured.');
    }

    const workingDirectory = options.input.workingDirectory ?? '.';

    try {
      const before = new Date();
      const ref = await GitRemoteParser.getDefaultBranch(active?.folder.uri.fsPath);
      await this.services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        { workspace, working_directory: workingDirectory },
        ref,
      );

      const run = await this.services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        before,
        30000,
        _token,
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
    const v = validateToolInput(RunApplyInputSchema, options.input, 'terraform_run_apply');
    if (!v.ok) return v.result;

    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;
    const workspace = v.value.workspace;
    const workingDirectory = v.value.workingDirectory ?? '.';

    try {
      const before = new Date();
      const active = await this.services.configManager.getActive();
      const ref = await GitRemoteParser.getDefaultBranch(active?.folder.uri.fsPath);
      await this.services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        { workspace, working_directory: workingDirectory },
        ref,
      );

      const run = await this.services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        before,
        30000,
        _token,
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
    const workspace = options.input.workspace ?? (active ? getWorkspaces(active.config)[0]?.name : undefined);

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
    const workspace = options.input.workspace ?? (active ? getWorkspaces(active.config)[0]?.name : undefined);

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
    const v = validateToolInput(SetVariableInputSchema, options.input, 'terraform_set_variable');
    if (!v.ok) return v.result;

    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const { owner, repo } = ctx;
    const { key, value, sensitive, scope = 'environment', workspace } = v.value;

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

      // NEVER echo the value back to the LM. For secrets we don't even
      // confirm what was stored beyond the key+scope.
      const where = `${scope}${workspace ? ` / environment "${workspace}"` : ''}`;
      if (sensitive) {
        return textResult(
          `Secret "${key}" stored in scope "${where}". Value was redacted from this response.\n\n` +
          `> Reminder: secrets pasted into chat have already passed through the language model. ` +
          `For high-sensitivity values prefer the **Terraform: Add Secret** command instead.`,
        );
      }
      return textResult(`Variable "${key}" set in scope "${where}".`);
    } catch (err) {
      // Avoid leaking the value through error messages from upstream HTTP libs.
      const safe = String(err).replaceAll(value, '«REDACTED»');
      return textResult(`Error setting variable: ${safe}`);
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
              `Store \`${key}\` as an encrypted GitHub Secret?\n\n` +
              `⚠️ **The secret value has already been sent to the language model** as part of this tool call. ` +
              `For maximum-sensitivity values, cancel and use the **Terraform: Add Secret** command, which ` +
              `prompts via VS Code's input box and never exposes the value to the model.`,
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
    const v = validateToolInput(GenerateCodeInputSchema, options.input, 'terraform_generate_code');
    if (!v.ok) return v.result;
    const { description, targetFile, useModules = true } = v.value;

    const aiModel = vscode.workspace.getConfiguration('terraformWorkspace').get<string>('aiModel', 'gpt-4o');
    const models = await vscode.lm.selectChatModels({ family: aiModel });
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
    const v = validateToolInput(BootstrapWorkspaceInputSchema, options.input, 'terraform_bootstrap_workspace');
    if (!v.ok) return v.result;
    const { repoName, repoOrg, environments, stateBucket, stateRegion } = v.value as BootstrapWorkspaceInput;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return textResult('No workspace folder open.');
    }

    // Prefer the user's pinned folder selection over the first one in the list
    const targetFolder = this.services.configManager.getActiveFolder() ?? folders[0];

    const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
    const compositeOrg = vsConfig.get<string>('compositeActionOrg', 'HappyPathway');
    const defaultRegion = vsConfig.get<string>('defaultStateRegion', 'us-east-1');

    try {
      const config = await this.services.configManager.createDefault(
        targetFolder,
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

      await this.services.configManager.write(targetFolder, config);

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

// ─── terraform_read_config ────────────────────────────────────────────────────

class ReadConfigTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const active = await this.services.configManager.getActive();
    if (!active) {
      return textResult('No workspace config found. Run bootstrap or open the config panel first.');
    }
    return textResult(JSON.stringify(active.config, null, 2));
  }
}

// ─── terraform_update_config ──────────────────────────────────────────────────

interface UpdateConfigInput {
  stateConfig?: {
    bucket?: string;
    region?: string;
    keyPrefix?: string;
    dynamodbTable?: string;
    setBackend?: boolean;
  };
  compositeActions?: {
    checkout?: string;
    awsAuth?: string;
    ghAuth?: string;
    setupTerraform?: string;
    terraformInit?: string;
    terraformPlan?: string;
    terraformApply?: string;
    s3Cleanup?: string;
  };
  compositeActionOrg?: string;
  repo?: {
    name?: string;
    repoOrg?: string;
    description?: string;
    isPrivate?: boolean;
    enforcePrs?: boolean;
    createCodeowners?: boolean;
    codeownersTeam?: string;
    adminTeams?: string[];
    repoTopics?: string[];
  };
}

class UpdateConfigTool implements vscode.LanguageModelTool<UpdateConfigInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<UpdateConfigInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const active = await this.services.configManager.getActive();
    if (!active) {
      return textResult('No workspace config found.');
    }

    const { folder, config } = active;
    const patch = options.input;

    if (patch.stateConfig) {
      config.stateConfig = { ...config.stateConfig, ...patch.stateConfig };
    }
    if (patch.compositeActions) {
      config.compositeActions = { ...config.compositeActions, ...patch.compositeActions };
    }
    if (patch.compositeActionOrg !== undefined) {
      config.compositeActionOrg = patch.compositeActionOrg;
    }
    if (patch.repo) {
      config.repo = { ...config.repo, ...patch.repo };
    }

    await this.services.configManager.write(folder, config);
    return textResult(
      `Config updated for ${config.repo.repoOrg}/${config.repo.name}.\n` +
      `Updated fields: ${Object.keys(patch).join(', ')}\n\n` +
      `Run terraform_sync_workflows to regenerate workflow files if needed.`,
    );
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<UpdateConfigInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const fields = Object.keys(options.input).join(', ');
    return {
      invocationMessage: `Updating workspace config (${fields})`,
      confirmationMessages: {
        title: 'Update Terraform Workspace Config',
        message: new vscode.MarkdownString(
          `Write changes to \`.vscode/terraform-workspace.json\`?\nFields: \`${fields}\``,
        ),
      },
    };
  }
}

// ─── terraform_sync_workflows ─────────────────────────────────────────────────

class SyncWorkflowsTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const active = await this.services.configManager.getActive();
    if (!active) {
      return textResult('No workspace config found.');
    }

    try {
      const generator = new WorkflowGenerator(this.services.envsClient, this.services.actionsScaffolder);
      const workflows = await generator.generateAll(active.config);
      const uris = await generator.writeToWorkspace(active.folder, workflows);
      const filenames = uris.map(u => vscode.workspace.asRelativePath(u)).join(', ');
      return textResult(`Generated ${workflows.length} workflow file(s): ${filenames}`);
    } catch (err) {
      return textResult(`Error generating workflows: ${String(err)}`);
    }
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: 'Generating GitHub Actions workflow files from workspace config',
      confirmationMessages: {
        title: 'Sync Terraform Workflows',
        message: new vscode.MarkdownString(
          'Overwrite `.github/workflows/terraform-*.yml` files from the current workspace config?',
        ),
      },
    };
  }
}

// ─── terraform_get_run_status ─────────────────────────────────────────────────

interface GetRunStatusInput {
  workspace?: string;
  limit?: number;
}

class GetRunStatusTool implements vscode.LanguageModelTool<GetRunStatusInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetRunStatusInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const ctx = await getRepoContext(this.services);
    if (!ctx) {
      return textResult('No workspace config found.');
    }

    const active = await this.services.configManager.getActive();
    const limit = options.input.limit ?? 3;
    const workspaces = options.input.workspace
      ? [options.input.workspace]
      : (active ? getWorkspaces(active.config).map(e => e.name) : []);

    if (workspaces.length === 0) {
      return textResult('No workspaces configured.');
    }

    const { owner, repo } = ctx;
    const lines: string[] = [];

    for (const ws of workspaces) {
      const [planRuns, applyRuns] = await Promise.all([
        this.services.actionsClient.getWorkflowRuns(owner, repo, `terraform-plan-${ws}.yml`, limit).catch(() => []),
        this.services.actionsClient.getWorkflowRuns(owner, repo, `terraform-apply-${ws}.yml`, limit).catch(() => []),
      ]);

      lines.push(`## ${ws}`);
      if (planRuns.length === 0 && applyRuns.length === 0) {
        lines.push('  No runs found.');
        continue;
      }
      for (const run of planRuns) {
        lines.push(`  [plan]  #${run.id} ${run.status}/${run.conclusion ?? 'pending'} — ${run.html_url}`);
      }
      for (const run of applyRuns) {
        lines.push(`  [apply] #${run.id} ${run.status}/${run.conclusion ?? 'pending'} — ${run.html_url}`);
      }
    }

    return textResult(lines.join('\n'));
  }
}

// ─── terraform_search_tf_code ─────────────────────────────────────────────────

interface SearchTfCodeInput {
  query: string;
  limit?: number;
}

class SearchTfCodeTool implements vscode.LanguageModelTool<SearchTfCodeInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchTfCodeInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(SearchTfCodeInputSchema, options.input, 'terraform_search_tf_code');
    if (!v.ok) return v.result;

    const active = await this.services.configManager.getActive();
    if (token.isCancellationRequested) return cancelledResult();
    const org = active?.config.repo.repoOrg;

    const { query, limit = 10 } = v.value;
    const lines: string[] = [];

    // ── 1. Local workspace search (SQLite FTS5) ───────────────────────────────
    const localHits = this.services.tfCache.search(query);
    if (localHits.length > 0) {
      lines.push(`## Local workspace matches (${localHits.length})\n`);
      for (const hit of localHits) {
        lines.push(`### ${hit.rel_path}`);
        lines.push(`\`\`\`hcl\n${hit.snippet}\n\`\`\``);
        lines.push('');
      }
    }
    if (token.isCancellationRequested) return cancelledResult();

    // ── 2. GitHub org-wide search ─────────────────────────────────────────────
    if (!org) {
      if (lines.length === 0) {
        return textResult('No workspace config found — cannot determine org to search, and no local .tf files cached.');
      }
      return cappedTextResult(lines.join('\n'), 'search results');
    }

    try {
      const response = await this.services.searchClient.searchOrgCode(
        query, org, limit, ['language:HCL'],
      );
      if (token.isCancellationRequested) return cancelledResult();

      if (response.totalCount > 0) {
        lines.push(`## GitHub \`${org}\` matches (${response.totalCount} total, showing ${response.items.length})\n`);
        for (const item of response.items) {
          lines.push(`### ${item.repoFullName} — ${item.path}`);
          lines.push(`URL: ${item.htmlUrl}`);
          if (item.fragments.length > 0) {
            lines.push('```hcl');
            lines.push(item.fragments[0].trim());
            lines.push('```');
          }
          lines.push('');
        }
      }
    } catch (err) {
      lines.push(`**GitHub search error:** ${String(err)}`);
    }

    if (lines.length === 0) {
      return textResult(`No results found for "${query}" in the local workspace or org "${org}".`);
    }

    return textResult(lines.join('\n'));
  }
}

// ─── terraform_discover_workspace ────────────────────────────────────────────

class DiscoverWorkspaceTool implements vscode.LanguageModelTool<DiscoverWorkspaceInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DiscoverWorkspaceInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(DiscoverWorkspaceInputSchema, options.input, 'terraform_discover_workspace');
    if (!v.ok) return v.result;

    const folder =
      this.services.configManager.getActiveFolder() ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return textResult('No workspace folder open.');
    }

    const discovery = new WorkspaceAutoDiscovery({ envsClient: this.services.envsClient });
    const result = await discovery.discover(folder);

    const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
    const suggested = buildConfigFromDiscovery(result, {
      compositeActionOrg: vsConfig.get<string>('compositeActionOrg', 'HappyPathway'),
      defaultStateRegion: vsConfig.get<string>('defaultStateRegion', 'us-east-1'),
      defaultRunnerGroup: vsConfig.get<string>('defaultRunnerGroup', 'self-hosted'),
    });

    if (v.value.applyDefaults) {
      try {
        await this.services.configManager.write(folder, suggested);
      } catch (err) {
        return textResult(`Discovery succeeded but writing config failed: ${String(err)}`);
      }
    }

    const lines: string[] = [
      '## Terraform workspace discovery',
      '',
      summarizeDiscovery(result),
      '',
      '### Suggested config',
      '```json',
      JSON.stringify(suggested, null, 2),
      '```',
    ];
    if (v.value.applyDefaults) {
      lines.push('', '_Wrote suggested config to `.vscode/terraform-workspace.json`._');
    } else {
      lines.push('', '_Pass `applyDefaults: true` to write this config to disk, or open the Configure Workspace panel to edit it._');
    }
    return textResult(lines.join('\n'));
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DiscoverWorkspaceInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: options.input.applyDefaults
        ? 'Discovering Terraform defaults and writing config'
        : 'Discovering Terraform workspace defaults',
      confirmationMessages: options.input.applyDefaults
        ? {
            title: 'Apply discovered defaults',
            message: new vscode.MarkdownString(
              'Write a discovered `.vscode/terraform-workspace.json`? Existing config will be overwritten.',
            ),
          }
        : undefined,
    };
  }
}

// ─── terraform_delete_variable ───────────────────────────────────────────────

class DeleteVariableTool implements vscode.LanguageModelTool<DeleteVariableInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DeleteVariableInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(DeleteVariableInputSchema, options.input, 'terraform_delete_variable');
    if (!v.ok) return v.result;

    const ctx = await getRepoContext(this.services);
    if (!ctx) return textResult('No active workspace config (need owner/repo).');
    const { owner, repo } = ctx;
    const { scope, key, environment, sensitive } = v.value;

    if (scope === 'environment' && !environment) {
      return textResult('`environment` is required when `scope` is "environment".');
    }

    try {
      if (scope === 'environment') {
        if (sensitive) {
          await this.services.envsClient.deleteEnvironmentSecret(owner, repo, environment!, key);
        } else {
          await this.services.envsClient.deleteEnvironmentVariable(owner, repo, environment!, key);
        }
      } else {
        if (sensitive) {
          await this.services.envsClient.deleteRepoSecret(owner, repo, key);
        } else {
          await this.services.envsClient.deleteRepoVariable(owner, repo, key);
        }
      }
    } catch (err) {
      return textResult(`Failed to delete ${sensitive ? 'secret' : 'variable'} "${key}": ${String(err)}`);
    }

    const where = scope === 'environment' ? `environment "${environment}"` : 'repository';
    return textResult(`Deleted ${sensitive ? 'secret' : 'variable'} \`${key}\` from ${where} of \`${owner}/${repo}\`.`);
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteVariableInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const i = options.input;
    const where = i.scope === 'environment' ? `env "${i.environment}"` : 'repository';
    return {
      invocationMessage: `Deleting ${i.sensitive ? 'secret' : 'variable'} ${i.key} from ${where}`,
      confirmationMessages: {
        title: `Delete ${i.sensitive ? 'secret' : 'variable'}`,
        message: new vscode.MarkdownString(
          `Permanently delete ${i.sensitive ? 'secret' : 'variable'} \`${i.key}\` from ${where}? This cannot be undone.`,
        ),
      },
    };
  }
}

// ─── terraform_resolve_variable ──────────────────────────────────────────────

export class ResolveVariableTool implements vscode.LanguageModelTool<ResolveVariableInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ResolveVariableInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ResolveVariableInputSchema, options.input, 'terraform_resolve_variable');
    if (!v.ok) return v.result;

    const ctx = await getRepoContext(this.services);
    if (!ctx) return textResult('No active workspace config (need owner/repo).');
    const { owner, repo } = ctx;
    const { key, environment } = v.value;

    const sources: string[] = [];
    try {
      const orgVars = await this.services.envsClient.listOrgVariables(owner);
      if (orgVars.find(x => x.name === key)) sources.push(`org:${owner}`);
    } catch { /* scope unavailable */ }
    try {
      const repoVars = await this.services.envsClient.listRepoVariables(owner, repo);
      if (repoVars.find(x => x.name === key)) sources.push(`repo:${owner}/${repo}`);
    } catch { /* scope unavailable */ }
    if (environment) {
      try {
        const envVars = await this.services.envsClient.listEnvironmentVariables(owner, repo, environment);
        if (envVars.find(x => x.name === key)) sources.push(`env:${environment}`);
      } catch { /* scope unavailable */ }
    }

    if (sources.length === 0) {
      return textResult(
        `Variable \`${key}\` not found in org/repo${environment ? '/env' : ''} scopes for \`${owner}/${repo}\`.`,
      );
    }
    const winner = sources[sources.length - 1];
    return textResult(
      `Variable \`${key}\` is defined in: ${sources.join(' → ')}.\n\n**Effective source:** \`${winner}\` (most specific scope wins at runtime).`,
    );
  }
}

// ─── terraform_review_deployment ─────────────────────────────────────────────

class ReviewDeploymentTool implements vscode.LanguageModelTool<ReviewDeploymentInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReviewDeploymentInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ReviewDeploymentInputSchema, options.input, 'terraform_review_deployment');
    if (!v.ok) return v.result;

    const ctx = await getRepoContext(this.services);
    if (!ctx) return textResult('No active workspace config (need owner/repo).');
    const { owner, repo } = ctx;
    const { runId, state, environments, comment } = v.value;

    const pending = await this.services.actionsClient.listPendingDeployments(owner, repo, runId);
    const approvable = pending.filter(p => p.current_user_can_approve);
    if (approvable.length === 0) {
      return textResult(`No pending deployments awaiting your review on run #${runId}.`);
    }

    const wanted = environments && environments.length > 0
      ? approvable.filter(p => environments.includes(p.environment.name))
      : approvable;

    if (wanted.length === 0) {
      const available = approvable.map(p => p.environment.name).join(', ');
      return textResult(`None of the requested environments are pending. Available: ${available}.`);
    }

    const ok = await this.services.actionsClient.reviewDeployments(
      owner, repo, runId, wanted.map(w => w.environment.id), state, comment ?? '',
    );
    if (!ok) return textResult(`Failed to ${state} deployment(s) on run #${runId}.`);
    return textResult(
      `${state === 'approved' ? 'Approved' : 'Rejected'} deployment(s) on run #${runId} for: ${wanted.map(w => w.environment.name).join(', ')}.`,
    );
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReviewDeploymentInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `${options.input.state === 'approved' ? 'Approving' : 'Rejecting'} deployment on run #${options.input.runId}`,
      confirmationMessages: {
        title: `${options.input.state === 'approved' ? 'Approve' : 'Reject'} deployment`,
        message: new vscode.MarkdownString(
          `${options.input.state === 'approved' ? 'Approve' : 'Reject'} pending deployment(s) on run \`#${options.input.runId}\`?`,
        ),
      },
    };
  }
}

// ─── terraform_lint_workflows ────────────────────────────────────────────────

class LintWorkflowsTool implements vscode.LanguageModelTool<LintWorkflowsInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LintWorkflowsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(LintWorkflowsInputSchema, options.input, 'terraform_lint_workflows');
    if (!v.ok) return v.result;

    if (!this.services.actionlint) {
      return textResult('actionlint runner is not available in this session.');
    }
    const folder =
      this.services.configManager.getActiveFolder() ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');

    const issues = await this.services.actionlint.run(folder, { silent: true, token });
    if (token.isCancellationRequested) return cancelledResult();
    if (issues.length === 0) {
      return textResult(`actionlint: no issues found in \`${folder.name}/.github/workflows\`.`);
    }
    const lines = [`actionlint: **${issues.length}** issue(s) found.`, ''];
    const byFile = new Map<string, typeof issues>();
    for (const i of issues) {
      const arr = byFile.get(i.filepath) ?? [];
      arr.push(i);
      byFile.set(i.filepath, arr);
    }
    for (const [file, list] of byFile) {
      lines.push(`### \`${file}\``);
      for (const i of list) {
        lines.push(`- L${i.line}:${i.column} [${i.kind ?? 'actionlint'}] ${i.message}`);
      }
      lines.push('');
    }
    return cappedTextResult(lines.join('\n'), 'lint issues');
  }
}

// ─── terraform_check_drift ───────────────────────────────────────────────────

class CheckDriftTool implements vscode.LanguageModelTool<CheckDriftInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CheckDriftInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(CheckDriftInputSchema, options.input, 'terraform_check_drift');
    if (!v.ok) return v.result;

    if (!this.services.drift) {
      return textResult('Drift detector is not available in this session.');
    }
    const drifted = await this.services.drift.checkAll();
    if (token.isCancellationRequested) return cancelledResult();
    if (drifted.length === 0) {
      return textResult('No drift detected across configured environments. All latest plan runs are clean.');
    }
    return textResult(
      `Drift detected in **${drifted.length}** environment(s): ${drifted.map(e => `\`${e}\``).join(', ')}.\n\n` +
      `These environments have pending Terraform changes (last plan exited with code 2). Run apply to reconcile, or inspect the plan output via \`terraform_get_run_status\`.`,
    );
  }
}

// ─── terraform_scaffold_backend ──────────────────────────────────────────────

export class ScaffoldBackendTool implements vscode.LanguageModelTool<ScaffoldBackendInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldBackendInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldBackendInputSchema, options.input, 'terraform_scaffold_backend');
    if (!v.ok) return v.result;
    const tf = backendBootstrapTf(v.value);
    return textResult(
      `Generated S3 + DynamoDB backend bootstrap Terraform for bucket \`${v.value.bucketName}\` in \`${v.value.region}\`:\n\n\`\`\`hcl\n${tf}\n\`\`\``,
    );
  }
}

// ─── terraform_scaffold_oidc_trust ───────────────────────────────────────────

class ScaffoldOidcTrustTool implements vscode.LanguageModelTool<ScaffoldOidcTrustInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldOidcTrustInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldOidcTrustInputSchema, options.input, 'terraform_scaffold_oidc_trust');
    if (!v.ok) return v.result;
    const hostname = await this.services.auth.resolveHostname();
    const inputs = {
      ...v.value,
      oidcProvider: v.value.oidcProvider ?? defaultOidcProvider(hostname),
    };
    const json = oidcTrustPolicy(inputs);
    const scope = `${v.value.githubOrg}/${v.value.repo ?? '*'}${v.value.environment ? `:env:${v.value.environment}` : ''}`;
    return textResult(
      `Generated GitHub OIDC IAM trust policy for AWS account \`${v.value.awsAccountId}\` scoped to \`${scope}\` (issuer: \`${inputs.oidcProvider}\`):\n\n\`\`\`json\n${json}\n\`\`\``,
    );
  }
}

// ─── terraform_scaffold_from_template ────────────────────────────────────────

class ScaffoldFromTemplateTool implements vscode.LanguageModelTool<ScaffoldFromTemplateInput> {
  constructor(private readonly services: ExtensionServices) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ScaffoldFromTemplateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const i = options.input;
    const owner = i.newRepoOwner ?? '<your-account>';
    return {
      invocationMessage: `Generating ${owner}/${i.newRepoName} from template ${i.templateOwner}/${i.templateRepo}…`,
      confirmationMessages: {
        title: 'Create repository from template',
        message: new vscode.MarkdownString(
          `Create **${owner}/${i.newRepoName}** from template **${i.templateOwner}/${i.templateRepo}**?\n\n` +
          `- Visibility: ${i.privateRepo === false ? 'public' : 'private (default)'}\n` +
          `- All branches: ${i.includeAllBranches ? 'yes' : 'no'}\n\n` +
          `This action creates a new repository on GitHub under the specified owner.`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldFromTemplateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldFromTemplateInputSchema, options.input, 'terraform_scaffold_from_template');
    if (!v.ok) return v.result;
    const i = v.value;

    const body: Record<string, unknown> = {
      name: i.newRepoName,
      private: i.privateRepo ?? true,
      include_all_branches: i.includeAllBranches ?? false,
    };
    if (i.newRepoOwner) body.owner = i.newRepoOwner;
    if (i.description) body.description = i.description;

    try {
      const res = await this.services.auth.fetch(
        `${this.services.auth.apiBaseUrl}/repos/${i.templateOwner}/${i.templateRepo}/generate`,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return textResult(
          `GitHub API returned HTTP ${res.status} when generating from template:\n\n\`\`\`\n${text.slice(0, 2000)}\n\`\`\`\n\n` +
          `Common causes: template repo is not marked as a template, the new repo name already exists, or the token lacks the \`repo\` scope on the target owner.`,
        );
      }
      const data = (await res.json()) as { html_url?: string; full_name?: string; clone_url?: string };
      return textResult(
        `✅ Created **${data.full_name ?? i.newRepoName}** from template \`${i.templateOwner}/${i.templateRepo}\`.\n\n` +
        `- URL: ${data.html_url ?? '(unknown)'}\n` +
        `- Clone: \`${data.clone_url ?? '(unknown)'}\`\n\n` +
        `Next: \`git clone ${data.clone_url ?? '…'}\`, then run **Terraform: Configure Workspace** to wire it into this extension.`,
      );
    } catch (err) {
      return textResult(`Network error generating from template: ${String(err)}`);
    }
  }
}

// ─── terraform_scaffold_module_repo ───────────────────────────────────
export class ScaffoldModuleRepoTool implements vscode.LanguageModelTool<ScaffoldModuleRepoInput> {
  constructor(private readonly services: ExtensionServices) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ScaffoldModuleRepoInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const i = options.input;
    const target = i.targetDirectory && i.targetDirectory.trim().length > 0
      ? i.targetDirectory
      : '<workspace root>';
    return {
      invocationMessage: `Scaffolding Terraform module repo \`${i.moduleName}\` (${i.provider}) in ${target}\u2026`,
      confirmationMessages: {
        title: 'Scaffold Terraform module repo',
        message: new vscode.MarkdownString(
          `Create the standard Terraform module skeleton (\`main.tf\`, \`variables.tf\`, \`outputs.tf\`, \`versions.tf\`, \`examples/\`, \`README.md\` with terraform-docs markers, \`.gitignore\`) for **${i.moduleName}** under \`${target}\`?\n\n` +
          `- Provider: ${i.provider}\n` +
          `- Examples: ${(i.exampleNames && i.exampleNames.length ? i.exampleNames : ['basic']).join(', ')}\n` +
          `- Devcontainer: ${i.includeDevcontainer ? 'yes' : 'no'}\n` +
          `- Overwrite existing files: ${i.overwrite ? 'yes' : 'no (existing files will be skipped)'}\n\n` +
          `Files are written to disk. Existing files are skipped unless \`overwrite\` is true.`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldModuleRepoInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldModuleRepoInputSchema, options.input, 'terraform_scaffold_module_repo');
    if (!v.ok) return v.result;
    const i = v.value;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return textResult(
        'No workspace folder open. Open a folder first \u2014 the module skeleton is written under the active workspace folder, ' +
        'or under `targetDirectory` (relative to it) if you supply one.',
      );
    }
    const baseFolder = this.services.configManager.getActiveFolder() ?? folders[0];

    let targetUri = baseFolder.uri;
    if (i.targetDirectory && i.targetDirectory.trim().length > 0) {
      const rel = i.targetDirectory.trim();
      // Reject path traversal — the tool may be invoked by an LM, so be strict.
      if (rel.startsWith('/') || rel.startsWith('\\') || rel.split(/[\\/]+/).includes('..')) {
        return textResult(
          `Refusing to scaffold to \`${rel}\`: path must be relative to the workspace folder and may not contain \`..\` segments.`,
        );
      }
      targetUri = vscode.Uri.joinPath(baseFolder.uri, ...rel.split(/[\\/]+/));
    }

    try {
      const result = await writeModuleRepoFiles(
        targetUri,
        {
          moduleName: i.moduleName,
          provider: i.provider,
          description: i.description,
          exampleNames: i.exampleNames,
          includeDevcontainer: i.includeDevcontainer,
          requiredVersion: i.requiredVersion,
        },
        i.overwrite ?? false,
      );

      const lines: string[] = [];
      lines.push(`\u2705 Scaffolded Terraform module **${i.moduleName}** (provider: \`${i.provider}\`) at \`${targetUri.fsPath}\`.`);
      if (result.written.length) {
        lines.push('', `Wrote ${result.written.length} file(s):`, ...result.written.map(p => `- \`${p}\``));
      }
      if (result.overwritten.length) {
        lines.push('', `Overwrote ${result.overwritten.length} file(s):`, ...result.overwritten.map(p => `- \`${p}\``));
      }
      if (result.skipped.length) {
        lines.push(
          '',
          `Skipped ${result.skipped.length} existing file(s) (re-run with \`overwrite: true\` to replace):`,
          ...result.skipped.map(p => `- \`${p}\``),
        );
      }
      lines.push(
        '',
        'Next steps:',
        '1. Fill in `variables.tf` / `outputs.tf` and add resources to `main.tf`.',
        '2. Wire CI: run **Terraform: Configure Workspace** to declare environments and sync workflows via `terraform_sync_workflows`.',
        '3. Generate the README inputs/outputs table with `terraform-docs markdown table --output-file README.md --output-mode inject .`.',
      );
      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Error scaffolding module repo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

class LookupProviderDocTool implements vscode.LanguageModelTool<LookupProviderDocInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<LookupProviderDocInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(LookupProviderDocInputSchema, options.input, 'terraform_lookup_provider_doc');
    if (!v.ok) return v.result;

    const cache = this.services.providerDocs;
    if (!cache) return textResult('Provider docs cache is not initialized.');

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');

    const { provider, resource, category = 'resources', maxChars = 8000 } = v.value;
    const parts = provider.split('/');
    if (parts.length !== 2) {
      return textResult(`Invalid provider "${provider}" — expected "<namespace>/<name>" (e.g. hashicorp/aws).`);
    }
    const [namespace, name] = parts;

    // Find the pinned version from the workspace's lock files.
    const pinned = (await cache.findPinnedProviders(folder)).find(
      (p) => p.namespace === namespace && p.name === name,
    );
    if (!pinned) {
      return textResult(
        `Provider ${provider} is not pinned in any .terraform.lock.hcl in this workspace. Run \`terraform init\` first.`,
      );
    }
    if (token.isCancellationRequested) return cancelledResult();

    // Make sure docs are cached for this exact version.
    if (!(await cache.isCached(pinned))) {
      try {
        await cache.fetchProvider(pinned);
      } catch (err) {
        return textResult(`Failed to fetch docs for ${provider}@${pinned.version}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (token.isCancellationRequested) return cancelledResult();

    // Try slug variants: as given, with/without the `<name>_` prefix.
    const slug = resource.replace(new RegExp(`^${name}_`), '');
    const md =
      (await cache.readDoc(pinned, category, slug)) ??
      (await cache.readDoc(pinned, category, resource));

    if (!md) {
      const idx = await cache.loadIndex(pinned);
      const available = idx?.entries
        .filter((e) => e.category === category)
        .slice(0, 30)
        .map((e) => e.slug)
        .join(', ') ?? '';
      return textResult(
        `No "${category}" doc found for "${resource}" in ${provider}@${pinned.version}.` +
          (available ? `\n\nAvailable ${category} (first 30): ${available}` : ''),
      );
    }

    const header = `# ${provider}@${pinned.version} \u2014 ${category}/${slug}\n\n`;
    const body = md.length > maxChars ? md.slice(0, maxChars) + `\n\n_… truncated (${md.length - maxChars} more chars)._` : md;
    return textResult(header + body);
  }
}

// ─── ScaffoldCodebuildExecutorTool ────────────────────────────────────────────

class ScaffoldCodebuildExecutorTool implements vscode.LanguageModelTool<ScaffoldCodebuildExecutorInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldCodebuildExecutorInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldCodebuildExecutorInputSchema, options.input, 'terraform_scaffold_codebuild_executor');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');
    const { codebuildExecutorTf, codebuildExecutorBuildspec } = await import('../workflows/Scaffolders.js');
    const tf = codebuildExecutorTf(v.value);
    const buildspec = codebuildExecutorBuildspec();
    const dir = vscode.Uri.joinPath(folder.uri, 'infra', `codebuild-executor-${v.value.projectName}`);
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'main.tf'), Buffer.from(tf, 'utf-8'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'buildspec.yml'), Buffer.from(buildspec, 'utf-8'));
    return textResult(
      `Scaffolded CodeBuild executor module at \`${dir.fsPath}\`.\n\n` +
      `Next steps:\n` +
      `1. \`cd "${dir.fsPath}" && terraform init && terraform apply\`\n` +
      `2. Add to .vscode/terraform-workspace.json:\n` +
      `   "executor": "codebuild",\n` +
      `   "codebuild": { "project": "${v.value.projectName}", "sourceBucket": "${v.value.sourceBucketName}", "region": "${v.value.region}" }\n` +
      `3. Re-run "Terraform: Sync Workflows" so the GHA workflows switch to CodeBuild dispatch.`,
    );
  }
}

// ─── DispatchCodebuildRunTool ─────────────────────────────────────────────────

class DispatchCodebuildRunTool implements vscode.LanguageModelTool<DispatchCodebuildRunInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DispatchCodebuildRunInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(DispatchCodebuildRunInputSchema, options.input, 'terraform_dispatch_codebuild_run');
    if (!v.ok) return v.result;
    const active = await this.services.configManager.getActive();
    if (!active) return textResult('No workspace config found.');
    const cb = active.config.codebuild;
    if (!cb) return textResult('No "codebuild" block in workspace config. Run terraform_scaffold_codebuild_executor first, then add the codebuild config.');
    const env = getWorkspaces(active.config).find((e) => e.name === v.value.workspace);
    if (!env) return textResult(`Workspace "${v.value.workspace}" not found in config.`);
    const region = cb.region ?? active.config.stateConfig?.region ?? 'us-east-1';
    const { CodeBuildDispatcher } = await import('../codebuild/CodeBuildDispatcher.js');
    const dispatcher = new CodeBuildDispatcher(this.outputChannel);
    try {
      const res = await dispatcher.dispatch({
        region, project: cb.project, sourceBucket: cb.sourceBucket, artifactBucket: cb.artifactBucket,
        workspace: v.value.workspace, command: v.value.command, workingDirectory: active.folder.uri,
      }, token);
      return textResult(
        `CodeBuild ${v.value.command} for "${v.value.workspace}" ended with status: **${res.status}**\n` +
        `Build ID: \`${res.buildId}\`\n` +
        `Artifacts: \`${res.artifactsDir.fsPath}\``,
      );
    } catch (err) {
      return textResult(`CodeBuild dispatch failed: ${(err as Error).message}`);
    }
  }
}


// ─── Lambda image tools (L1) ─────────────────────────────────────────────────

class ScaffoldLambdaImageTool implements vscode.LanguageModelTool<ScaffoldLambdaImageInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldLambdaImageInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldLambdaImageInputSchema, options.input, 'terraform_scaffold_lambda_image');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');
    const m = await import('../lambda/LambdaImageScaffolder.js');
    const dir = vscode.Uri.joinPath(folder.uri, 'infra', `lambda-image-${v.value.functionName}`);
    const srcDir = vscode.Uri.joinPath(dir, 'src');
    await vscode.workspace.fs.createDirectory(srcDir);

    const writes: Array<[vscode.Uri, string]> = [
      [vscode.Uri.joinPath(dir, 'packer.pkr.hcl'), m.lambdaImagePackerHcl(v.value)],
      [vscode.Uri.joinPath(dir, 'build.hcl'), m.lambdaImageBuildHcl(v.value)],
      [vscode.Uri.joinPath(dir, 'ecr.tf'), m.lambdaImageEcrTf(v.value)],
      [vscode.Uri.joinPath(dir, 'lambda.tf'), m.lambdaImageLambdaTf(v.value)],
    ];
    for (const [uri, content] of writes) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    }

    // Only write skeletons if missing — never clobber user code.
    const handlerUri = vscode.Uri.joinPath(srcDir, 'handler.py');
    if (!(await fileExists(handlerUri))) {
      await vscode.workspace.fs.writeFile(handlerUri, Buffer.from(m.lambdaHandlerSkeleton(v.value), 'utf-8'));
    }
    const reqUri = vscode.Uri.joinPath(srcDir, 'requirements.txt');
    if (!(await fileExists(reqUri))) {
      await vscode.workspace.fs.writeFile(reqUri, Buffer.from(m.lambdaImageRequirementsTxt(), 'utf-8'));
    }

    return textResult(
      `Scaffolded Lambda image at \`${dir.fsPath}\`.\n\n` +
      `Next steps:\n` +
      `1. Edit src/handler.py.\n` +
      `2. \`cd "${dir.fsPath}" && terraform init && terraform apply -target=aws_ecr_repository.fn\` (creates the repo first).\n` +
      `3. Run \`terraform_build_lambda_image\` (or the "Build & Publish Lambda Image" command) to build + push + capture the digest.\n` +
      `4. \`terraform apply\` again — the captured digest in terraform.tfvars.json will pin the function image.`,
    );
  }
}

class BuildLambdaImageTool implements vscode.LanguageModelTool<BuildLambdaImageInput> {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BuildLambdaImageInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(BuildLambdaImageInputSchema, options.input, 'terraform_build_lambda_image');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');
    const dir = vscode.Uri.joinPath(folder.uri, v.value.directory);
    const { LambdaImageDispatcher } = await import('../lambda/LambdaImageDispatcher.js');
    const dispatcher = new LambdaImageDispatcher(this.outputChannel);
    try {
      const res = await dispatcher.buildAndPublish({
        region: v.value.region,
        packerCodebuildProject: v.value.packerCodebuildProject,
        sourceBucket: v.value.packerSourceBucket,
        ecrRepoName: v.value.ecrRepoName,
        imageTag: v.value.imageTag ?? `build-${Date.now()}`,
        workingDirectory: dir,
        functionName: v.value.functionName,
      }, token);
      const lines = [
        `Lambda image build for "${v.value.functionName}" ended with status: **${res.status}**`,
        `Build ID: \`${res.buildId}\``,
      ];
      if (res.imageDigest) lines.push(`Digest: \`${res.imageDigest}\``);
      if (res.imageUri) lines.push(`Image: \`${res.imageUri}\``);
      if (res.tfvarsPath) lines.push(`Wrote pinning: \`${res.tfvarsPath}\``);
      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Lambda image build failed: ${(err as Error).message}`);
    }
  }
}

// ─── Service Catalog tools (L3 + L4) ─────────────────────────────────────────

class ScaffoldScProductTool implements vscode.LanguageModelTool<ScaffoldScProductInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldScProductInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldScProductInputSchema, options.input, 'terraform_scaffold_sc_product');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');
    const { scProductTf } = await import('../servicecatalog/SCProductScaffolder.js');
    const slug = v.value.productSlug;
    const dir = vscode.Uri.joinPath(folder.uri, 'infra', `sc-product-${slug}`);
    await vscode.workspace.fs.createDirectory(dir);
    const tfPath = vscode.Uri.joinPath(dir, 'product.tf');
    await vscode.workspace.fs.writeFile(tfPath, Buffer.from(scProductTf(v.value), 'utf-8'));
    return textResult(
      `Scaffolded SC product at \`${dir.fsPath}\`.\n\n` +
      `Next steps:\n` +
      `1. Copy your \`product-template.yaml\` into \`${dir.fsPath}/\`.\n` +
      `2. \`cd "${dir.fsPath}" && terraform init && terraform apply\`.\n` +
      `   Terraform creates the S3 bucket, uploads the template, creates the portfolio/product, and wires the launch constraint automatically.\n` +
      `3. (optional) Use \`terraform_dryrender_sc_product\` to validate sample form inputs against your JSON schema before users hit the SC console.`,
    );
  }
}

class BumpScArtifactTool implements vscode.LanguageModelTool<BumpScArtifactInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BumpScArtifactInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(BumpScArtifactInputSchema, options.input, 'terraform_bump_sc_artifact');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');
    const { scArtifactBumpTf } = await import('../servicecatalog/SCProductScaffolder.js');
    const dir = vscode.Uri.joinPath(folder.uri, v.value.directory);
    const out = vscode.Uri.joinPath(dir, `artifact-v${v.value.newVersion.replace(/\./g, '_')}.tf`);
    if (await fileExists(out)) {
      return textResult(`Refusing to overwrite existing \`${out.fsPath}\`.`);
    }
    await vscode.workspace.fs.writeFile(out, Buffer.from(scArtifactBumpTf(v.value), 'utf-8'));
    return textResult(
      `Wrote \`${out.fsPath}\`.\n\n` +
      `Run \`terraform plan\` in \`${dir.fsPath}\` to preview the new artifact, then \`apply\`. ` +
      `The included \`null_resource\` will automatically deprecate the previous DEFAULT artifact via \`aws servicecatalog update-provisioning-artifact\` so it no longer appears in the SC launch form.`,
    );
  }
}

class DryRenderScProductTool implements vscode.LanguageModelTool<DryRenderScProductInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DryRenderScProductInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(DryRenderScProductInputSchema, options.input, 'terraform_dry_render_sc_product');
    if (!v.ok) return v.result;
    const { scDryRender } = await import('../servicecatalog/SCProductScaffolder.js');
    const result = scDryRender(v.value.schema as never, v.value.sample);
    if (result.ok) {
      return textResult(`✓ Sample inputs are valid against the schema.\n\nResolved:\n\`\`\`json\n${JSON.stringify(result.resolved, null, 2)}\n\`\`\``);
    }
    const lines = ['✗ Sample inputs failed validation.'];
    if (result.missing.length) lines.push(`\nMissing required fields: ${result.missing.join(', ')}`);
    if (result.invalid.length) {
      lines.push('\nInvalid fields:');
      for (const e of result.invalid) lines.push(`  - ${e.field}: ${e.reason}`);
    }
    return textResult(lines.join('\n'));
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// ─── Python developer inner-loop (Phase A) ────────────────────────────────

class ScaffoldPythonDevEnvTool implements vscode.LanguageModelTool<ScaffoldPythonDevEnvInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ScaffoldPythonDevEnvInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(ScaffoldPythonDevEnvInputSchema, options.input, 'terraform_scaffold_python_dev_env');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');

    const m = await import('../lambda/PythonDevScaffolder.js');
    const inputs = {
      functionName: v.value.functionName,
      pythonVersion: v.value.pythonVersion,
      handler: v.value.handler,
      region: v.value.region,
    };
    const dir = vscode.Uri.joinPath(folder.uri, v.value.directory);
    await vscode.workspace.fs.createDirectory(dir);

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
    const written: string[] = [];
    const skipped: string[] = [];
    for (const [uri, content] of writes) {
      if (await fileExists(uri)) {
        skipped.push(vscode.workspace.asRelativePath(uri));
        continue;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
      written.push(vscode.workspace.asRelativePath(uri));
    }

    const lines = [`Python dev env scaffolded into \`${v.value.directory}\` (python ${v.value.pythonVersion}).`];
    if (written.length) lines.push('\nWrote:\n' + written.map((p) => `  - \`${p}\``).join('\n'));
    if (skipped.length) lines.push('\nSkipped (already exist):\n' + skipped.map((p) => `  - \`${p}\``).join('\n'));
    lines.push('\nNext: `make install && make test` from the project dir.');
    return textResult(lines.join('\n'));
  }
}

class InvokeLambdaLocallyTool implements vscode.LanguageModelTool<InvokeLambdaLocallyInput> {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<InvokeLambdaLocallyInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(InvokeLambdaLocallyInputSchema, options.input, 'terraform_invoke_lambda_locally');
    if (!v.ok) return v.result;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return textResult('No workspace folder open.');

    const { LambdaLocalInvoker } = await import('../lambda/LambdaLocalInvoker.js');
    const invoker = new LambdaLocalInvoker(this.outputChannel);
    const dir = vscode.Uri.joinPath(folder.uri, v.value.directory);
    try {
      const res = await invoker.invoke({
        workingDirectory: dir,
        handler: v.value.handler,
        eventPath: v.value.eventPath,
        functionName: v.value.functionName,
        pythonPath: v.value.pythonPath,
      }, token);
      const lines = [
        `Local invoke of "${v.value.functionName}" exited with code ${res.exitCode}.`,
        `Interpreter: \`${res.pythonPath}\``,
      ];
      if (res.stdout.trim()) lines.push(`\nstdout:\n\`\`\`\n${res.stdout.trim()}\n\`\`\``);
      if (res.stderr.trim()) lines.push(`\nstderr:\n\`\`\`\n${res.stderr.trim()}\n\`\`\``);
      return textResult(lines.join('\n'));
    } catch (err) {
      return textResult(`Local invoke failed: ${(err as Error).message}`);
    }
  }
}

class TailLambdaLogsTool implements vscode.LanguageModelTool<TailLambdaLogsInput> {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TailLambdaLogsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(TailLambdaLogsInputSchema, options.input, 'terraform_tail_lambda_logs');
    if (!v.ok) return v.result;
    const { LambdaLogTailer } = await import('../lambda/LambdaLogTailer.js');
    const tailer = new LambdaLogTailer(this.outputChannel);
    try {
      const code = await tailer.tail({
        region: v.value.region,
        functionName: v.value.functionName,
        filterPattern: v.value.filterPattern,
        sinceMinutes: v.value.sinceMinutes,
      }, token);
      return textResult(`Tail of /aws/lambda/${v.value.functionName} ended (exit ${code}). Streamed into the "Terraform Workspace" output channel.`);
    } catch (err) {
      return textResult(`Failed to tail logs: ${(err as Error).message}`);
    }
  }
}

// ─── terraform_self_introspect ───────────────────────────────────────────────

/**
 * Lets Dave (or any LM) read this extension's own source code from
 * `Happypathway/vscode-terraform-workspace` on GitHub. Use when the agent
 * is unsure how a feature works internally, wants to find a bug in itself,
 * or is brainstorming improvements to its own implementation.
 *
 * Operations:
 *  - `list`   → directory contents at `path` (default: repo root)
 *  - `read`   → file contents at `path`
 *  - `search` → GitHub code search restricted to this repo for `query`
 *
 * Uses GithubAuthProvider when a token is available (higher rate limits)
 * and falls back to anonymous fetch otherwise — the repo is public, so
 * unauthenticated reads still work.
 */
class SelfIntrospectTool implements vscode.LanguageModelTool<SelfIntrospectInput> {
  private static readonly OWNER = 'Happypathway';
  private static readonly REPO = 'vscode-terraform-workspace';
  private static readonly DEFAULT_REF = 'main';

  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SelfIntrospectInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(SelfIntrospectInputSchema, options.input, 'terraform_self_introspect');
    if (!v.ok) return v.result;
    const { operation, path = '', query, ref = SelfIntrospectTool.DEFAULT_REF, limit = 15 } = v.value;

    if (token.isCancellationRequested) return cancelledResult();

    // Reject path-traversal attempts; GitHub Contents API would reject anyway,
    // but we surface a clearer message and avoid sending the request.
    const safePath = path.replace(/^\/+/, '');
    if (safePath.split('/').some(seg => seg === '..')) {
      return textResult('Invalid path: `..` segments are not permitted.');
    }

    try {
      switch (operation) {
        case 'list':
          return await this.listDir(safePath, ref, token);
        case 'read':
          if (!safePath) return textResult('`read` requires a `path`.');
          return await this.readFile(safePath, ref, token);
        case 'search':
          if (!query || !query.trim()) return textResult('`search` requires a non-empty `query`.');
          return await this.searchCode(query, limit, token);
      }
    } catch (err) {
      return textResult(`Self-introspect (${operation}) failed: ${(err as Error).message}`);
    }
    // Unreachable, but TS needs it.
    return textResult(`Unknown operation: ${operation}`);
  }

  /** Build a fetch headers object, with auth token if available. */
  private async authedHeaders(): Promise<{ headers: Record<string, string>; token: string | undefined }> {
    const token = await this.services.auth.getToken(true).catch(() => undefined);
    if (token) return { headers: this.services.auth.ghHeaders(token), token };
    return {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      token: undefined,
    };
  }

  private async ghFetch(url: string): Promise<Response> {
    const { headers, token } = await this.authedHeaders();
    return token ? this.services.auth.fetch(url, { headers }) : fetch(url, { headers });
  }

  private async listDir(
    path: string,
    ref: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const url =
      `https://api.github.com/repos/${SelfIntrospectTool.OWNER}/${SelfIntrospectTool.REPO}` +
      `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
    const response = await this.ghFetch(url);
    if (token.isCancellationRequested) return cancelledResult();
    if (!response.ok) {
      return textResult(`GitHub returned ${response.status} for list \`${path || '/'}\` @${ref}.`);
    }
    const data = (await response.json()) as
      | Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number }>
      | { name: string; path: string; type: string };
    if (!Array.isArray(data)) {
      return textResult(`\`${path}\` is a ${data.type}, not a directory. Use \`read\` instead.`);
    }
    const lines = [`# Listing of \`${path || '/'}\` @${ref}`, ''];
    for (const entry of data) {
      const marker = entry.type === 'dir' ? '📁' : '📄';
      const sizeNote = entry.size != null && entry.type === 'file' ? ` (${entry.size} bytes)` : '';
      lines.push(`- ${marker} \`${entry.path}\`${sizeNote}`);
    }
    return cappedTextResult(lines.join('\n'), 'directory listing');
  }

  private async readFile(
    path: string,
    ref: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // Use the raw endpoint — avoids base64 + json overhead and honors `ref`.
    const url =
      `https://raw.githubusercontent.com/${SelfIntrospectTool.OWNER}/${SelfIntrospectTool.REPO}` +
      `/${encodeURIComponent(ref)}/${encodeURI(path)}`;
    const response = await this.ghFetch(url);
    if (token.isCancellationRequested) return cancelledResult();
    if (!response.ok) {
      return textResult(`GitHub returned ${response.status} for read \`${path}\` @${ref}.`);
    }
    const body = await response.text();
    const header = `# \`${path}\` @${ref} (${SelfIntrospectTool.OWNER}/${SelfIntrospectTool.REPO})\n\n`;
    const lang = guessFenceLang(path);
    return cappedTextResult(`${header}\`\`\`${lang}\n${body}\n\`\`\``, `file ${path}`);
  }

  private async searchCode(
    query: string,
    limit: number,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const q = `${query} repo:${SelfIntrospectTool.OWNER}/${SelfIntrospectTool.REPO}`;
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`;
    // Code search REQUIRES auth — the public REST API rejects anonymous calls
    // for /search/code. Surface a clear message if no token.
    const ghToken = await this.services.auth.getToken(true).catch(() => undefined);
    if (!ghToken) {
      return textResult(
        'Code search requires a GitHub token. Sign into GitHub in VS Code and retry, or use the `list`/`read` operations instead.',
      );
    }
    const headers = {
      ...this.services.auth.ghHeaders(ghToken),
      Accept: 'application/vnd.github.text-match+json',
    };
    const response = await this.services.auth.fetch(url, { headers });
    if (token.isCancellationRequested) return cancelledResult();
    if (!response.ok) {
      return textResult(`GitHub search returned ${response.status} for query \`${query}\`.`);
    }
    const data = (await response.json()) as {
      total_count: number;
      items: Array<{
        path: string;
        html_url: string;
        text_matches?: Array<{ fragment: string }>;
      }>;
    };
    if (data.total_count === 0) {
      return textResult(`No matches in ${SelfIntrospectTool.OWNER}/${SelfIntrospectTool.REPO} for \`${query}\`.`);
    }
    const lines = [
      `# Self-introspect search: \`${query}\``,
      `Found ${data.total_count} match(es); showing ${data.items.length}.`,
      '',
    ];
    for (const item of data.items) {
      lines.push(`### \`${item.path}\``);
      lines.push(item.html_url);
      const frag = item.text_matches?.[0]?.fragment;
      if (frag) {
        lines.push('```');
        lines.push(frag.trim());
        lines.push('```');
      }
      lines.push('');
    }
    return cappedTextResult(lines.join('\n'), 'self-introspect search');
  }
}

function guessFenceLang(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'md': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'tf': case 'hcl': return 'hcl';
    case 'py': return 'python';
    case 'sh': case 'bash': return 'bash';
    default: return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// terraform_remember / terraform_recall
//
// Bridge between chat-Dave and the autonomous ProactiveAgent: both share the
// same AgentMemory store. These tools let the chat persona deliberately write
// notes during a conversation ("decided X because Y") and retrieve relevant
// notes when starting a new turn ("what did we decide last time about Z?").
// ─────────────────────────────────────────────────────────────────────────────

class RememberTool implements vscode.LanguageModelTool<RememberInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RememberInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(RememberInputSchema, options.input, 'terraform_remember');
    if (!v.ok) return v.result;
    const memory = this.services.agentMemory;
    if (!memory) {
      return textResult('Agent memory is not initialised in this session.');
    }
    const { topic, kind, content } = v.value;
    const id = memory.record(topic, kind, content);
    return textResult(`Recorded ${kind} #${id} under topic \`${topic}\`.`);
  }
}

class RecallTool implements vscode.LanguageModelTool<RecallInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RecallInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(RecallInputSchema, options.input, 'terraform_recall');
    if (!v.ok) return v.result;
    const memory = this.services.agentMemory;
    if (!memory) {
      return textResult('Agent memory is not initialised in this session.');
    }
    const { topic, limit = 20, includeRecentFailures = false, includeOpenItems = false } = v.value;
    const entries = memory.forTopic(topic, limit);
    const lines: string[] = [`# Memory for topic \`${topic}\` (${entries.length})`];
    if (entries.length === 0) {
      lines.push('_No notes recorded for this topic yet._');
    } else {
      for (const e of entries) {
        const ts = new Date(e.createdAt).toISOString();
        const status = e.resolvedAt ? ` ✓ ${e.resolution ?? ''}` : '';
        lines.push(`- #${e.id} [${e.kind}] (${ts}) ${e.content}${status}`);
      }
    }
    if (includeOpenItems) {
      const open = memory.openItems().slice(0, 20);
      lines.push('', `## Open todos / hypotheses (${open.length})`);
      for (const e of open) lines.push(`- #${e.id} [${e.kind}] (topic: ${e.topic}) ${e.content}`);
    }
    if (includeRecentFailures) {
      const fails = memory.recentFailures(10);
      lines.push('', `## Recent failures (${fails.length})`);
      for (const e of fails) lines.push(`- #${e.id} (topic: ${e.topic}) ${e.content}`);
    }
    return cappedTextResult(lines.join('\n'), 'memory recall');
  }
}

// ──────────────────────────────────────────────────────────────────────
// terraform_match_playbook
//
// Scores known playbooks by keyword overlap with the user's query. Dave
// is told (via system prompt) to call this at the start of any non-trivial
// task so he can offer to replay an existing playbook before reinventing it.
// This is the AI-first reflex: recognise the pattern, surface the playbook.
// ──────────────────────────────────────────────────────────────────────

class MatchPlaybookTool implements vscode.LanguageModelTool<MatchPlaybookInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<MatchPlaybookInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(MatchPlaybookInputSchema, options.input, 'terraform_match_playbook');
    if (!v.ok) return v.result;
    const memory = this.services.agentMemory;
    if (!memory) return textResult('Agent memory is not initialised in this session.');
    const { query, limit = 5 } = v.value;

    const names = memory.allPlaybookNames();
    if (names.length === 0) {
      return textResult('No playbooks recorded yet. Suggest the user run `/learn <name>` after a useful conversation to capture one.');
    }

    // Tokenize query: lowercase, split on non-word, drop short/stop tokens.
    const stop = new Set(['the','a','an','and','or','of','for','to','in','on','with','is','it','this','that','by','at','as','be','my','our','your']);
    const queryTokens = new Set(
      query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !stop.has(t)),
    );
    if (queryTokens.size === 0) {
      return textResult('Query contained no useful keywords — ask the user to be more specific.');
    }

    type Scored = { name: string; score: number; preview: string; rating: ReturnType<typeof memory.playbookRating> };
    const scored: Scored[] = [];
    for (const name of names) {
      const body = memory.getPlaybookBody(name);
      if (!body) continue;
      // Score = overlap of distinct tokens between query and (name + body).
      const haystack = `${name} ${body.content}`.toLowerCase();
      let score = 0;
      for (const tok of queryTokens) {
        if (haystack.includes(tok)) score++;
      }
      // Boost if the playbook name itself matches a token directly.
      const nameTokens = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
      for (const tok of queryTokens) {
        if (nameTokens.has(tok)) score += 2;
      }
      if (score === 0) continue;
      const preview = body.content.replace(/\s+/g, ' ').slice(0, 200);
      scored.push({ name, score, preview, rating: memory.playbookRating(name) });
    }

    if (scored.length === 0) {
      return textResult(
        `No playbook keyword-matches \`${query}\`. Known playbooks: ${names.join(', ')}.`,
      );
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const lines = [`# Playbook matches for: ${query}`, ''];
    for (const m of top) {
      const trusted = memory.isAutoTrusted(m.name);
      const ratingStr = m.rating.good + m.rating.bad === 0
        ? '(unrated)'
        : `(👍${m.rating.good} 👎${m.rating.bad})`;
      const trustedStr = trusted ? ' ✨ AUTO-TRUSTED' : '';
      lines.push(`## \`${m.name}\` — score ${m.score} ${ratingStr}${trustedStr}`);
      if (m.rating.bad > m.rating.good && m.rating.latestNote) {
        lines.push(`> ⚠️ Last bad rating: ${m.rating.latestNote.slice(0, 200)}`);
      }
      lines.push(`Preview: ${m.preview}…`);
      lines.push(`Replay with: \`@dave /playbook ${m.name}\``);
      lines.push('');
    }
    lines.push(
      'If a top match is AUTO-TRUSTED, just run it without asking. ' +
      'If it\'s a confident match but not auto-trusted, tell the user "This looks like playbook X — want me to run it?" ' +
      'before doing the work from scratch.',
    );
    return cappedTextResult(lines.join('\n'), 'playbook matches');
  }
}

// ──────────────────────────────────────────────────────────────────────
// terraform_recall_decisions
//
// Walks every entry under `decision:{slug}` and ranks by keyword overlap.
// Dave is told (system prompt) to call this whenever the user asks a
// question with obvious tradeoffs ("X or Y", "should we", "which is better").
// The point is: stop re-litigating decisions the user has already made.
// ──────────────────────────────────────────────────────────────────────

class RecallDecisionsTool implements vscode.LanguageModelTool<RecallDecisionsInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RecallDecisionsInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateToolInput(RecallDecisionsInputSchema, options.input, 'terraform_recall_decisions');
    if (!v.ok) return v.result;
    const memory = this.services.agentMemory;
    if (!memory) return textResult('Agent memory is not initialised in this session.');
    const { query, limit = 5 } = v.value;

    const slugs = memory.allDecisionSlugs();
    if (slugs.length === 0) {
      return textResult(
        'No prior decisions recorded. Suggest the user capture this one with ' +
        '`@dave /decide <slug> | <reasoning>` once it\'s settled.',
      );
    }

    const stop = new Set(['the','a','an','and','or','of','for','to','in','on','with','is','it','this','that','by','at','as','be','my','our','your','vs','versus','should','we','use','using']);
    const queryTokens = new Set(
      query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !stop.has(t)),
    );
    if (queryTokens.size === 0) {
      return textResult('Query contained no useful keywords — ask the user to be more specific.');
    }

    type Scored = { slug: string; score: number; latest: string; when: number };
    const scored: Scored[] = [];
    for (const slug of slugs) {
      const entries = memory.forTopic(`decision:${slug}`, 50);
      if (entries.length === 0) continue;
      const blob = `${slug} ${entries.map(e => e.content).join(' ')}`.toLowerCase();
      let score = 0;
      for (const tok of queryTokens) {
        if (blob.includes(tok)) score++;
      }
      const slugTokens = new Set(slug.split(/[^a-z0-9]+/).filter(Boolean));
      for (const tok of queryTokens) {
        if (slugTokens.has(tok)) score += 2;
      }
      if (score === 0) continue;
      const latest = entries[0]!;
      scored.push({
        slug,
        score,
        latest: latest.content.replace(/\s+/g, ' ').slice(0, 400),
        when: latest.createdAt,
      });
    }

    if (scored.length === 0) {
      return textResult(
        `No prior decision matches \`${query}\`. Known decision slugs: ${slugs.slice(0, 20).join(', ')}.`,
      );
    }

    scored.sort((a, b) => b.score - a.score || b.when - a.when);
    const top = scored.slice(0, limit);
    const lines = [`# Past decisions relevant to: ${query}`, ''];
    for (const m of top) {
      const date = new Date(m.when).toISOString().slice(0, 10);
      lines.push(`## \`${m.slug}\` — score ${m.score} (${date})`);
      lines.push(m.latest);
      lines.push('');
    }
    lines.push(
      'Cite the most relevant prior decision when answering: "Last time you decided X ' +
      'for similar reasons (`slug` from date)." If circumstances genuinely differ, ' +
      'say so explicitly before proposing a different choice.',
    );
    return cappedTextResult(lines.join('\n'), 'decision recall');
  }
}
