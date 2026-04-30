import * as vscode from 'vscode';
import {
  WorkspaceConfig,
} from '../types/index.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

type PanelMessage =
  | { type: 'save'; config: WorkspaceConfig }
  | { type: 'addEnvironment' }
  | { type: 'removeEnvironment'; index: number }
  | { type: 'openRaw' }
  | { type: 'ready' };

/**
 * WebView panel that replaces the need for a Terraform workspace to configure
 * the terraform-github-workspace module inputs.
 *
 * Shows a structured form bound to `.vscode/terraform-workspace.json` in the
 * current workspace folder. Changes are written back to disk on Save.
 */
export class WorkspaceConfigPanel {
  static readonly viewType = 'terraformWorkspace.configure';
  private static instances = new Map<string, WorkspaceConfigPanel>();

  private readonly panel: vscode.WebviewPanel;
  private config: WorkspaceConfig;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly manager: WorkspaceConfigManager,
    config: WorkspaceConfig
  ) {
    this.config = config;

    this.panel = vscode.window.createWebviewPanel(
      WorkspaceConfigPanel.viewType,
      `Terraform Workspace: ${folder.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.webview.html = this.buildHtml(config);

    this.panel.webview.onDidReceiveMessage(
      (msg: PanelMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => this.dispose(),
      undefined,
      this.disposables
    );

    // Reload if file changes externally (e.g. git pull)
    manager.onDidChange(changedFolder => {
      if (changedFolder.uri.toString() === folder.uri.toString()) {
        this.refresh();
      }
    }, undefined, this.disposables);
  }

  /** Opens (or focuses) the panel for the given folder. */
  static async open(
    folder: vscode.WorkspaceFolder,
    manager: WorkspaceConfigManager,
    _context: vscode.ExtensionContext
  ): Promise<WorkspaceConfigPanel> {
    const key = folder.uri.toString();
    const existing = WorkspaceConfigPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }

    let config = await manager.read(folder);
    if (!config) {
      const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
      const compositeOrg = vsConfig.get<string>('compositeActionOrg', 'HappyPathway');
      // Parse a slug from the folder name as a best guess
      const repoSlug = `${vsConfig.get<string>('repoOrg', 'my-org')}/${folder.name}`;
      config = await manager.createDefault(folder, repoSlug, compositeOrg);
      vscode.window.showInformationMessage(
        `Created .vscode/terraform-workspace.json in ${folder.name}. Fill in the details below.`
      );
    }

    const instance = new WorkspaceConfigPanel(folder, manager, config);
    WorkspaceConfigPanel.instances.set(key, instance);
    return instance;
  }

  private async handleMessage(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Panel is ready — send current config so the form can render
        this.panel.webview.postMessage({ type: 'load', config: this.config });
        break;

      case 'save':
        this.config = msg.config;
        await this.manager.write(this.folder, this.config);
        vscode.window.showInformationMessage(
          `Saved terraform-workspace.json for ${this.folder.name}`
        );
        break;

      case 'openRaw':
        await this.manager.openInEditor(this.folder);
        break;
    }
  }

  private async refresh(): Promise<void> {
    const config = await this.manager.read(this.folder);
    if (config) {
      this.config = config;
      this.panel.webview.postMessage({ type: 'load', config });
    }
  }

  private dispose(): void {
    WorkspaceConfigPanel.instances.delete(this.folder.uri.toString());
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(_config: WorkspaceConfig): string {
    // The webview uses a message-passing model:
    // 1. On ready, it posts {type:'ready'} → host sends {type:'load', config}
    // 2. The form is rendered from the config object
    // 3. On save, it posts {type:'save', config: <full object>}
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Terraform Workspace Configuration</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-input-border, #444);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --section-bg: var(--vscode-sideBar-background, #1e1e1e);
      --secondary-btn-bg: var(--vscode-button-secondaryBackground);
      --secondary-btn-fg: var(--vscode-button-secondaryForeground);
      --tag-bg: var(--vscode-badge-background);
      --tag-fg: var(--vscode-badge-foreground);
      --error: var(--vscode-errorForeground, #f44);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
    }
    * { box-sizing: border-box; }
    body { background: var(--bg); color: var(--fg); margin: 0; padding: 0 0 80px 0; }

    .toolbar {
      position: sticky; top: 0; z-index: 100;
      background: var(--section-bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 20px;
      display: flex; gap: 8px; align-items: center;
    }
    .toolbar h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }

    .content { padding: 20px; max-width: 900px; }

    section {
      background: var(--section-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .section-header {
      padding: 10px 16px;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      user-select: none;
      display: flex; justify-content: space-between; align-items: center;
    }
    .section-body { padding: 16px; }

    .field-row {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px 16px;
      align-items: start;
      margin-bottom: 10px;
    }
    .field-row label {
      padding-top: 5px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #aaa);
      text-align: right;
    }
    .field-row .hint {
      grid-column: 2;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: -6px;
    }

    input[type=text], input[type=number], select, textarea {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 2px;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 13px;
    }
    input[type=checkbox] { width: auto; margin-top: 6px; }
    textarea { resize: vertical; min-height: 60px; }

    .tag-input-wrap {
      display: flex; flex-wrap: wrap; gap: 4px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 2px;
      padding: 4px 6px;
      min-height: 30px;
      align-items: center;
    }
    .tag {
      background: var(--tag-bg);
      color: var(--tag-fg);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 11px;
      display: flex; align-items: center; gap: 4px;
    }
    .tag button {
      background: none; border: none; cursor: pointer;
      color: inherit; padding: 0; font-size: 12px; line-height: 1;
    }
    .tag-input {
      border: none !important; background: transparent !important;
      outline: none; padding: 2px 4px !important; flex: 1; min-width: 100px;
    }

    .env-card {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .env-card-header {
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      display: flex; justify-content: space-between; align-items: center;
      cursor: pointer;
    }
    .env-card-header span { font-weight: 600; }
    .env-card-body { padding: 12px; display: none; }
    .env-card-body.open { display: block; }

    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 2px;
      padding: 5px 12px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: var(--secondary-btn-bg);
      color: var(--secondary-btn-fg);
    }
    button.danger {
      background: transparent;
      color: var(--error);
      border: 1px solid var(--error);
    }
    button.danger:hover { background: var(--error); color: #fff; }

    .kv-table { width: 100%; border-collapse: collapse; }
    .kv-table th {
      text-align: left; font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px 6px;
      font-weight: normal;
    }
    .kv-table td { padding: 2px 4px; }
    .kv-table td input { margin: 0; }
    .kv-table .remove-btn {
      background: none; border: none; cursor: pointer;
      color: var(--error); padding: 2px 6px; font-size: 14px;
    }

    .subsection { margin-top: 14px; }
    .subsection-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 4px;
    }

    .badge {
      display: inline-block;
      background: var(--tag-bg);
      color: var(--tag-fg);
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 11px;
      margin-left: 6px;
    }
  </style>
</head>
<body>
<div class="toolbar">
  <h2 id="panelTitle">Terraform Workspace Configuration</h2>
  <button class="secondary" id="btnOpenRaw">Open JSON</button>
  <button id="btnSave">Save</button>
</div>
<div class="content" id="content">
  <p style="color: var(--vscode-descriptionForeground)">Loading...</p>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let state = null;

  // ── Messaging ─────────────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'load') {
      state = msg.config;
      render();
    }
  });

  document.getElementById('btnSave').addEventListener('click', () => {
    if (!state) return;
    collectForm();
    vscode.postMessage({ type: 'save', config: state });
  });
  document.getElementById('btnOpenRaw').addEventListener('click', () => {
    vscode.postMessage({ type: 'openRaw' });
  });

  vscode.postMessage({ type: 'ready' });

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    document.getElementById('panelTitle').textContent =
      'Terraform Workspace: ' + (state.repo?.name || 'New');
    document.getElementById('content').innerHTML = buildFullForm(state);
    attachEventHandlers();
  }

  function buildFullForm(cfg) {
    return \`
      \${buildRepoSection(cfg)}
      \${buildStateSection(cfg)}
      \${buildCompositeActionsSection(cfg)}
      \${buildEnvironmentsSection(cfg)}
    \`;
  }

  // ── Repo Section ──────────────────────────────────────────────────────────
  function buildRepoSection(cfg) {
    const r = cfg.repo || {};
    return \`
    <section>
      <div class="section-header" onclick="toggleSection(this)">Repository <span>▾</span></div>
      <div class="section-body">
        \${field('name', 'Repo Name', r.name||'', 'text', 'GitHub repository name')}
        \${field('repoOrg', 'GitHub Org', r.repoOrg||'', 'text', 'Organization that owns the repo')}
        \${field('compositeActionOrg', 'Composite Action Org', cfg.compositeActionOrg||'HappyPathway', 'text', 'Org that hosts composite action repos')}
        \${field('description', 'Description', r.description||'', 'text')}
        \${checkField('createRepo', 'Create Repo', r.createRepo===true)}
        \${checkField('isPrivate', 'Private', r.isPrivate===true)}
        \${checkField('enforcePrs', 'Enforce PRs', r.enforcePrs!==false)}
        \${checkField('createCodeowners', 'Create CODEOWNERS', r.createCodeowners===true)}
        \${field('codeownersTeam', 'Codeowners Team', r.codeownersTeam||'', 'text')}
        <div class="field-row">
          <label>Admin Teams</label>
          <div>\${buildTagInput('adminTeams', r.adminTeams||[])}</div>
        </div>
        <div class="field-row">
          <label>Repo Topics</label>
          <div>\${buildTagInput('repoTopics', r.repoTopics||['terraform-managed'])}</div>
        </div>
        <div class="subsection">
          <div class="subsection-title">Repo-level Variables <span class="badge" id="badge-repoVars">\${(r.vars||[]).length}</span></div>
          \${buildKvTable('repoVars', r.vars||[], false)}
        </div>
        <div class="subsection">
          <div class="subsection-title">Repo-level Secrets <span class="badge" id="badge-repoSecrets">\${(r.secrets||[]).length}</span></div>
          \${buildKvTable('repoSecrets', r.secrets||[], true)}
        </div>
      </div>
    </section>\`;
  }

  // ── State Config Section ──────────────────────────────────────────────────
  function buildStateSection(cfg) {
    const s = cfg.stateConfig || {};
    return \`
    <section>
      <div class="section-header" onclick="toggleSection(this)">Terraform State (S3) <span>▾</span></div>
      <div class="section-body">
        \${field('stateBucket', 'S3 Bucket', s.bucket||'', 'text', 'e.g. inf-tfstate-us-gov-west-1-123456789')}
        \${field('stateRegion', 'Region', s.region||'us-gov-west-1', 'text')}
        \${field('stateKeyPrefix', 'Key Prefix', s.keyPrefix||'terraform-state-files', 'text')}
        \${field('stateDynamoTable', 'DynamoDB Table', s.dynamodbTable||'tf_remote_state', 'text')}
        \${checkField('stateSetBackend', 'Set Backend Per-Env', s.setBackend===true, 'When true, writes backend-configs/{env}.tf instead of a global backend.tf')}
      </div>
    </section>\`;
  }

  // ── Composite Actions Section ─────────────────────────────────────────────
  function buildCompositeActionsSection(cfg) {
    const a = cfg.compositeActions || {};
    return \`
    <section>
      <div class="section-header" onclick="toggleSection(this)">Composite Action Refs <span>▾</span></div>
      <div class="section-body">
        \${field('caCheckout', 'Checkout', a.checkout||'gh-actions-checkout@v4', 'text')}
        \${field('caAwsAuth', 'AWS Auth', a.awsAuth||'aws-auth@main', 'text')}
        \${field('caGhAuth', 'GH Auth', a.ghAuth||'gh-auth@main', 'text')}
        \${field('caSetupTf', 'Setup Terraform', a.setupTerraform||'gh-actions-terraform@v1', 'text')}
        \${field('caTfInit', 'Terraform Init', a.terraformInit||'terraform-init@main', 'text')}
        \${field('caTfPlan', 'Terraform Plan', a.terraformPlan||'terraform-plan@main', 'text')}
        \${field('caTfApply', 'Terraform Apply', a.terraformApply||'terraform-apply@main', 'text')}
        \${field('caS3Cleanup', 'S3 Cleanup', a.s3Cleanup||'s3-cleanup@main', 'text')}
      </div>
    </section>\`;
  }

  // ── Environments Section ──────────────────────────────────────────────────
  function buildEnvironmentsSection(cfg) {
    const envs = cfg.environments || [];
    return \`
    <section>
      <div class="section-header" onclick="toggleSection(this)">
        Environments <span class="badge">\${envs.length}</span> <span>▾</span>
      </div>
      <div class="section-body" id="envsBody">
        <div id="envCards">
          \${envs.map((e, i) => buildEnvCard(e, i)).join('')}
        </div>
        <button class="secondary" id="btnAddEnv" style="margin-top:8px">+ Add Environment</button>
      </div>
    </section>\`;
  }

  function buildEnvCard(env, index) {
    const bp = env.deploymentBranchPolicy || {};
    const rev = env.reviewers || {};
    const sc = env.stateConfig || {};
    return \`
    <div class="env-card" data-env-index="\${index}">
      <div class="env-card-header" onclick="toggleEnvCard(this)">
        <span>\${env.name || '(unnamed)'}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--vscode-descriptionForeground)">\${env.cacheBucket||''}</span>
          <button class="danger" style="padding:2px 8px;font-size:11px" onclick="removeEnv(event,\${index})">✕</button>
        </div>
      </div>
      <div class="env-card-body" id="envBody_\${index}">
        <div class="subsection">
          <div class="subsection-title">Environment</div>
          \${field('envName_'+index, 'Name', env.name||'', 'text', 'GitHub Environment name = Terraform workspace name')}
          \${field('envCacheBucket_'+index, 'Cache Bucket', env.cacheBucket||'', 'text', 'S3 bucket for plan artifact caching')}
          \${field('envRunnerGroup_'+index, 'Runner Group', env.runnerGroup||'self-hosted', 'text')}
          \${checkField('envPreventSelf_'+index, 'Prevent Self-Review', env.preventSelfReview===true)}
          \${field('envWaitTimer_'+index, 'Wait Timer (min)', env.waitTimer||'', 'number')}
          \${checkField('envCanAdmins_'+index, 'Admins Can Bypass', env.canAdminsBypass!==false)}
        </div>
        <div class="subsection">
          <div class="subsection-title">Deployment Branch Policy</div>
          \${field('envBranch_'+index, 'Branch', bp.branch||'main', 'text', 'Branch this environment deploys from')}
          \${field('envBranchPattern_'+index, 'Branch Pattern', bp.branchPattern||'', 'text', 'Wildcard pattern (overrides Branch if set)')}
          \${checkField('envCreateBranch_'+index, 'Create Branch', bp.createBranch===true)}
          \${checkField('envProtectedBranches_'+index, 'Protected Branches', bp.protectedBranches!==false)}
          \${checkField('envEnforceAdmins_'+index, 'Enforce Admins', bp.enforceAdmins===true)}
          \${checkField('envCreateBranchProtection_'+index, 'Create Branch Protection', bp.createBranchProtection!==false)}
          \${checkField('envRestrictBranches_'+index, 'Restrict Branches', bp.restrictBranches!==false)}
          \${field('envRequiredApprovals_'+index, 'Required Approvals', bp.requiredPullRequestReviews?.requiredApprovingReviewCount ?? 1, 'number')}
        </div>
        <div class="subsection">
          <div class="subsection-title">Reviewers</div>
          \${checkField('envEnforceReviewers_'+index, 'Enforce Reviewers', rev.enforceReviewers===true)}
          <div class="field-row">
            <label>Reviewer Teams</label>
            <div>\${buildTagInput('envRevTeams_'+index, rev.teams||[])}</div>
          </div>
          <div class="field-row">
            <label>Reviewer Users</label>
            <div>\${buildTagInput('envRevUsers_'+index, rev.users||[])}</div>
          </div>
        </div>
        <div class="subsection">
          <div class="subsection-title">State Config Override (optional)</div>
          \${field('envStateBucket_'+index, 'S3 Bucket', sc.bucket||'', 'text', 'Overrides global state bucket')}
          \${field('envStateRegion_'+index, 'Region', sc.region||'', 'text')}
          \${field('envStateKeyPrefix_'+index, 'Key Prefix', sc.keyPrefix||'', 'text')}
          \${field('envStateDynamo_'+index, 'DynamoDB Table', sc.dynamodbTable||'', 'text')}
          \${checkField('envStateSetBackend_'+index, 'Set Backend', sc.setBackend===true, 'Write backend-configs/\${env}.tf for this env')}
        </div>
        <div class="subsection">
          <div class="subsection-title">Environment Variables <span class="badge" id="badge-envVars_\${index}">\${(env.vars||[]).length}</span></div>
          \${buildKvTable('envVars_'+index, env.vars||[], false)}
        </div>
        <div class="subsection">
          <div class="subsection-title">Environment Secrets <span class="badge" id="badge-envSecrets_\${index}">\${(env.secrets||[]).length}</span></div>
          \${buildKvTable('envSecrets_'+index, env.secrets||[], true)}
        </div>
      </div>
    </div>\`;
  }

  // ── Field Helpers ─────────────────────────────────────────────────────────
  function field(id, label, value, type, hint) {
    return \`
    <div class="field-row">
      <label for="\${id}">\${label}</label>
      <div>
        <input type="\${type}" id="\${id}" value="\${esc(String(value||''))}" />
        \${hint ? '<div class="hint">'+esc(hint)+'</div>' : ''}
      </div>
    </div>\`;
  }

  function checkField(id, label, checked, hint) {
    return \`
    <div class="field-row">
      <label for="\${id}">\${label}</label>
      <div>
        <input type="checkbox" id="\${id}" \${checked ? 'checked' : ''} />
        \${hint ? '<div class="hint">'+esc(hint)+'</div>' : ''}
      </div>
    </div>\`;
  }

  function buildTagInput(id, tags) {
    const tagHtml = tags.map(t => \`
      <span class="tag">
        \${esc(t)}
        <button type="button" onclick="removeTag(this, '\${id}')">×</button>
      </span>\`).join('');
    return \`
    <div class="tag-input-wrap" id="tagWrap_\${id}">
      \${tagHtml}
      <input class="tag-input" id="tagInput_\${id}" placeholder="Add..." onkeydown="tagKeydown(event,'\${id}')" />
    </div>\`;
  }

  function buildKvTable(id, rows, isSecret) {
    const rowsHtml = rows.map((r, i) => \`
    <tr>
      <td><input type="text" value="\${esc(r.name||'')}" data-field="name" data-row="\${i}" data-table="\${id}" /></td>
      <td><input type="\${isSecret ? 'password' : 'text'}" value="\${esc(r.value||'')}" data-field="value" data-row="\${i}" data-table="\${id}" placeholder="\${isSecret ? '(write-only)' : ''}" /></td>
      <td><button class="remove-btn" onclick="removeKvRow(this, '\${id}', \${i})">✕</button></td>
    </tr>\`).join('');
    return \`
    <table class="kv-table" id="table_\${id}">
      <thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>
      <tbody>\${rowsHtml}</tbody>
    </table>
    <button class="secondary" style="margin-top:6px;font-size:12px;padding:3px 10px" onclick="addKvRow('\${id}', \${isSecret})">+ Add</button>\`;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Event Handlers ────────────────────────────────────────────────────────
  function attachEventHandlers() {
    document.getElementById('btnAddEnv')?.addEventListener('click', addEnv);
  }

  function toggleSection(header) {
    const body = header.nextElementSibling;
    const arrow = header.querySelector('span:last-child');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (arrow) arrow.textContent = open ? '▸' : '▾';
  }

  function toggleEnvCard(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('open');
  }

  function addEnv() {
    if (!state) return;
    state.environments = state.environments || [];
    state.environments.push({
      name: 'new-environment',
      cacheBucket: '',
      runnerGroup: 'self-hosted',
      canAdminsBypass: true,
      deploymentBranchPolicy: { branch: 'main', protectedBranches: true, restrictBranches: true, createBranchProtection: true },
      reviewers: { users: [], teams: [], enforceReviewers: false },
      stateConfig: {},
      vars: [],
      secrets: [],
    });
    render();
    // Auto-open the new card
    const cards = document.querySelectorAll('.env-card-body');
    if (cards.length) cards[cards.length-1].classList.add('open');
  }

  function removeEnv(event, index) {
    event.stopPropagation();
    if (!state) return;
    state.environments.splice(index, 1);
    render();
  }

  // Tag inputs
  function tagKeydown(event, id) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      const input = document.getElementById('tagInput_' + id);
      const val = input.value.trim().replace(/,$/, '');
      if (val) addTag(id, val);
      input.value = '';
    }
  }

  function addTag(id, value) {
    const wrap = document.getElementById('tagWrap_' + id);
    const input = document.getElementById('tagInput_' + id);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = esc(value) + '<button type="button" onclick="removeTag(this,\\''+id+'\\')">×</button>';
    wrap.insertBefore(tag, input);
  }

  function removeTag(btn, id) {
    btn.parentElement.remove();
  }

  // KV table
  function addKvRow(tableId, isSecret) {
    const tbody = document.querySelector('#table_' + tableId + ' tbody');
    const i = tbody.rows.length;
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td><input type="text" value="" data-field="name" data-row="\${i}" data-table="\${tableId}" /></td>
      <td><input type="\${isSecret ? 'password' : 'text'}" value="" data-field="value" data-row="\${i}" data-table="\${tableId}" placeholder="\${isSecret ? '(write-only)' : ''}" /></td>
      <td><button class="remove-btn" onclick="removeKvRow(this,'\${tableId}',\${i})">✕</button></td>
    \`;
    tbody.appendChild(tr);
  }

  function removeKvRow(btn, tableId, rowIndex) {
    btn.closest('tr').remove();
  }

  // ── Collect Form → state ──────────────────────────────────────────────────
  function collectForm() {
    if (!state) return;

    // Repo
    state.compositeActionOrg = val('compositeActionOrg');
    state.repo = state.repo || {};
    state.repo.name = val('name');
    state.repo.repoOrg = val('repoOrg');
    state.repo.description = val('description');
    state.repo.createRepo = checked('createRepo');
    state.repo.isPrivate = checked('isPrivate');
    state.repo.enforcePrs = checked('enforcePrs');
    state.repo.createCodeowners = checked('createCodeowners');
    state.repo.codeownersTeam = val('codeownersTeam');
    state.repo.adminTeams = getTags('adminTeams');
    state.repo.repoTopics = getTags('repoTopics');
    state.repo.vars = getKvTable('repoVars');
    state.repo.secrets = getKvTable('repoSecrets');

    // State config
    state.stateConfig = state.stateConfig || {};
    state.stateConfig.bucket = val('stateBucket') || undefined;
    state.stateConfig.region = val('stateRegion') || undefined;
    state.stateConfig.keyPrefix = val('stateKeyPrefix') || undefined;
    state.stateConfig.dynamodbTable = val('stateDynamoTable') || undefined;
    state.stateConfig.setBackend = checked('stateSetBackend');

    // Composite actions
    state.compositeActions = state.compositeActions || {};
    state.compositeActions.checkout = val('caCheckout') || undefined;
    state.compositeActions.awsAuth = val('caAwsAuth') || undefined;
    state.compositeActions.ghAuth = val('caGhAuth') || undefined;
    state.compositeActions.setupTerraform = val('caSetupTf') || undefined;
    state.compositeActions.terraformInit = val('caTfInit') || undefined;
    state.compositeActions.terraformPlan = val('caTfPlan') || undefined;
    state.compositeActions.terraformApply = val('caTfApply') || undefined;
    state.compositeActions.s3Cleanup = val('caS3Cleanup') || undefined;

    // Environments
    const envCards = document.querySelectorAll('.env-card');
    state.environments = Array.from(envCards).map((card, i) => {
      const env = state.environments[i] || {};
      env.name = val('envName_' + i);
      env.cacheBucket = val('envCacheBucket_' + i);
      env.runnerGroup = val('envRunnerGroup_' + i) || 'self-hosted';
      env.preventSelfReview = checked('envPreventSelf_' + i);
      const wt = val('envWaitTimer_' + i);
      env.waitTimer = wt ? parseInt(wt, 10) : undefined;
      env.canAdminsBypass = checked('envCanAdmins_' + i);

      env.deploymentBranchPolicy = env.deploymentBranchPolicy || {};
      env.deploymentBranchPolicy.branch = val('envBranch_' + i) || 'main';
      const bp = val('envBranchPattern_' + i);
      env.deploymentBranchPolicy.branchPattern = bp || undefined;
      env.deploymentBranchPolicy.createBranch = checked('envCreateBranch_' + i);
      env.deploymentBranchPolicy.protectedBranches = checked('envProtectedBranches_' + i);
      env.deploymentBranchPolicy.enforceAdmins = checked('envEnforceAdmins_' + i);
      env.deploymentBranchPolicy.createBranchProtection = checked('envCreateBranchProtection_' + i);
      env.deploymentBranchPolicy.restrictBranches = checked('envRestrictBranches_' + i);
      const reqApp = parseInt(val('envRequiredApprovals_' + i), 10);
      env.deploymentBranchPolicy.requiredPullRequestReviews = {
        dismissStaleReviews: true,
        requireCodeOwnerReviews: true,
        requiredApprovingReviewCount: isNaN(reqApp) ? 1 : reqApp,
      };

      env.reviewers = env.reviewers || {};
      env.reviewers.enforceReviewers = checked('envEnforceReviewers_' + i);
      env.reviewers.teams = getTags('envRevTeams_' + i);
      env.reviewers.users = getTags('envRevUsers_' + i);

      const bucket = val('envStateBucket_' + i);
      env.stateConfig = bucket ? {
        bucket,
        region: val('envStateRegion_' + i) || undefined,
        keyPrefix: val('envStateKeyPrefix_' + i) || undefined,
        dynamodbTable: val('envStateDynamo_' + i) || undefined,
        setBackend: checked('envStateSetBackend_' + i),
      } : {};

      env.vars = getKvTable('envVars_' + i);
      env.secrets = getKvTable('envSecrets_' + i);
      return env;
    });
  }

  function val(id) {
    return document.getElementById(id)?.value || '';
  }
  function checked(id) {
    return document.getElementById(id)?.checked === true;
  }
  function getTags(id) {
    const wrap = document.getElementById('tagWrap_' + id);
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll('.tag')).map(t =>
      t.textContent.replace('×', '').trim()
    );
  }
  function getKvTable(id) {
    const tbody = document.querySelector('#table_' + id + ' tbody');
    if (!tbody) return [];
    return Array.from(tbody.rows).map(row => ({
      name: row.cells[0]?.querySelector('input')?.value || '',
      value: row.cells[1]?.querySelector('input')?.value || '',
    })).filter(r => r.name);
  }
</script>
</body>
</html>`;
  }
}
