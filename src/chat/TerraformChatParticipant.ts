import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { CodeSearchResult } from '../github/GithubSearchClient.js';
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
        return TerraformChatParticipant.handlePlan(request.prompt, stream, services, outputChannel);
      case 'apply':
        return TerraformChatParticipant.handleApply(request.prompt, stream, services, outputChannel);
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
      await services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        { workspace, working_directory: '.' },
      );

      stream.markdown('Workflow dispatched. Waiting for run to start…\n\n');
      outputChannel.appendLine(`[plan] Dispatched for ${workspace}`);

      const run = await services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-plan-${workspace}.yml`,
        before,
      );

      if (run) {
        stream.markdown(`Run started: [View logs on GitHub](${run.html_url})\n`);
        outputChannel.appendLine(`[plan] Run ${run.id}: ${run.html_url}`);
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
      await services.actionsClient.triggerWorkflow(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        { workspace, working_directory: '.' },
      );

      const run = await services.actionsClient.waitForNewRun(
        owner,
        repo,
        `terraform-apply-${workspace}.yml`,
        before,
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
    const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
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
    const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
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
      'Always use idiomatic Terraform. Prefer HappyPathway modules when available.';

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

    try {
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
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
