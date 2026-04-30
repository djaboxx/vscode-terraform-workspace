import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { CodeSearchResult } from '../github/GithubSearchClient.js';
import { GitRemoteParser } from '../auth/GitRemoteParser.js';
import { getWorkspaces } from '../types/index.js';

export class TerraformChatParticipant {
  static register(
    context: vscode.ExtensionContext,
    services: ExtensionServices,
    outputChannel: vscode.OutputChannel,
  ): void {
    const participant = vscode.chat.createChatParticipant(
      'terraform.assistant',
      (request, chatContext, stream, token) =>
        TerraformChatParticipant.handle(request, chatContext, stream, token, services, outputChannel),
    );

    participant.iconPath = new vscode.ThemeIcon('cloud');
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
        return TerraformChatParticipant.handleWorkspace(stream, services);
      case 'plan':
        return TerraformChatParticipant.handlePlan(request.prompt, stream, services, outputChannel, token);
      case 'apply':
        return TerraformChatParticipant.handleApply(request.prompt, stream, services, outputChannel, token);
      case 'bootstrap':
        return TerraformChatParticipant.handleBootstrap(stream, services);
      case 'varset':
        return TerraformChatParticipant.handleVarset(request.prompt, stream, services);
      case 'search':
        return TerraformChatParticipant.handleSearch(request.prompt, stream, token, request.toolInvocationToken, services);
      default:
        return TerraformChatParticipant.handleAI(request, chatContext, stream, token, services);
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
        'No workspace configured. Run **Terraform: Configure Workspace** to get started.',
      );
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) {
      stream.markdown(
        'Workspace config is missing `repo.name` or `repo.repoOrg`. Open the config panel to fix this.',
      );
      return {};
    }

    stream.markdown(`## Workspaces for \`${owner}/${repo}\`\n\n`);

    try {
      const envs = await services.envsClient.listEnvironments(owner, repo);
      if (envs.length === 0) {
        stream.markdown(
          `No GitHub Environments found. Use \`@terraform /bootstrap\` to create them.`,
        );
      } else {
        for (const env of envs) {
          stream.markdown(`- **${env.name}** — [View in GitHub](${env.html_url})\n`);
        }
      }
    } catch (err) {
      stream.markdown(`\n\n**Error listing environments:** ${String(err)}`);
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
      stream.markdown('No workspace config found. Run **Terraform: Configure Workspace** first.');
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    const workspace = prompt.trim() || getWorkspaces(active.config)[0]?.name;

    if (!workspace) {
      stream.markdown(
        'No workspace specified and no environments configured.\n\nUsage: `@terraform /plan <environment-name>`',
      );
      return {};
    }

    stream.markdown(`Triggering **plan** for \`${workspace}\`…\n\n`);

    try {
      const before = new Date();
      const ref = await GitRemoteParser.getDefaultBranch(active.folder.uri.fsPath);
      await services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        { workspace, working_directory: '.' },
        ref,
      );

      stream.markdown('Workflow dispatched. Waiting for run to start…\n\n');
      outputChannel.appendLine(`[plan] Dispatched for ${workspace}`);

      const run = await services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        before,
        30000,
        token,
      );

      if (run) {
        stream.markdown(`Run started: [View logs on GitHub](${run.html_url})\n\n`);
        outputChannel.appendLine(`[plan] Run ${run.id}: ${run.html_url}`);

        stream.progress('Waiting for plan to complete…');
        try {
          const finished = await services.actionsClient.waitForRun(
            owner, repo, run.id, outputChannel, 5000, token,
          );
          stream.markdown(
            `**Plan ${finished.conclusion ?? finished.status}** ` +
            `(commit \`${finished.head_sha.slice(0, 7)}\`).\n\n` +
            `[Open run on GitHub](${finished.html_url})\n`,
          );
        } catch (err) {
          if (!(err instanceof vscode.CancellationError)) {
            stream.markdown(`\n\n**Polling error:** ${String(err)}`);
          }
        }
      } else {
        stream.markdown('Run started (no run ID returned — check GitHub Actions).\n');
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
      stream.markdown('No workspace config found.');
      return {};
    }

    const { name: repo, repoOrg: owner } = active.config.repo;
    const workspace = prompt.trim() || getWorkspaces(active.config)[0]?.name;

    if (!workspace) {
      stream.markdown(
        'No workspace specified.\n\nUsage: `@terraform /apply <environment-name>`',
      );
      return {};
    }

    stream.markdown(`Triggering **apply** for \`${workspace}\`…\n\n`);

    try {
      const before = new Date();
      const ref = await GitRemoteParser.getDefaultBranch(active.folder.uri.fsPath);
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
        outputChannel.appendLine(`[apply] Run ${run.id}: ${run.html_url}`);
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
        'No workspace folder open. Open a folder containing (or intended to contain) your Terraform configuration first.',
      );
      return {};
    }

    const active = await services.configManager.getActive();
    const folderName = active?.folder.name ?? folders[0].name;

    stream.markdown(
      `## Bootstrap Workspace\n\nTo scaffold a new workspace for **${folderName}**:\n\n` +
        `1. Run **Terraform: Configure Workspace** from the command palette to open the config panel.\n` +
        `2. Fill in the repository, environments, and state configuration.\n` +
        `3. The extension will create \`.vscode/terraform-workspace.json\` which drives the GitHub Actions workflows.\n\n` +
        `You can also ask me to generate specific Terraform code or workflow configurations using \`@terraform /generate\`.`,
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
      stream.markdown('No workspace config found.');
      return {};
    }

    const org = prompt.trim() || active.config.repo.repoOrg;

    stream.markdown(`## Organization Variable Set: \`${org}\`\n\n`);

    try {
      const varSet = await services.orgsClient.getOrgVariableSet(org);

      if (varSet.variables.length === 0) {
        stream.markdown('No organization-level variables or secrets found.\n');
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
        'Please provide a search query.\n\nUsage: `@terraform /search <topic>`\n\n' +
          'Examples:\n- `@terraform /search aws_s3_bucket replication`\n' +
          '- `@terraform /search iam role module`',
      );
      return {};
    }

    // Resolve the org to search — prefer config, fall back to VS Code setting
    const active = await services.configManager.getActive();
    const org =
      active?.config.repo.repoOrg ??
      vscode.workspace.getConfiguration('terraformWorkspace').get<string>('repoOrg', '');

    if (!org) {
      stream.markdown(
        'No GitHub organization configured. Set `terraformWorkspace.repoOrg` or open a workspace config first.',
      );
      return {};
    }

    stream.markdown(`Searching \`${org}\` for **${query}**…\n\n`);

    let results;
    try {
      results = await services.searchClient.searchOrgCode(query, org, 10, ['language:HCL']);
    } catch (err) {
      stream.markdown(`\n\n**Search error:** ${String(err)}`);
      return {};
    }

    if (results.items.length === 0) {
      stream.markdown(
        `No code results found in \`${org}\` for **${query}**.\n\n` +
          `Try broader terms or simplify the query.`,
      );
      return {};
    }

    stream.markdown(
      `Found **${results.totalCount}** result(s)${results.incompleteResults ? ' (incomplete — rate limited)' : ''}. ` +
        `Showing top ${results.items.length}:\n\n`,
    );

    // Stream each result as a reference + preview so the user can see what we found
    for (const item of results.items) {
      stream.markdown(`### [\`${item.path}\`](${item.htmlUrl}) — \`${item.repoFullName}\`\n\n`);
      if (item.fragments.length > 0) {
        stream.markdown(
          `\`\`\`hcl\n${item.fragments.slice(0, 2).map(f => f.trim()).join('\n\n...\n\n')}\n\`\`\`\n\n`,
        );
      }
    }

    // Pass fragments to the LLM for a synthesized, actionable response
    const aiModel = vscode.workspace.getConfiguration('terraformWorkspace').get<string>('aiModel', 'gpt-4o');
    const models = await vscode.lm.selectChatModels({ family: aiModel });
    const model = models[0];
    if (!model || token.isCancellationRequested) {
      return {};
    }

    const fragmentContext = buildSearchContext(query, org, results.items);

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        'You are a Terraform expert. A user searched their GitHub organization for Terraform code examples.\n' +
          'Analyze the code fragments below and provide a concise, actionable answer to their query.\n' +
          'Focus on patterns, best practices, and concrete usage examples from the actual search results.\n' +
          'If the fragments show incomplete code, explain what the pattern does and how to use it correctly.\n' +
          'Highlight any HappyPathway module patterns if present.',
      ),
      vscode.LanguageModelChatMessage.User(fragmentContext),
      vscode.LanguageModelChatMessage.User(
        `User query: "${query}"\n\nProvide a helpful summary with code examples based on the search results above.`,
      ),
    ];

    stream.markdown('---\n\n**Summary from your codebase:**\n\n');

    try {
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    } catch (err) {
      if ((err as Error).name !== 'Cancelled') {
        stream.markdown(`\n\n**Error generating summary:** ${String(err)}`);
      }
    }

    return {};
  }

  // ── AI fallback (generate, modify, explain, and freeform) ──────────────────

  private static async handleAI(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const aiModel = vscode.workspace.getConfiguration('terraformWorkspace').get<string>('aiModel', 'gpt-4o');
    const models = await vscode.lm.selectChatModels({ family: aiModel });
    const model = models[0];

    if (!model) {
      stream.markdown(
        'No language model available. Ensure GitHub Copilot Chat is installed and signed in.',

      );
      return {};
    }

    // ── Build system context ──────────────────────────────────────────────────

    let systemPrompt =
      'You are a Terraform workspace assistant backed by GitHub Actions and HappyPathway infrastructure patterns.\n' +
      'You help users manage Terraform infrastructure: generating HCL code, explaining configs, managing environments, ' +
      'and using GitHub Actions for plan/apply workflows.\n' +
      'Always use idiomatic Terraform. Prefer HappyPathway modules when available.\n' +
      'Tool-selection guidance:\n' +
      '- Before asking the user for workspace config values, call `terraform_discover_workspace` ' +
      'to auto-fill defaults from git, .tf files, workflows, and GitHub Environments.\n' +
      '- For "where does this variable come from?" questions, use `terraform_resolve_variable`.\n' +
      '- For "is anything out of sync?" questions, use `terraform_check_drift`.\n' +
      '- Use `terraform_lint_workflows` after `terraform_sync_workflows` to validate generated YAML.';

    try {
      const active = await services.configManager.getActive();
      if (active) {
        const { name: repo, repoOrg: owner } = active.config.repo;
        systemPrompt += `\n\nCurrent repository: ${owner}/${repo}`;
        const envNames = getWorkspaces(active.config).map(e => e.name).join(', ');
        if (envNames) {
          systemPrompt += `\nConfigured environments: ${envNames}`;
        }
      }
    } catch {
      // ignore
    }

    // ── Read .tf files from the open workspace ────────────────────────────────

    const tfContext = services.tfCache.getContext();

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    if (tfContext) {
      messages.push(vscode.LanguageModelChatMessage.User(tfContext));
    }

    // Append conversation history
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
          .map(r => r.value.value)
          .join('');
        if (text) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    // Expose the extension's own LM tools to the chat. This lets the model
    // actually invoke `terraform_*` tools (discover workspace, run plan,
    // search code, lint workflows, check drift, etc.) rather than just
    // describing what it would do.
    const terraformTools: vscode.LanguageModelChatTool[] = vscode.lm.tools
      .filter(t => t.name.startsWith('terraform_'))
      .map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

    // Bound the tool-call loop so a misbehaving model can't spin forever.
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
        const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];

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
          stream.markdown(`\n\n> 🔧 invoking \`${call.name}\`…\n\n`);
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

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Formats GitHub code search results into a compact LLM-friendly context block.
 * Keeps total length bounded so we don't overflow the model context window.
 */
function buildSearchContext(query: string, org: string, items: CodeSearchResult[]): string {
  const MAX_FRAGMENT_CHARS = 800;
  const lines: string[] = [
    `GitHub code search results for query "${query}" in org "${org}":`,
    '',
  ];

  for (const item of items) {
    lines.push(`--- File: ${item.path} (${item.repoFullName}) ---`);
    lines.push(`URL: ${item.htmlUrl}`);
    if (item.fragments.length > 0) {
      const fragment = item.fragments[0].slice(0, MAX_FRAGMENT_CHARS);
      lines.push(fragment);
    }
    lines.push('');
  }

  return lines.join('\n');
}
