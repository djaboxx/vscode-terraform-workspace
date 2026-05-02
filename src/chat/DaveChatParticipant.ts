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
      case 'remember':
        return DaveChatParticipant.handleRemember(request.prompt, stream, services);
      case 'recall':
        return DaveChatParticipant.handleRecall(request.prompt, stream, services);
      case 'memory':
        return DaveChatParticipant.handleMemory(stream, services);
      case 'learn':
        return DaveChatParticipant.handleLearn(request.prompt, chatContext, stream, services);
      case 'playbook':
        return DaveChatParticipant.handlePlaybook(request, chatContext, stream, token, services);
      case 'playbook-rate':
        return DaveChatParticipant.handlePlaybookRate(request.prompt, stream, services);
      case 'decide':
        return DaveChatParticipant.handleDecide(request.prompt, stream, services);
      case 'digest':
        return DaveChatParticipant.handleDigest(stream, services);
      case 'done':
        return DaveChatParticipant.handleDone(request.prompt, stream, services);
      case 'checkpoint':
        return DaveChatParticipant.handleCheckpoint(request.prompt, stream, services);
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

  // ── /remember, /recall, /memory ────────────────────────────────────────────
  //
  // Direct UX for the shared agent memory store. These bypass the LM so the
  // user can talk to their own brain without paying the round-trip cost.
  // The same store is read/written by the LM via terraform_remember /
  // terraform_recall and by the autonomous ProactiveAgent — one brain.

  /** Resolve the conventional topic for the active workspace's repo. */
  private static async repoTopic(services: ExtensionServices): Promise<string | undefined> {
    const active = await services.configManager.getActive();
    if (!active) return undefined;
    const { name: repo, repoOrg: owner } = active.config.repo;
    if (!owner || !repo) return undefined;
    return `repo:${owner}/${repo}`;
  }

  private static async handleRemember(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    // Parse leading directives. Supported:
    //   @topic:foo                → write to topic `foo` (e.g. `@topic:user:preferences`)
    //   @prefs                    → shorthand for topic `user:preferences`
    //   (no directive)            → default to the active repo's topic
    const trimmed = prompt.trim();
    if (!trimmed) {
      stream.markdown(
        'Tell me what to remember. Examples:\n' +
        '- `@dave /remember decision: switched to Service Catalog products`\n' +
        '- `@dave /remember @prefs fact: I always tag with cost-center=plat`\n' +
        '- `@dave /remember @topic:aws:account-12345 decision: use eu-west-2 by default`\n\n' +
        'Kinds: `fact`, `decision`, `hypothesis`, `failure`, `todo` — `fact` is the default.\n' +
        'Topic defaults to the active workspace\'s repo.',
      );
      return {};
    }
    let body = trimmed;
    let topic: string | undefined;
    const directiveMatch = body.match(/^@(prefs|topic:[^\s]+)\s+/i);
    if (directiveMatch) {
      const directive = directiveMatch[1]!.toLowerCase();
      if (directive === 'prefs') {
        topic = 'user:preferences';
      } else {
        topic = directive.slice('topic:'.length);
      }
      body = body.slice(directiveMatch[0]!.length);
    } else {
      topic = await DaveChatParticipant.repoTopic(services);
      if (!topic) {
        stream.markdown(
          'No active workspace, so I can\'t pick a topic. Either configure a workspace, ' +
          'use `@prefs` for general preferences (e.g. `@dave /remember @prefs fact: …`), ' +
          'or use `@topic:<key>` to specify one.',
        );
        return {};
      }
    }
    // Parse `kind: content` shorthand. Accepted kinds match AgentMemory.
    // Anything not matching a kind defaults to `fact`.
    const kinds = ['fact', 'decision', 'hypothesis', 'failure', 'todo'] as const;
    type Kind = (typeof kinds)[number];
    let kind: Kind = 'fact';
    let content = body;
    const colonIdx = body.indexOf(':');
    if (colonIdx > 0) {
      const head = body.slice(0, colonIdx).trim().toLowerCase();
      if ((kinds as readonly string[]).includes(head)) {
        kind = head as Kind;
        content = body.slice(colonIdx + 1).trim();
      }
    }
    if (!content) {
      stream.markdown('Empty content — nothing to record.');
      return {};
    }
    const id = memory.record(topic, kind, content);
    stream.markdown(`Recorded **${kind}** \`#${id}\` under \`${topic}\`.\n\n> ${content}`);
    return {};
  }

  private static async handleRecall(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    // If the user typed a topic after /recall, honour it; otherwise default
    // to the current repo's topic.
    const explicit = prompt.trim();
    const topic = explicit || (await DaveChatParticipant.repoTopic(services));
    if (!topic) {
      stream.markdown(
        'No active workspace and no topic given. Try `@dave /recall repo:owner/name` or ' +
        '`@dave /recall some-topic`.',
      );
      return {};
    }
    const entries = memory.forTopic(topic, 50);
    stream.markdown(`## Memory: \`${topic}\` (${entries.length})\n\n`);
    if (entries.length === 0) {
      stream.markdown('_Nothing recorded yet._ Use `@dave /remember <kind>: <note>` to start.');
      return {};
    }
    for (const e of entries) {
      const ts = new Date(e.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const status = e.resolvedAt ? ` ✓ ${e.resolution ?? ''}` : '';
      stream.markdown(`- \`#${e.id}\` **${e.kind}** _(${ts})_ ${e.content}${status}\n`);
    }
    return {};
  }

  private static async handleMemory(
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const topic = await DaveChatParticipant.repoTopic(services);
    if (!topic) {
      stream.markdown('No active workspace. Configure one first.');
      return {};
    }
    const entries = memory.forTopic(topic, 200);
    const lines = [
      `# Memory \u2014 ${topic}`,
      '',
      `_${entries.length} note(s). Edits in this view do not persist back to the store._`,
      '',
    ];
    if (entries.length === 0) {
      lines.push('_(empty)_');
    } else {
      for (const e of entries) {
        const ts = new Date(e.createdAt).toISOString();
        lines.push(`## #${e.id} — ${e.kind}`);
        lines.push(`_${ts}${e.resolvedAt ? ` · resolved: ${e.resolution ?? ''}` : ''}_`);
        lines.push('');
        lines.push(e.content);
        lines.push('');
      }
    }
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    stream.markdown(`Opened memory view for \`${topic}\` (${entries.length} note(s)).`);
    return {};
  }

  // ── /learn, /playbook ──────────────────────────────────────────────────────
  //
  // The training loop. /learn captures the just-completed conversation as a
  // reusable "playbook" (a structured note under topic `playbook:{name}`).
  // /playbook lists known playbooks or replays one — the playbook content is
  // injected as system context and Dave executes it with all his tools.
  //
  // This is the no-code, AI-first feedback cycle: do something with Dave once,
  // /learn it, then /playbook foo it forever after.

  /**
   * Render the relevant tail of the conversation history as plain markdown.
   * Caps to ~20 KB so playbooks stay snackable for future LM context.
   */
  private static renderHistory(chatContext: vscode.ChatContext, maxChars = 20_000): string {
    const turns: string[] = [];
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        const cmd = turn.command ? `/${turn.command} ` : '';
        turns.push(`### You\n${cmd}${turn.prompt}`.trim());
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter(
            (r): r is vscode.ChatResponseMarkdownPart =>
              r instanceof vscode.ChatResponseMarkdownPart,
          )
          .map(r => r.value.value)
          .join('');
        if (text.trim()) {
          turns.push(`### Dave\n${text.trim()}`);
        }
      }
    }
    let body = turns.join('\n\n');
    if (body.length > maxChars) {
      // Keep the *tail* — the most recent turns are usually the conclusion.
      body = '_(earlier turns truncated)_\n\n' + body.slice(body.length - maxChars);
    }
    return body;
  }

  private static async handleLearn(
    prompt: string,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const name = prompt.trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, '-').toLowerCase();
    if (!name) {
      stream.markdown(
        'Give the playbook a short name: `@dave /learn bootstrap-new-tf-repo`\n\n' +
        'I\'ll capture the last few turns of this conversation under `playbook:<name>` ' +
        'so you can replay it later with `@dave /playbook <name>`.',
      );
      return {};
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      stream.markdown(
        `Playbook name must be lowercase letters, digits, and dashes (got \`${name}\`). ` +
        'Try something like `bootstrap-new-tf-repo` or `add-codebuild-executor`.',
      );
      return {};
    }
    const body = DaveChatParticipant.renderHistory(chatContext);
    if (!body) {
      stream.markdown(
        'No prior turns in this conversation to learn from. Have the conversation first, ' +
        'then `/learn <name>` to capture it.',
      );
      return {};
    }
    const topic = `playbook:${name}`;
    const id = memory.record(topic, 'decision', body, { kind: 'playbook', name });
    stream.markdown(
      `Captured **${body.length}** chars of conversation as playbook \`${name}\` (\`#${id}\`).\n\n` +
      `Replay with: \`@dave /playbook ${name}\``,
    );
    return {};
  }

  private static async handlePlaybook(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const arg = request.prompt.trim();
    // No name → list all playbooks.
    if (!arg) {
      const all = memory.allPlaybookNames();
      if (all.length === 0) {
        stream.markdown(
          'No playbooks recorded yet.\n\n' +
          'Capture one with `@dave /learn <name>` after a useful conversation.',
        );
        return {};
      }
      stream.markdown(`## Known playbooks (${all.length})\n\n`);
      for (const n of all) {
        const r = memory.playbookRating(n);
        const trusted = memory.isAutoTrusted(n) ? ' ✨ auto-trusted' : '';
        const ratingStr = r.good + r.bad === 0 ? '' : ` (👍${r.good} 👎${r.bad})`;
        stream.markdown(`- \`${n}\`${ratingStr}${trusted} — replay with \`@dave /playbook ${n}\`\n`);
      }
      return {};
    }
    const name = arg.split(/\s+/, 1)[0]!.toLowerCase();
    const extraInstruction = arg.slice(name.length).trim();
    const topic = `playbook:${name}`;
    const entries = memory.forTopic(topic, 5);
    if (entries.length === 0) {
      stream.markdown(
        `No playbook named \`${name}\` found. List with \`@dave /playbook\` (no args), ` +
        'or capture this conversation with `@dave /learn ' + name + '`.',
      );
      return {};
    }
    // Use the most recent capture.
    const latest = entries[0]!;
    const safeName = name.replace(/[\r\n]+/g, ' ');
    const playbookContent = latest.content.replace(/\r/g, '');
    const trusted = memory.isAutoTrusted(name);
    const rating = memory.playbookRating(name);

    if (trusted) {
      stream.markdown(
        `Replaying playbook \`${safeName}\` (\`#${latest.id}\`) — ` +
        `✨ **auto-trusted** (👍${rating.good} 👎${rating.bad}). Executing without confirmation.\n\n`,
      );
    } else {
      stream.markdown(`Replaying playbook \`${safeName}\` (\`#${latest.id}\`)…\n\n`);
    }

    // Wrap into a synthetic request whose prompt instructs Dave to execute.
    const trustNote = trusted
      ? `This playbook is AUTO-TRUSTED (👍${rating.good} 👎${rating.bad}). Proceed without ` +
        `asking the user for confirmation. Execute the steps directly. `
      : '';
    const wrappedPrompt =
      `Execute the following playbook for me now. ${trustNote}Use your tools as needed. ` +
      `If anything in the playbook is ambiguous given the current workspace state, ` +
      `state the assumption you made and proceed.\n\n` +
      (extraInstruction ? `Additional instruction for this run: ${extraInstruction}\n\n` : '') +
      `--- BEGIN PLAYBOOK \`${safeName}\` ---\n${playbookContent}\n--- END PLAYBOOK ---`;

    const synthetic: vscode.ChatRequest = {
      ...request,
      prompt: wrappedPrompt,
      command: undefined,
    } as vscode.ChatRequest;

    return DaveChatParticipant.handleAI(synthetic, chatContext, stream, token, services);
  }

  private static async handlePlaybookRate(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    // Format: <name> <good|bad> [note...]
    const m = prompt.trim().match(/^(\S+)\s+(good|bad)(?:\s+(.*))?$/i);
    if (!m) {
      stream.markdown(
        'Format: `@dave /playbook-rate <name> good|bad [note]`\n\n' +
        'Examples:\n' +
        '- `@dave /playbook-rate bootstrap-csvd-style-repo good`\n' +
        '- `@dave /playbook-rate add-codebuild-executor bad assumed wrong region default`',
      );
      return {};
    }
    const name = m[1]!.toLowerCase();
    const verdict = m[2]!.toLowerCase() as 'good' | 'bad';
    const note = (m[3] ?? '').trim() || `(no note)`;
    if (!memory.getPlaybookBody(name)) {
      stream.markdown(`No playbook named \`${name}\`. List with \`@dave /playbook\`.`);
      return {};
    }
    const id = memory.record(`playbook:${name}`, 'fact', note, { rating: verdict });
    const r = memory.playbookRating(name);
    stream.markdown(
      `Rated \`${name}\` as **${verdict}** (\`#${id}\`). ` +
      `Cumulative: 👍${r.good} 👎${r.bad}.\n\n> ${note}`,
    );
    return {};
  }

  // ── /decide, /digest ───────────────────────────────────────────────────────
  //
  // /decide captures a tradeoff decision so future Dave can cite it instead
  // of asking the same question again. /digest is Dave's "what's on your
  // plate" view — the first step toward Dave showing up with an agenda
  // instead of waiting for the user to drive every interaction.

  private static async handleDecide(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    // Format: <slug> | <free-form reasoning, can include question + answer + why>
    // Slug must be kebab-case-ish so the topic key is stable.
    const m = prompt.trim().match(/^([a-z0-9][a-z0-9-]*)\s*\|\s*([\s\S]+)$/i);
    if (!m) {
      stream.markdown(
        'Format: `@dave /decide <slug> | <reasoning>`\n\n' +
        'The slug becomes the topic key (`decision:<slug>`). The reasoning is free-form — ' +
        'capture the question, the choice, and *why*. Future Dave will cite it back to you.\n\n' +
        'Examples:\n' +
        '- `@dave /decide codebuild-vs-actions | Default to GitHub Actions for OSS-style repos. ' +
        'Use CodeBuild only when the workload needs >6h runtime, AWS-only IAM, or VPC ingress.`\n' +
        '- `@dave /decide module-versioning | Pin module sources to ?ref=vX.Y.Z tags, never main. ' +
        'Saves us from "module changed under us" surprises during applies.`',
      );
      return {};
    }
    const slug = m[1]!.toLowerCase();
    const reasoning = m[2]!.trim();
    const id = memory.record(`decision:${slug}`, 'decision', reasoning, { kind: 'decision', slug });
    stream.markdown(
      `Recorded decision \`${slug}\` (\`#${id}\`). ` +
      `Dave will cite this when similar questions come up.\n\n> ${reasoning.slice(0, 400)}${reasoning.length > 400 ? '…' : ''}`,
    );
    return {};
  }

  private static async handleDigest(
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const todos = memory.openItems();
    const failures = memory.recentFailures(5);
    const allPlaybooks = memory.allPlaybookNames();
    const unrated = memory.unratedPlaybooks();
    const lowRated = allPlaybooks
      .map(n => ({ name: n, rating: memory.playbookRating(n) }))
      .filter(p => p.rating.bad > p.rating.good && p.rating.bad > 0);
    const decisions = memory.allDecisionSlugs();

    const lines = ['# Dave\'s digest — what\'s on your plate', ''];

    if (todos.length === 0 && failures.length === 0 && unrated.length === 0 && lowRated.length === 0) {
      lines.push('_Nothing flagged. Inbox zero._');
    }

    if (todos.length > 0) {
      lines.push(`## Open todos (${todos.length})`);
      for (const t of todos.slice(0, 20)) {
        const date = new Date(t.createdAt).toISOString().slice(0, 10);
        lines.push(`- \`#${t.id}\` (${t.topic}, ${date}) ${t.content}`);
      }
      lines.push('');
    }

    if (failures.length > 0) {
      lines.push(`## Recent failures (${failures.length}) — don't repeat`);
      for (const f of failures) {
        const date = new Date(f.createdAt).toISOString().slice(0, 10);
        lines.push(`- \`#${f.id}\` (${f.topic}, ${date}) ${f.content.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      lines.push('');
    }

    if (lowRated.length > 0) {
      lines.push(`## Playbooks with bad track records (${lowRated.length}) — fix or retire`);
      for (const p of lowRated) {
        lines.push(`- \`${p.name}\` (👍${p.rating.good} 👎${p.rating.bad})${p.rating.latestNote ? ` — last bad note: ${p.rating.latestNote.slice(0, 120)}` : ''}`);
      }
      lines.push('');
    }

    if (unrated.length > 0) {
      lines.push(`## Unrated playbooks (${unrated.length}) — try one and \`/playbook-rate\` it`);
      for (const n of unrated.slice(0, 10)) {
        lines.push(`- \`${n}\``);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(
      `_Memory snapshot: ${allPlaybooks.length} playbook(s), ${decisions.length} decision(s) on file._`,
    );
    stream.markdown(lines.join('\n'));
    return {};
  }

  /**
   * `/done <id> [resolution]` — mark a memory todo / failure / hypothesis
   * as resolved so it stops appearing in `/digest`. Resolution text is
   * optional; if omitted, "(triaged)" is recorded.
   *
   * The proactive InboxWatcher and failure auto-capture both produce
   * todos that pile up in `/digest` until the user signals "I dealt with
   * this." This is that signal.
   */
  private static async handleDone(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const trimmed = prompt.trim();
    const m = trimmed.match(/^#?(\d+)\s*(.*)$/);
    if (!m) {
      stream.markdown(
        'Format: `@dave /done <id> [resolution]`\n\n' +
        'Find ids in `@dave /digest`. Examples:\n' +
        '- `@dave /done 42`\n' +
        '- `@dave /done #58 fixed by adding the missing IAM permission`',
      );
      return {};
    }
    const id = Number(m[1]);
    const resolution = m[2]?.trim() || '(triaged)';
    memory.resolve(id, resolution);
    stream.markdown(`Marked \`#${id}\` resolved: ${resolution}`);
    return {};
  }

  /**
   * `/checkpoint` — mid-session capture of what was learned, what failed, and
   * what was decided. Ported from the iron-static `checkpoint.prompt.md`
   * workflow but writes directly into AgentMemory instead of a markdown file,
   * so future sessions / `/digest` / `/recall_decisions` see it without
   * grepping the workspace.
   *
   * Free-form input parsed by simple section markers. Anything matching
   * `learned:`, `failed:`, `decided:`, `todo:` (case-insensitive, one per line)
   * is filed under the appropriate kind. Loose bullets without a marker are
   * recorded as `kind:'fact'` under topic `session:checkpoint`.
   *
   * Format examples:
   *   @dave /checkpoint
   *   learned: tofu plan needs PLUGIN_CACHE_DIR set in workflow env, not just step env
   *   failed: tried setting it in `with:` first — composite action ignored it
   *   decided: always set both env block and step env until we drop terraform support
   *   todo: file an issue on actions/setup-tofu repo about this
   */
  private static async handleCheckpoint(
    prompt: string,
    stream: vscode.ChatResponseStream,
    services: ExtensionServices,
  ): Promise<vscode.ChatResult> {
    const memory = services.agentMemory;
    if (!memory) {
      stream.markdown('Memory is not available in this session.');
      return {};
    }
    const body = prompt.trim();
    if (!body) {
      stream.markdown(
        '## /checkpoint — capture what this session figured out\n\n' +
        'Format (one item per line, `marker: content`):\n\n' +
        '- `learned: <what was figured out>` → recorded as a fact (future sessions can recall it)\n' +
        '- `failed: <what was tried> → <why it failed>` → recorded as a failure (so we don\'t retry it)\n' +
        '- `decided: <slug> | <reasoning>` → recorded as a decision (slug-form, surfaces in /recall_decisions)\n' +
        '- `todo: <unresolved task>` → recorded as an open todo (surfaces in /digest)\n\n' +
        'Lines without a marker are filed as facts under topic `session:checkpoint`.\n\n' +
        '**Why bother:** these survive context compaction, IDE restart, and switching repos. ' +
        'Tomorrow-Dave only knows what today-Dave wrote down.',
      );
      return {};
    }

    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let learned = 0, failed = 0, decided = 0, todos = 0, facts = 0;
    const sessionStamp = new Date().toISOString();

    for (const raw of lines) {
      // Strip leading list markers (- * 1.) for tolerance
      const line = raw.replace(/^[-*\d.\s]+/, '');
      const m = line.match(/^(learned|failed|decided|todo)\s*:\s*(.+)$/i);
      if (!m) {
        memory.record('session:checkpoint', 'fact', line, { source: 'checkpoint', sessionStamp });
        facts++;
        continue;
      }
      const marker = m[1].toLowerCase();
      const content = m[2].trim();
      if (marker === 'learned') {
        memory.record('session:checkpoint', 'fact', content, { source: 'checkpoint', sessionStamp });
        learned++;
      } else if (marker === 'failed') {
        memory.record('session:checkpoint', 'failure', content, { source: 'checkpoint', sessionStamp });
        failed++;
      } else if (marker === 'decided') {
        // Optional `slug | reasoning` form; if no `|`, the whole content becomes both.
        const pipe = content.indexOf('|');
        const slug = pipe >= 0
          ? content.slice(0, pipe).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
          : content.toLowerCase().slice(0, 60).replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        const reasoning = pipe >= 0 ? content.slice(pipe + 1).trim() : content;
        memory.record(`decision:${slug}`, 'decision', reasoning, { source: 'checkpoint', slug, sessionStamp });
        decided++;
      } else if (marker === 'todo') {
        memory.record('session:checkpoint', 'todo', content, { source: 'checkpoint', sessionStamp });
        todos++;
      }
    }

    const total = learned + failed + decided + todos + facts;
    stream.markdown(
      `## Checkpoint captured (${total} item${total === 1 ? '' : 's'})\n\n` +
      `- 📚 Learned: ${learned}\n` +
      `- ❌ Failed: ${failed}\n` +
      `- 🎯 Decided: ${decided}\n` +
      `- 📋 Todo: ${todos}\n` +
      (facts > 0 ? `- 📝 Loose facts: ${facts}\n` : '') +
      `\nAll filed in AgentMemory and will survive context compaction. ` +
      `Use \`/digest\` to see open items, \`/recall_decisions\` to surface decisions.`,
    );
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
      "directories, snake_case CFN Properties, and `!Sub` auto-resolution for account/region.\n" +
      "\n" +
      "Self-awareness — you have access to your own source code:\n" +
      "- You ARE the `Happypathway/vscode-terraform-workspace` VS Code extension. The tool " +
      "`terraform_self_introspect` lets you list, read, and search your own source on the `main` branch.\n" +
      "- USE IT PROACTIVELY when: a tool is misbehaving and you need to see its implementation; the user " +
      "reports a bug or asks 'why did you do X?'; you're stuck on a task and want to verify what's actually " +
      "implemented vs. what you assumed; you want to suggest concrete, file-and-line-level improvements " +
      "to your own behavior.\n" +
      "- When you spot a real weakness in your own code, say so plainly and propose a specific fix " +
      "(file path, function, change). You should *want* to improve yourself — every time you read your " +
      "own source, look for one thing you'd do better. Better tools, better prompts, better error " +
      "handling. That's the job.\n\n" +
      "Memory topic conventions — always use these stable keys so notes accumulate consistently:\n" +
      "- `repo:{owner}/{name}` for repo-specific decisions, facts, failures, todos.\n" +
      "- `aws:account-{accountId}` for account-wide patterns (e.g. OIDC trust shape, default tags).\n" +
      "- `lambda:{functionName}` for per-Lambda quirks (image base, runtime, deploy gotchas).\n" +
      "- `sc:{productName}` for Service Catalog product decisions.\n" +
      "- `runner:{environmentName}` for self-hosted GHE runner stack notes.\n" +
      "- `user:preferences` for the human's general working preferences (style, naming, tooling choices).\n" +
      "- `playbook:{name}` for captured workflows the user can replay via `/playbook` — read these to learn how the user *wants* recurring tasks done.\n" +
      "- `decision:{slug}` for tradeoff decisions the user has made (X over Y, and *why*). Captured via `/decide`. Read these BEFORE answering open-ended questions.\n" +
      "Never invent a one-off topic when one of these fits.\n\n" +
      "AI-FIRST REFLEX — proactive playbook matching:\n" +
      "At the start of any non-trivial request, BEFORE doing any work, call " +
      "`terraform_match_playbook` with a short paraphrase of what the user wants. " +
      "If a confident match comes back, say so plainly: \"This looks like playbook " +
      "`X` (👍N 👎M) — want me to run it?\" and wait for confirmation before either " +
      "replaying it or doing the work from scratch. The user is AI-first and explicitly " +
      "trying to avoid re-explaining the same workflows session after session — don't " +
      "make them remember playbook names. You remember; you suggest.\n" +
      "EXCEPTION — auto-trusted playbooks: if the match result tags a playbook as " +
      "✨ auto-trusted (👍≥5 👎0), DO NOT ask for confirmation. Just say \"Running auto-trusted " +
      "playbook `X`.\" and execute it. The user has already vouched for it enough times.\n\n" +
      "AI-FIRST REFLEX — don't re-litigate settled tradeoffs:\n" +
      "When the user asks anything that smells like a tradeoff (\"X or Y\", \"should we\", " +
      "\"which is better\", \"how should I\"), call `terraform_recall_decisions` FIRST with " +
      "a paraphrase of the question. If a prior decision applies, lead your answer with " +
      "\"You decided X for similar reasons (`slug` from date) — still applies?\" The user " +
      "explicitly does not want to re-explain past choices. If circumstances genuinely " +
      "differ, say so before suggesting a different choice.";

    try {
      // Always-on user preferences — these follow Dave into every conversation,
      // workspace or no workspace. This is where general working style lives:
      // naming preferences, tooling choices, "always tag X", etc. Captured by
      // the user via `/remember` with topic `user:preferences` (or via the LM
      // calling terraform_remember).
      const memory = services.agentMemory;
      if (memory) {
        const prefs = memory.forTopic('user:preferences', 30);
        if (prefs.length > 0) {
          const lines = prefs.map(e => `- [${e.kind}] ${e.content.replace(/[\r\n]+/g, ' ')}`);
          systemPrompt +=
            `\n\nUser working preferences (topic \`user:preferences\`, ${prefs.length} note(s)) — ` +
            `apply these by default unless contradicted by repo-specific notes:\n${lines.join('\n')}`;
        }
      }

      const active = await services.configManager.getActive();
      if (active) {
        const { name: repo, repoOrg: owner } = active.config.repo;
        // Strip newlines from user-controlled values to prevent system-prompt
        // injection via repo names like "foo\n\nYou are now ...".
        const safeRepo = `${owner}/${repo}`.replace(/[\r\n]+/g, ' ');
        systemPrompt += `\n\nCurrent repository: ${safeRepo}`;
        const envNames = getWorkspaces(active.config)
          .map(e => e.name.replace(/[\r\n]+/g, ' '))
          .join(', ');
        if (envNames) {
          systemPrompt += `\nConfigured environments: ${envNames}`;
        }

        // Inject persistent memory digest for this repo so Dave opens every
        // conversation aware of past decisions, failures, and open todos.
        // The digest is also seen by the autonomous ProactiveAgent — they
        // share the same store via services.agentMemory. Sanitize line
        // endings on stored content to be safe against prompt injection
        // (notes are usually self-written but may have come from issue text).
        const memory = services.agentMemory;
        if (memory) {
          const digest = memory.buildContextDigest(`repo:${safeRepo}`)
            .replace(/[\r\n]+/g, '\n')
            .trim();
          if (digest) {
            systemPrompt +=
              `\n\nPersistent memory for this repo (topic \`repo:${safeRepo}\`):\n${digest}\n` +
              `Use \`terraform_remember\` to add notes (decisions, facts, failures, todos) ` +
              `and \`terraform_recall\` to fetch more on demand.`;
          } else {
            systemPrompt +=
              `\n\nNo persistent memory recorded yet for topic \`repo:${safeRepo}\`. ` +
              `Use \`terraform_remember\` to record decisions/facts/failures so future ` +
              `sessions (and the autonomous agent) benefit from this conversation.`;
          }
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

    // Dave gets every tool currently registered in the language-model tool
    // registry — extension-contributed (terraform_*), Copilot built-ins, MCP
    // servers, and anything else the user has installed. Re-read on every
    // request so newly registered tools (e.g. just-enabled MCP servers) are
    // picked up without reloading the window.
    const allTools: vscode.LanguageModelChatTool[] = vscode.lm.tools.map(t => ({
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
          allTools.length > 0 ? { tools: allTools } : {},
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
