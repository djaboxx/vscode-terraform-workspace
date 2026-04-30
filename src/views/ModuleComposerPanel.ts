import * as vscode from 'vscode';
import { GithubModuleClient, TerraformModule, ModuleVariable } from '../github/GithubModuleClient.js';

// ─── Message types ────────────────────────────────────────────────────────────

/** Messages sent from the WebView to the extension host. */
type PanelToHost =
  | { type: 'ready' }
  | { type: 'fetchModules'; org: string }
  | { type: 'fetchModuleVars'; fullName: string }
  | { type: 'generate'; modules: ComposedModule[]; repoName: string; targetDirectory: string; overwrite: boolean }
  | { type: 'openUrl'; url: string };

/** Messages sent from the extension host to the WebView. */
type HostToPanel =
  | { type: 'modulesLoaded'; modules: TerraformModule[]; error?: string }
  | { type: 'moduleVarsLoaded'; fullName: string; variables: ModuleVariable[] }
  | { type: 'generated'; files: Record<string, string>; writtenCount: number; skippedCount: number }
  | { type: 'error'; message: string };

/** A module as composed by the user — alias + source + per-variable values/expose flags. */
export interface ComposedModule {
  fullName: string;
  sourceUrl: string;
  alias: string;
  inputs: Array<{ name: string; value: string; expose: boolean }>;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

/**
 * WebView panel for composing a Terraform `main.tf` from one or more module
 * repos discovered in the org.
 *
 * Workflow:
 *  1. User opens the panel (command `terraform.composeModules`).
 *  2. The panel fetches all `terraform-*` repos in the configured org.
 *  3. User picks modules to add; clicking "Add" triggers an on-demand fetch of
 *     that module's `variables.tf` via the host.
 *  4. The panel renders dynamically-typed input fields for every variable
 *     (string → text, number → number, bool → checkbox, list/map/object →
 *     textarea, any → text). Required fields are marked. Defaults are
 *     pre-filled.
 *  5. Each variable has an "Expose as variable" toggle so the composer can
 *     produce a `variables.tf` that wires the module input through a
 *     caller-supplied `var.*`.
 *  6. "Generate files" writes `main.tf` + `variables.tf` + `outputs.tf` under
 *     the active workspace folder (or `targetDirectory`).
 */
export class ModuleComposerPanel {
  static readonly viewType = 'terraformWorkspace.composeModules';
  private static instance: ModuleComposerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly moduleClient: GithubModuleClient,
    private readonly defaultOrg: string,
    private readonly activeFolder: vscode.WorkspaceFolder | undefined,
    context: vscode.ExtensionContext,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      ModuleComposerPanel.viewType,
      'Terraform Module Composer',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: PanelToHost) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    context.subscriptions.push({ dispose: () => this.dispose() });
  }

  static open(
    moduleClient: GithubModuleClient,
    defaultOrg: string,
    activeFolder: vscode.WorkspaceFolder | undefined,
    context: vscode.ExtensionContext,
  ): void {
    if (ModuleComposerPanel.instance) {
      ModuleComposerPanel.instance.panel.reveal();
      return;
    }
    ModuleComposerPanel.instance = new ModuleComposerPanel(moduleClient, defaultOrg, activeFolder, context);
  }

  private async handleMessage(msg: PanelToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postMessage({ type: 'modulesLoaded', modules: [] });
        if (this.defaultOrg) {
          void this.loadModules(this.defaultOrg);
        }
        break;

      case 'fetchModules':
        void this.loadModules(msg.org);
        break;

      case 'fetchModuleVars': {
        const [owner, repo] = msg.fullName.split('/');
        if (!owner || !repo) break;
        try {
          const variables = await this.moduleClient.fetchModuleVariables(owner, repo);
          const reply: HostToPanel = { type: 'moduleVarsLoaded', fullName: msg.fullName, variables };
          this.postMessage(reply);
        } catch (err) {
          this.postMessage({ type: 'error', message: `Failed to load variables for ${msg.fullName}: ${String(err)}` });
        }
        break;
      }

      case 'generate':
        void this.generate(msg.modules, msg.repoName, msg.targetDirectory, msg.overwrite);
        break;

      case 'openUrl':
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private async loadModules(org: string): Promise<void> {
    try {
      const modules = await this.moduleClient.listOrgModules(org);
      this.postMessage({ type: 'modulesLoaded', modules });
    } catch (err) {
      this.postMessage({ type: 'modulesLoaded', modules: [], error: String(err) });
    }
  }

  private async generate(
    modules: ComposedModule[],
    repoName: string,
    targetDirectory: string,
    overwrite: boolean,
  ): Promise<void> {
    if (!this.activeFolder) {
      this.postMessage({ type: 'error', message: 'No workspace folder open. Open a folder first.' });
      return;
    }

    const mainTfParts: string[] = [];
    const varsTfParts: string[] = [];
    const outputsTfParts: string[] = [];

    for (const mod of modules) {
      const lines: string[] = [`module "${mod.alias}" {`, `  source = "${mod.sourceUrl}"`];
      for (const inp of mod.inputs) {
        if (inp.value === '' && !inp.expose) continue;
        if (inp.expose) {
          lines.push(`  ${inp.name} = var.${mod.alias}_${inp.name}`);
          varsTfParts.push(
            `variable "${mod.alias}_${inp.name}" {\n  description = "Input ${inp.name} for module ${mod.alias}."\n}`,
          );
        } else {
          lines.push(`  ${inp.name} = ${hclLiteral(inp.value)}`);
        }
      }
      lines.push('}', '');
      mainTfParts.push(lines.join('\n'));

      // Skeleton output per module
      outputsTfParts.push(
        `# Outputs from module "${mod.alias}" — add as needed.\n` +
        `# output "${mod.alias}_example" {\n#   value = module.${mod.alias}.example_output\n# }`,
      );
    }

    // Determine target URI
    let targetUri = this.activeFolder.uri;
    const rel = targetDirectory?.trim();
    if (rel && rel.length > 0) {
      if (rel.startsWith('/') || rel.startsWith('\\') || rel.split(/[/\\]+/).includes('..')) {
        this.postMessage({ type: 'error', message: `Refusing path traversal in targetDirectory: "${rel}"` });
        return;
      }
      targetUri = vscode.Uri.joinPath(this.activeFolder.uri, ...rel.split(/[/\\]+/));
    }

    const encoder = new TextEncoder();
    const filesToWrite: Record<string, string> = {
      'main.tf': (mainTfParts.join('\n') || '# No modules added.\n'),
      'variables.tf': varsTfParts.length
        ? varsTfParts.join('\n\n') + '\n'
        : '# Exposed module variables will appear here.\n',
      'outputs.tf': outputsTfParts.join('\n\n') + '\n',
    };

    let writtenCount = 0;
    let skippedCount = 0;

    for (const [name, content] of Object.entries(filesToWrite)) {
      const uri = vscode.Uri.joinPath(targetUri, name);
      let exists = false;
      try { await vscode.workspace.fs.stat(uri); exists = true; } catch { /* not found */ }
      if (exists && !overwrite) { skippedCount++; continue; }
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
      writtenCount++;
    }

    this.postMessage({ type: 'generated', files: filesToWrite, writtenCount, skippedCount });
  }

  private postMessage(msg: HostToPanel): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    ModuleComposerPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Terraform Module Composer</title>
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
      --warn: var(--vscode-editorWarning-foreground, #e8a);
      --highlight: var(--vscode-list-activeSelectionBackground, #094771);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
    }
    * { box-sizing: border-box; }
    body { background: var(--bg); color: var(--fg); margin: 0; padding: 0 0 80px; }

    /* ── Layout ──────────────────────────────────────────────────────────── */
    .layout { display: grid; grid-template-columns: 280px 1fr; height: 100vh; }
    .sidebar {
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--section-bg);
    }
    .sidebar-header {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .sidebar-header h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .org-row { display: flex; gap: 6px; }
    .org-row input { flex: 1; }
    .module-list { flex: 1; overflow-y: auto; }
    .module-item {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      display: flex; flex-direction: column; gap: 2px;
    }
    .module-item:hover { background: var(--highlight); }
    .module-item .name { font-weight: 600; font-size: 12px; }
    .module-item .desc { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .module-item .tag { font-size: 10px; color: var(--tag-fg); background: var(--tag-bg); border-radius: 3px; padding: 1px 5px; align-self: flex-start; }
    .module-item .add-btn {
      align-self: flex-end; margin-top: 4px;
      background: var(--btn-bg); color: var(--btn-fg);
      border: none; border-radius: 2px; padding: 2px 10px; font-size: 11px; cursor: pointer;
    }
    .module-item .add-btn:hover { background: var(--btn-hover); }
    .search-input {
      width: 100%; background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 2px;
      padding: 4px 8px; font-size: 12px; font-family: inherit;
      margin-bottom: 4px;
    }

    /* ── Main pane ───────────────────────────────────────────────────────── */
    .main-pane { display: flex; flex-direction: column; overflow: hidden; }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--section-bg);
      flex-shrink: 0;
    }
    .toolbar h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }
    .modules-area { flex: 1; overflow-y: auto; padding: 16px; }

    /* ── Module card ─────────────────────────────────────────────────────── */
    .module-card {
      border: 1px solid var(--border); border-radius: 4px;
      margin-bottom: 16px; overflow: hidden;
    }
    .module-card-header {
      padding: 10px 14px;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
      display: flex; align-items: center; gap: 8px;
    }
    .module-card-header .title { flex: 1; font-weight: 600; }
    .module-card-header .source {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .module-card-header a {
      color: var(--vscode-textLink-foreground, #4af);
      font-size: 11px; cursor: pointer; text-decoration: none;
    }
    .module-card-header a:hover { text-decoration: underline; }
    .alias-row { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
    .alias-row label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .alias-row input { width: 160px; }
    .remove-card-btn {
      background: transparent; border: 1px solid var(--error); color: var(--error);
      border-radius: 2px; padding: 2px 8px; cursor: pointer; font-size: 11px;
    }
    .remove-card-btn:hover { background: var(--error); color: #fff; }

    .vars-loading { padding: 12px 14px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .vars-body { padding: 12px 14px; }
    .vars-table { width: 100%; border-collapse: collapse; }
    .vars-table th {
      text-align: left; font-size: 11px; font-weight: normal;
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px 6px; border-bottom: 1px solid var(--border);
    }
    .vars-table td { padding: 4px 6px; vertical-align: middle; }
    .vars-table td.var-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; white-space: nowrap;
    }
    .vars-table td.var-name .required { color: var(--error); margin-left: 2px; }
    .vars-table td.var-type { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .vars-table td.var-desc { font-size: 11px; color: var(--vscode-descriptionForeground); max-width: 200px; }
    .vars-table td.var-value input[type=text],
    .vars-table td.var-value input[type=number],
    .vars-table td.var-value textarea,
    .vars-table td.var-value select {
      width: 100%; background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 2px;
      padding: 3px 6px; font-family: inherit; font-size: 12px;
    }
    .vars-table td.var-value textarea { resize: vertical; min-height: 48px; font-family: var(--vscode-editor-font-family, monospace); }
    .vars-table td.var-expose { text-align: center; }
    .vars-table td.var-expose input { width: 14px; height: 14px; cursor: pointer; }
    .expose-label { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* ── Output section ──────────────────────────────────────────────────── */
    .generate-bar {
      padding: 12px 16px;
      background: var(--section-bg);
      border-top: 1px solid var(--border);
      display: flex; gap: 10px; align-items: center; flex-shrink: 0;
    }
    .generate-bar input[type=text] {
      width: 200px; background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 2px;
      padding: 4px 8px; font-family: inherit; font-size: 13px;
    }
    .generate-bar label { font-size: 12px; }
    .status-msg { font-size: 12px; color: var(--vscode-descriptionForeground); flex: 1; }

    /* ── Preview ──────────────────────────────────────────────────────────── */
    .preview-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .preview-tab {
      padding: 6px 14px; font-size: 12px; cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    .preview-tab.active { border-bottom-color: var(--btn-bg); color: var(--fg); }
    .preview-tab:not(.active) { color: var(--vscode-descriptionForeground); }
    .preview-pane { display: none; }
    .preview-pane.active { display: block; }
    pre.code-preview {
      margin: 0; padding: 12px 16px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; white-space: pre-wrap; overflow-x: auto;
    }

    /* ── Empty state ──────────────────────────────────────────────────────── */
    .empty {
      text-align: center; padding: 60px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .empty .hint { font-size: 12px; margin-top: 8px; }

    /* ── Misc ─────────────────────────────────────────────────────────────── */
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 2px; padding: 5px 12px; cursor: pointer; font-family: inherit; font-size: 13px; }
    button:hover { background: var(--btn-hover); }
    button.secondary { background: var(--secondary-btn-bg); color: var(--secondary-btn-fg); }
    .spinner { display: inline-block; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-banner {
      background: color-mix(in srgb, var(--error) 20%, transparent);
      border: 1px solid var(--error); color: var(--error);
      padding: 6px 12px; margin: 8px 16px; border-radius: 3px; font-size: 12px;
    }
  </style>
</head>
<body>
<div class="layout">

  <!-- ── Sidebar: module list ────────────────────────────────────────────── -->
  <div class="sidebar">
    <div class="sidebar-header">
      <h3>Modules <span id="moduleCount" style="font-weight:normal;color:var(--vscode-descriptionForeground)"></span></h3>
      <div class="org-row">
        <input class="search-input" id="orgInput" placeholder="GitHub org" style="margin:0" />
        <button class="secondary" id="btnFetchModules" style="padding:4px 8px;font-size:12px">Load</button>
      </div>
      <input class="search-input" id="moduleFilter" placeholder="Filter modules…" style="margin-top:6px" />
    </div>
    <div class="module-list" id="moduleList">
      <div class="empty"><span class="spinner">⟳</span> Loading…</div>
    </div>
  </div>

  <!-- ── Main pane ────────────────────────────────────────────────────────── -->
  <div class="main-pane">
    <div class="toolbar">
      <h2>Module Composer</h2>
      <button class="secondary" id="btnPreview">Preview HCL</button>
      <button id="btnGenerate">Generate files</button>
    </div>

    <div id="errorBanner" class="error-banner" style="display:none"></div>

    <div class="modules-area" id="modulesArea">
      <div class="empty">
        <div>← Pick modules from the sidebar to compose your <code>main.tf</code></div>
        <div class="hint">Variables are fetched on demand. Required inputs are marked <span style="color:var(--error)">*</span>.</div>
      </div>
    </div>

    <!-- Preview drawer (hidden until user clicks Preview) -->
    <div id="previewDrawer" style="display:none;border-top:1px solid var(--border);max-height:300px;overflow:hidden;display:flex;flex-direction:column">
      <div class="preview-tabs" id="previewTabs">
        <div class="preview-tab active" data-file="main.tf">main.tf</div>
        <div class="preview-tab" data-file="variables.tf">variables.tf</div>
        <div class="preview-tab" data-file="outputs.tf">outputs.tf</div>
      </div>
      <div style="overflow-y:auto;flex:1">
        <pre class="code-preview" id="previewCode"></pre>
      </div>
    </div>

    <div class="generate-bar">
      <label>Target dir:</label>
      <input type="text" id="targetDir" placeholder="(workspace root)" />
      <label><input type="checkbox" id="overwriteCheck" /> Overwrite</label>
      <div class="status-msg" id="statusMsg"></div>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let allModules = [];        // TerraformModule[] as loaded from host
  let composedModules = [];   // { fullName, sourceUrl, alias, variables: ModuleVariable[], inputs: {name,value,expose}[], loading }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'modulesLoaded':
        allModules = msg.modules || [];
        renderModuleList();
        if (msg.error) showError(msg.error);
        break;
      case 'moduleVarsLoaded':
        onVarsLoaded(msg.fullName, msg.variables);
        break;
      case 'generated':
        onGenerated(msg.files, msg.writtenCount, msg.skippedCount);
        break;
      case 'error':
        showError(msg.message);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  // Populate org from VS Code config (host sends it via initial state if available)
  const orgInput = document.getElementById('orgInput');
  document.getElementById('btnFetchModules').addEventListener('click', () => {
    const org = orgInput.value.trim();
    if (!org) return;
    document.getElementById('moduleList').innerHTML = '<div class="empty"><span class="spinner">⟳</span> Loading…</div>';
    vscode.postMessage({ type: 'fetchModules', org });
  });

  document.getElementById('moduleFilter').addEventListener('input', renderModuleList);
  document.getElementById('btnGenerate').addEventListener('click', doGenerate);
  document.getElementById('btnPreview').addEventListener('click', doPreview);

  // Preview tabs
  document.getElementById('previewTabs').addEventListener('click', e => {
    const tab = e.target.closest('.preview-tab');
    if (!tab) return;
    document.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderPreviewCode(tab.dataset.file, buildHclFiles());
  });

  // ── Sidebar ────────────────────────────────────────────────────────────────
  function renderModuleList() {
    const filter = document.getElementById('moduleFilter').value.toLowerCase();
    const list = document.getElementById('moduleList');
    const shown = allModules.filter(m =>
      !filter || m.name.toLowerCase().includes(filter) || (m.description||'').toLowerCase().includes(filter)
    );
    document.getElementById('moduleCount').textContent = '(' + allModules.length + ')';
    if (!shown.length) {
      list.innerHTML = '<div class="empty">No modules found.</div>';
      return;
    }
    list.innerHTML = shown.map(m => \`
      <div class="module-item" data-full="\${esc(m.fullName)}">
        <div class="name">\${esc(m.name)}</div>
        \${m.description ? '<div class="desc">'+esc(m.description)+'</div>' : ''}
        \${m.latestTag ? '<span class="tag">'+esc(m.latestTag)+'</span>' : ''}
        <button class="add-btn" onclick="addModule('\${esc(m.fullName)}')">+ Add</button>
      </div>
    \`).join('');
  }

  // ── Module Cards ───────────────────────────────────────────────────────────
  function addModule(fullName) {
    if (composedModules.find(m => m.fullName === fullName)) {
      showStatus('Module ' + fullName + ' is already in the composer.');
      return;
    }
    const meta = allModules.find(m => m.fullName === fullName);
    if (!meta) return;

    const alias = sanitizeAlias(meta.name);
    composedModules.push({ fullName, sourceUrl: meta.sourceUrl, alias, variables: [], inputs: [], loading: true });
    renderComposer();

    // Fetch variables on demand
    vscode.postMessage({ type: 'fetchModuleVars', fullName });
  }

  function onVarsLoaded(fullName, variables) {
    const mod = composedModules.find(m => m.fullName === fullName);
    if (!mod) return;
    mod.loading = false;
    mod.variables = variables;
    // Initialise inputs from variables — pre-fill defaults
    mod.inputs = variables.map(v => ({
      name: v.name,
      value: v.defaultValue !== undefined ? v.defaultValue : '',
      expose: false,
    }));
    renderComposer();
  }

  function removeModule(fullName) {
    composedModules = composedModules.filter(m => m.fullName !== fullName);
    renderComposer();
  }

  function renderComposer() {
    const area = document.getElementById('modulesArea');
    if (!composedModules.length) {
      area.innerHTML = '<div class="empty"><div>← Pick modules from the sidebar to compose your <code>main.tf</code></div><div class="hint">Variables are fetched on demand. Required inputs are marked <span style="color:var(--error)">*</span>.</div></div>';
      return;
    }
    area.innerHTML = composedModules.map(mod => buildModuleCard(mod)).join('');
  }

  function buildModuleCard(mod) {
    const meta = allModules.find(m => m.fullName === mod.fullName) || {};
    const headerInfo = \`
      <div class="module-card-header">
        <div class="title">\${esc(mod.fullName)}</div>
        <div class="alias-row">
          <label>alias:</label>
          <input type="text" value="\${esc(mod.alias)}"
            onchange="updateAlias('\${esc(mod.fullName)}', this.value)"
            style="width:140px;padding:2px 6px;font-size:11px" />
        </div>
        <a onclick="vscode.postMessage({type:'openUrl',url:'\${esc(meta.htmlUrl||'')}'})">↗ GitHub</a>
        <button class="remove-card-btn" onclick="removeModule('\${esc(mod.fullName)}')">Remove</button>
      </div>
      <div style="padding:6px 14px;font-size:11px;color:var(--vscode-descriptionForeground);background:var(--section-bg);border-bottom:1px solid var(--border)">
        source = "\${esc(mod.sourceUrl)}"
      </div>
    \`;

    let body;
    if (mod.loading) {
      body = '<div class="vars-loading"><span class="spinner">⟳</span> Fetching variables…</div>';
    } else if (!mod.variables.length) {
      body = '<div class="vars-loading" style="color:var(--vscode-descriptionForeground)">No variables declared in this module.</div>';
    } else {
      body = '<div class="vars-body">' + buildVarsTable(mod) + '</div>';
    }

    return \`<div class="module-card" data-full="\${esc(mod.fullName)}">\${headerInfo}\${body}</div>\`;
  }

  function buildVarsTable(mod) {
    const rows = mod.variables.map((v, i) => {
      const inp = mod.inputs[i] || { value: '', expose: false };
      return \`
        <tr>
          <td class="var-name">
            \${esc(v.name)}\${v.required ? '<span class="required" title="Required (no default)">*</span>' : ''}
            \${v.sensitive ? '<span title="Sensitive" style="font-size:10px;color:var(--warn)"> 🔒</span>' : ''}
          </td>
          <td class="var-type">\${esc(shortType(v.type))}</td>
          <td class="var-desc" title="\${esc(v.description)}">\${esc(truncate(v.description, 48))}</td>
          <td class="var-value">\${buildVarInput(mod.fullName, i, v, inp)}</td>
          <td class="var-expose">
            <input type="checkbox" title="Expose as var.*" \${inp.expose ? 'checked' : ''}
              onchange="updateExpose('\${esc(mod.fullName)}', \${i}, this.checked)" />
            <div class="expose-label">expose</div>
          </td>
        </tr>\`;
    }).join('');
    return \`<table class="vars-table">
      <thead><tr>
        <th>Name</th><th>Type</th><th>Description</th>
        <th style="min-width:200px">Value</th>
        <th title="Expose as input variable in variables.tf">Expose</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  }

  // Build the right input widget for a given variable type
  function buildVarInput(fullName, idx, variable, inp) {
    const id = 'vi_' + safeId(fullName) + '_' + idx;
    const base = \`onchange="updateValue('\${esc(fullName)}', \${idx}, getVal(this))"\`;
    const val = esc(inp.value || '');
    const type = (variable.type || 'any').trim().toLowerCase();

    if (type === 'bool') {
      // Boolean: true / false select
      return \`<select id="\${id}" \${base}>
        <option value="" \${inp.value===''?'selected':''}>— (use default)</option>
        <option value="true" \${inp.value==='true'?'selected':''}>true</option>
        <option value="false" \${inp.value==='false'?'selected':''}>false</option>
      </select>\`;
    }

    if (type === 'number') {
      return \`<input type="number" id="\${id}" value="\${val}" placeholder="number" \${base} />\`;
    }

    if (type.startsWith('list(') || type.startsWith('set(') || type === 'list' || type === 'set') {
      return \`<textarea id="\${id}" placeholder="One item per line" \${base}>\${val}</textarea>
        <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">One value per line — will be rendered as HCL list</div>\`;
    }

    if (type.startsWith('map(') || type === 'map') {
      return \`<textarea id="\${id}" placeholder='key = "value"&#10;key2 = "value2"' \${base}>\${val}</textarea>
        <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">key = value pairs, one per line — will be rendered as HCL map</div>\`;
    }

    if (type.startsWith('object(') || type.startsWith('tuple(')) {
      return \`<textarea id="\${id}" placeholder="Enter raw HCL expression" \${base}>\${val}</textarea>
        <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">Raw HCL — paste the value as it would appear in a .tf file</div>\`;
    }

    // string / any / unknown — plain text input
    return \`<input type="text" id="\${id}" value="\${val}"
      placeholder="\${variable.required ? 'required' : (variable.defaultValue !== undefined ? 'default: '+esc(String(variable.defaultValue)) : 'optional')}"
      \${base} />\`;
  }

  // ── State mutators (called from inline event handlers) ─────────────────────
  function updateAlias(fullName, newAlias) {
    const mod = composedModules.find(m => m.fullName === fullName);
    if (mod) mod.alias = newAlias.trim() || sanitizeAlias(mod.fullName.split('/')[1] || fullName);
  }

  function updateValue(fullName, idx, value) {
    const mod = composedModules.find(m => m.fullName === fullName);
    if (mod && mod.inputs[idx]) mod.inputs[idx].value = value;
  }

  function updateExpose(fullName, idx, expose) {
    const mod = composedModules.find(m => m.fullName === fullName);
    if (mod && mod.inputs[idx]) mod.inputs[idx].expose = expose;
  }

  function getVal(el) {
    return el.value;
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  function doGenerate() {
    if (!composedModules.length) { showError('Add at least one module first.'); return; }
    const still = composedModules.filter(m => m.loading);
    if (still.length) { showError('Still loading variables for: ' + still.map(m => m.fullName).join(', ')); return; }

    const targetDirectory = document.getElementById('targetDir').value.trim();
    const overwrite = document.getElementById('overwriteCheck').checked;
    const repoName = targetDirectory || '(workspace root)';

    vscode.postMessage({
      type: 'generate',
      modules: composedModules.map(mod => ({
        fullName: mod.fullName,
        sourceUrl: mod.sourceUrl,
        alias: mod.alias,
        inputs: mod.inputs,
      })),
      repoName,
      targetDirectory,
      overwrite,
    });
    showStatus('Generating files…');
  }

  function onGenerated(files, writtenCount, skippedCount) {
    let msg = '✅ Generated ' + writtenCount + ' file(s)';
    if (skippedCount) msg += ', skipped ' + skippedCount + ' existing';
    msg += '.';
    showStatus(msg);

    // Show preview automatically after generating
    showPreview(files);
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  function doPreview() {
    const files = buildHclFiles();
    showPreview(files);
  }

  function showPreview(files) {
    const drawer = document.getElementById('previewDrawer');
    drawer.style.display = 'flex';
    const activeTab = document.querySelector('.preview-tab.active');
    renderPreviewCode(activeTab ? activeTab.dataset.file : 'main.tf', files);
  }

  function renderPreviewCode(filename, files) {
    document.getElementById('previewCode').textContent = files[filename] || '(empty)';
  }

  function buildHclFiles() {
    const mainParts = [];
    const varParts = [];
    const outParts = [];

    for (const mod of composedModules) {
      if (mod.loading) continue;
      const lines = ['module "' + mod.alias + '" {', '  source = "' + mod.sourceUrl + '"'];
      for (const inp of mod.inputs) {
        if (inp.value === '' && !inp.expose) continue;
        if (inp.expose) {
          lines.push('  ' + inp.name + ' = var.' + mod.alias + '_' + inp.name);
          varParts.push('variable "' + mod.alias + '_' + inp.name + '" {\n  description = "Input ' + inp.name + ' for module ' + mod.alias + '."\n}');
        } else {
          const v = mod.variables.find(x => x.name === inp.name);
          lines.push('  ' + inp.name + ' = ' + hclLiteralJs(inp.value, v ? v.type : 'string'));
        }
      }
      lines.push('}', '');
      mainParts.push(lines.join('\n'));
      outParts.push('# Outputs from module "' + mod.alias + '" — add as needed.\n# output "' + mod.alias + '_example" {\n#   value = module.' + mod.alias + '.example_output\n# }');
    }

    return {
      'main.tf': mainParts.join('\n') || '# No modules added.\n',
      'variables.tf': varParts.length ? varParts.join('\n\n') + '\n' : '# Exposed module variables will appear here.\n',
      'outputs.tf': outParts.join('\n\n') + '\n',
    };
  }

  // ── HCL literal builder (JS-side, mirrors host-side hclLiteral) ────────────
  function hclLiteralJs(raw, type) {
    if (raw === '' || raw === undefined || raw === null) return 'null';
    const t = (type || 'any').trim().toLowerCase();
    if (t === 'bool') return raw === 'true' ? 'true' : 'false';
    if (t === 'number') return isNaN(Number(raw)) ? '"' + raw + '"' : raw;
    if (t.startsWith('list(') || t.startsWith('set(') || t === 'list' || t === 'set') {
      const items = raw.split('\n').map(l => l.trim()).filter(Boolean);
      return '[' + items.map(i => '"' + i.replace(/\\\\/g, '\\\\').replace(/"/g, '\\\\"') + '"').join(', ') + ']';
    }
    if (t.startsWith('map(') || t === 'map') {
      const pairs = raw.split('\n').map(l => l.trim()).filter(Boolean);
      return '{\n' + pairs.map(p => '    ' + p).join('\n') + '\n  }';
    }
    if (t.startsWith('object(') || t.startsWith('tuple(') || t === 'any') {
      // Return raw if it looks like an HCL expression; otherwise quote it
      if (/^[[{]|^(true|false|null|[0-9])/.test(raw.trim())) return raw;
      return '"' + raw.replace(/\\\\/g, '\\\\').replace(/"/g, '\\\\"') + '"';
    }
    // string — always quote
    return '"' + raw.replace(/\\\\/g, '\\\\').replace(/"/g, '\\\\"') + '"';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showError(msg) {
    const el = document.getElementById('errorBanner');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
  }
  function showStatus(msg) {
    document.getElementById('statusMsg').textContent = msg;
  }
  function sanitizeAlias(name) {
    return name.replace(/^terraform-[a-z0-9]+-/, '').replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z_]/, '_$0') || 'module';
  }
  function safeId(s) { return s.replace(/[^a-z0-9]/gi, '_'); }
  function truncate(s, n) { return !s ? '' : (s.length > n ? s.slice(0, n) + '…' : s); }
  function shortType(t) {
    if (!t) return 'any';
    if (t.length > 20) return t.slice(0, 18) + '…';
    return t;
  }
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
  }
}

// ─── HCL literal helper (host-side, mirrors the JS version) ──────────────────

/**
 * Converts a raw string value (as entered in a text/textarea field) to a
 * syntactically valid HCL literal based on the declared variable type.
 */
function hclLiteral(raw: string, type = 'string'): string {
  if (raw === '') return 'null';
  const t = type.trim().toLowerCase();

  if (t === 'bool') return raw === 'true' ? 'true' : 'false';
  if (t === 'number') return isNaN(Number(raw)) ? JSON.stringify(raw) : raw;

  if (t.startsWith('list(') || t.startsWith('set(') || t === 'list' || t === 'set') {
    const items = raw.split('\n').map(l => l.trim()).filter(Boolean);
    return '[' + items.map(i => JSON.stringify(i)).join(', ') + ']';
  }

  if (t.startsWith('map(') || t === 'map') {
    const pairs = raw.split('\n').map(l => l.trim()).filter(Boolean);
    return '{\n' + pairs.map(p => '    ' + p).join('\n') + '\n  }';
  }

  if (t.startsWith('object(') || t.startsWith('tuple(') || t === 'any') {
    // Pass through if it looks like an expression; otherwise quote it.
    if (/^[[{]|^(true|false|null|[0-9])/.test(raw.trim())) return raw;
    return JSON.stringify(raw);
  }

  // Default: string literal
  return JSON.stringify(raw);
}
