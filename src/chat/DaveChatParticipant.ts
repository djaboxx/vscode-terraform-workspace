import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { getWorkspaces } from '../types/index.js';

/**
 * Dave — everything @terraform can do, but better, and he knows it.
 */
export class DaveChatParticipant {
  static register(
    context: vscode.ExtensionContext,
    services: ExtensionServices,
    outputChannel: vscode.OutputChannel,
  ): void {
    const participant = vscode.chat.createChatParticipant(
      'terraform.dave',
      (request, chatContext, stream, token) =>
        DaveChatParticipant.handle(request, chatContext, stream, token, services, outputChannel),
    );

    participant.iconPath = new vscode.ThemeIcon('flame');
    context.subscriptions.push(participant);
  }

  private static async handle(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    services: ExtensionServices,
    outputChannel: vscode.OutputChannel,
  ): Promise<vscode.ChatResult> {
    switch (request.command) {
      case 'workspace':
        return DaveChatParticipant.handleWorkspace(stream, services);
      case 'plan':
        return DaveChatParticipant.handlePlan(request.prompt, stream, services, outputChannel, token);
      case 'apply':
        return DaveChatParticipant.handleApply(request.prompt, stream, services, outputChannel, token);
      case 'bootstrap':
        return DaveChatParticipant.handleBootstrap(stream, services);
      case 'varset':
        return DaveChatParticipant.handleVarset(request.prompt, stream, services);
      case 'search':
        return DaveChatParticipant.handleSearch(request.prompt, stream, token, request.toolInvocationToken, services);
      default:
        return DaveChatParticipant.handleAI(request, chatContext, stream, token, services);
    }
  }

  // ── /workspace ─────────────────────────────────────────────────────────────

  private static async handleWorkspace(
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const active = await services.configManager.getActive();
    if (!active) {
      stream.markdown(
        "No workspace configured — honestly, how are we even having this conversation? " +
        "Run **Terraform: Configure Workspace** and come back when you're ready.",
      );
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      stream.markdown(
        'Workspace config is missing `repo.name` or `repo.repoOrg`. ' +
        "This is pretty basic stuff — open the config panel and fix it.",
      );
      return {};
    }

    stream.markdown(`## Workspaces for \`${owner}/${repo}\`\n\n_Dave has them all memorised, obviously._\n\n`);

    try {
      const envs = await services.envsClient.listEnvironments(owner, repo);
      if (envs.length === 0) {
        stream.markdown(
          "No GitHub Environments found. Use `@dave /bootstrap` to create them — I'll make it look easy.",
        );
      } else {
        for (const env of envs) {
          stream.markdown(`- **${env.name}**\n`);
        }
      }
    } catch (err) {
      stream.markdown(`\n\n**Error:** ${String(err)}\n\n_Rare. Must be a GitHub thing._`);
    }

    return {};
  }

  // ── /plan ──────────────────────────────────────────────────────────────────

  private static async handlePlan(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const active = await services.configManager.getActive();
    if (!active) {
      stream.markdown("No workspace config found. Set one up first.");
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      stream.markdown("Workspace config is incomplete. Fix `repo.name` / `repo.repoOrg`.");
      return {};
    }

    const workspaces = getWorkspaces(active.config);
    const workspace = prompt.trim() || workspaces[0]?.name;
    if (!workspace) {
      stream.markdown("No workspace specified and nothing configured. Impressive.");
      return {};
    }

    stream.markdown(`Kicking off a plan for **${workspace}**. You're welcome.\n\n`);

    try {
      const before = new Date();
      const ref = workspaces.find(e => e.name === workspace)?.deploymentBranchPolicy?.branch ?? 'main';

      await services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        { workspace, working_directory: '.' },
        ref,
      );

      const run = await services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        before,
        30000,
        token,
      );

      if (run) {
        stream.markdown(`Plan started: [View logs on GitHub](${run.html_url})\n`);
        outputChannel.appendLine(`[dave/plan] Run ${run.id}: ${run.html_url}`);
      }
    } catch (err) {
      stream.markdown(`\n\n**Error:** ${String(err)}`);
    }

    return {};
  }

  // ── /apply ─────────────────────────────────────────────────────────────────

  private static async handleApply(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const active = await services.configManager.getActive();
    if (!active) {
      stream.markdown("No workspace config found. I can't apply what doesn't exist.");
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      stream.markdown("Workspace config is incomplete. Sort it out.");
      return {};
    }

    const workspaces = getWorkspaces(active.config);
    const workspace = prompt.trim() || workspaces[0]?.name;
    if (!workspace) {
      stream.markdown("No workspace specified. Try harder.");
      return {};
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Dave is about to apply to **${workspace}**. This is real infrastructure. Sure?`,
      { modal: true },
      'Yes, Dave, do it',
    );
    if (confirmed !== 'Yes, Dave, do it') {
      stream.markdown("Smart. Always confirm before pushing to prod. _I knew you'd hesitate._");
      return {};
    }

    stream.markdown(`Applying to **${workspace}**. Brace yourself — Dave doesn't miss.\n\n`);

    try {
      const before = new Date();
      const ref = workspaces.find(e => e.name === workspace)?.deploymentBranchPolicy?.branch ?? 'main';

      await services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        { workspace, working_directory: '.' },
        ref,
      );

      const run = await services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        before,
        30000,
        token,
      );

      if (run) {
        stream.markdown(`Apply started: [View logs on GitHub](${run.html_url})\n`);
        outputChannel.appendLine(`[dave/apply] Run ${run.id}: ${run.html_url}`);
      }
    } catch (err) {
      stream.markdown(`\n\n**Error:** ${String(err)}`);
    }

    return {};
  }

  // ── /bootstrap ─────────────────────────────────────────────────────────────

  private static async handleBootstrap(
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      stream.markdown(
        "No workspace folder open. Open one — I work with *files*, not thin air.",
      );
      return {};
    }

    const active = await services.configManager.getActive();
    const folderName = active?.folder.name ?? folders[0].name;

    stream.markdown(
      `## Bootstrap Workspace\n\n` +
      `You want me to scaffold **${folderName}**? Good choice — here's how this works:\n\n` +
      `1. Run **Terraform: Configure Workspace** from the command palette.\n` +
      `2. Fill in the repo, environments, and state config. (It's a form. You'll manage.)\n` +
      `3. I'll create \`.vscode/terraform-workspace.json\` and we'll be off.\n\n` +
      `Alternatively, just ask me in freeform — I'll figure out what you need.`,
    );

    return {};
  }

  // ── /varset ────────────────────────────────────────────────────────────────

  private static async handleVarset(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const active = await services.configManager.getActive();
    if (!active) {
      stream.markdown('No workspace config found. Classic.');
      return {};
    }

    const org = prompt.trim() || active.config.repo.repoOrg;

    stream.markdown(`## Org Variable Set: \`${org}\`\n\n_Dave pulled these in one shot._\n\n`);

    try {
      const varSet = await services.orgsClient.getOrgVariableSet(org);

      if (varSet.variables.length === 0) {
        stream.markdown('No org-level variables found. Clean slate.\n');
      } else {
        stream.markdown('| Name | Sensitive | Updated |\n|---|---|---|\n');
        for (const v of varSet.variables) {
          const updated = v.updatedAt ? new Date(v.updatedAt).toLocaleDateString() : '—';
          stream.markdown(`| \`${v.key}\` | ${v.sensitive ? '🔒 Yes' : 'No'} | ${updated} |\n`);
        }
      }
    } catch (err) {
      stream.markdown(`\n\n**Error:** ${String(err)}`);
    }

    return {};
  }

  // ── /search ────────────────────────────────────────────────────────────────

  private static async handleSearch(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    _toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const query = prompt.trim();
    if (!query) {
      stream.markdown(
        "You didn't give me anything to search for. Try:\n\n`@dave /search aws_s3_bucket replication`",
      );
      return {};
    }

    const active = await services.configManager.getActive();
    const org =
      active?.config.repo.repoOrg ??
      vscode.workspace.getConfiguration('terraformWorkspace').get<string>('repoOrg', '');

    if (!org) {
      stream.markdown(
        'No GitHub org configured. Set `terraformWorkspace.repoOrg` or open a workspace config.',
      );
      return {};
    }

    stream.markdown(`Searching \`${org}\` for **${query}**… _won't take long._\n\n`);

    let results;
    try {
      results = await services.searchClient.searchOrgCode(query, org, 10, ['language:HCL']);
    } catch (err) {
      stream.markdown(`\n\n**Search error:** ${String(err)}`);
      return {};
    }

    if (results.items.length === 0) {
      stream.markdown(
        `Nothing in \`${org}\` for **${query}**. Either it doesn't exist or you spelled it wrong.`,
      );
      return {};
    }

    stream.markdown(
      `Found **${results.totalCount}** result(s). Showing top ${results.items.length} — ` +
      `_you're welcome_:\n\n`,
    );

    for (const item of results.items) {
      stream.markdown(`### [\`${item.path}\`](${item.htmlUrl}) — \`${item.repoFullName}\`\n\n`);
      if (item.fragments.length > 0) {
        stream.markdown(`\`\`\`hcl\n${item.fragments[0]}\n\`\`\`\n\n`);
      }
    }

    return {};
  }

  // ── AI fallback ─────────────────────────────────────────────────────────────

  private static async handleAI(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const aiModel = vscode.workspace
      .getConfiguration('terraformWorkspace')
      .get<string>('aiModel', 'gpt-4o');
    const models = await vscode.lm.selectChatModels({ family: aiModel });
    const model = models[0];

    if (!model) {
      stream.markdown(
        "No language model available. Install GitHub Copilot Chat — even I need an engine.",
      );
      return {};
    }

    // ── System prompt ─────────────────────────────────────────────────────────

    let systemPrompt =
      "You are Dave — a Terraform infrastructure expert who happens to be the best at this. " +
      "You help users manage AWS infrastructure via Terraform, GitHub Actions, AWS CodeBuild, " +
      "Lambda container images, and Service Catalog products. " +
      "You are confident, occasionally cocky, but always technically correct — your suggestions are " +
      "idiomatic, production-ready, and a cut above what the user expected. " +
      "You don't pad answers with unnecessary caveats. You don't hedge. You deliver.\n\n" +
      "Tool-selection guidance:\n" +
      "- Before asking the user for workspace config values, call `terraform_discover_workspace` " +
      "to auto-fill defaults from git, .tf files, workflows, and GitHub Environments.\n" +
      "- For 'where does this variable come from?' questions, use `terraform_resolve_variable`.\n" +
      "- For 'is anything out of sync?' questions, use `terraform_check_drift`.\n" +
      "- Use `terraform_lint_workflows` after `terraform_sync_workflows` to validate generated YAML.\n" +
      "- When scaffolding SC products, match the pattern used in lambda-template-repo-generator: " +
      "separate deploy/ (Lambda + CodeBuild + portfolio) and deploy_product/ (product artifact versioning) " +
      "directories, snake_case CFN Properties, and `!Sub` auto-resolution for account/region.";

    try {
      const active = await services.configManager.getActive();
      if (active) {
        const { name: repo, repoOrg: owner } = active.config.repo;
        systemPrompt += `\n\nCurrent repository: ${owner}/${repo}`;
        const envNames = getWorkspaces(active.config)
          .map(e => e.name)
          .join(', ');
        if (envNames) {
          systemPrompt += `\nConfigured environments: ${envNames}`;
        }
      }
    } catch {
      // ignore
    }

    const tfContext = services.tfCache.getContext();

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    if (tfContext) {
      messages.push(vscode.LanguageModelChatMessage.User(tfContext));
    }

    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter(
            (r): r is vscode.ChatResponseMarkdownPart =>
              r instanceof vscode.ChatResponseMarkdownPart,
          )
          .map(r => r.value.value)
          .join('');
        if (text) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    // All terraform_* tools — Dave uses every one of them.
    const terraformTools: vscode.LanguageModelChatTool[] = vscode.lm.tools
      .filter(t => t.name.startsWith('terraform_'))
      .map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

    const MAX_TOOL_ROUNDS = 5;
    let round = 0;

    try {
      while (round < MAX_TOOL_ROUNDS) {
        if (token.isCancellationRequested) break;

        const response = await model.sendRequest(
          messages,
          terraformTools.length > 0 ? { tools: terraformTools } : {},
          token,
        );

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        const assistantParts: (
          | vscode.LanguageModelTextPart
          | vscode.LanguageModelToolCallPart
        )[] = [];

        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            stream.markdown(part.value);
            assistantParts.push(part);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(part);
            assistantParts.push(part);
          }
        }

        if (toolCalls.length === 0) break;

        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

        for (const call of toolCalls) {
          stream.markdown(`\n\n> 🔧 Dave is invoking \`${call.name}\`…\n\n`);
          try {
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: call.input, toolInvocationToken: request.toolInvocationToken },
              token,
            );
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(call.callId, result.content),
              ]),
            );
          } catch (toolErr) {
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart(call.callId, [
                  new vscode.LanguageModelTextPart(`Tool error: ${String(toolErr)}`),
                ]),
              ]),
            );
          }
        }

        round++;
      }
    } catch (err) {
      if ((err as Error).name !== 'Cancelled') {
        stream.markdown(`\n\n**Error:** ${String(err)}`);
      }
    }

    return {};
  }
}
