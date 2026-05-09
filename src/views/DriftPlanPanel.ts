import * as vscode from 'vscode';
import { DriftResult } from '../workflows/DriftDetector.js';

/**
 * Webview panel that renders the `terraform show -no-color` output from one
 * or more drifted environments in a colour-coded diff view.
 *
 * The panel parses the plan text client-side (inside the webview) so no
 * secrets or plan details travel through any LM context.
 *
 * A single panel instance is reused; calling `DriftPlanPanel.show(results)`
 * when the panel is already open simply refreshes its content.
 */
export class DriftPlanPanel {
  static readonly viewType = 'terraformWorkspace.driftPlan';
  private static instance: DriftPlanPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      DriftPlanPanel.viewType,
      'Terraform Drift — Plan Diff',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    context.subscriptions.push({ dispose: () => this.dispose() });
  }

  /** Opens (or refreshes) the panel with the given drift results. */
  static show(results: DriftResult[], context: vscode.ExtensionContext): void {
    if (!DriftPlanPanel.instance) {
      DriftPlanPanel.instance = new DriftPlanPanel(context);
    }
    DriftPlanPanel.instance.panel.reveal(vscode.ViewColumn.One);
    DriftPlanPanel.instance.render(results);
  }

  private render(results: DriftResult[]): void {
    this.panel.title = `Terraform Drift — ${results.map(r => r.envName).join(', ')}`;
    this.panel.webview.html = this.buildHtml(results);
  }

  private dispose(): void {
    DriftPlanPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private buildHtml(results: DriftResult[]): string {
    const tabs = results
      .map(
        (r, i) =>
          `<button class="tab${i === 0 ? ' active' : ''}" onclick="showTab(${i})">${this.escHtml(r.envName)}</button>`,
      )
      .join('\n');

    const panes = results
      .map((r, i) => {
        const planHtml = r.planText
          ? this.renderPlanHtml(r.planText)
          : `<p class="no-plan">Plan text unavailable for this environment. <a href="${this.escHtml(r.runUrl)}" target="_blank">View run logs on GitHub ↗</a></p>`;

        const sourceLabel = r.planSource
          ? `<span class="source-badge">${this.sourceLabel(r.planSource)}</span>`
          : '';

        return `<div class="pane${i === 0 ? ' active' : ''}" id="pane-${i}">
  <div class="pane-header">
    <strong>${this.escHtml(r.envName)}</strong>${sourceLabel}
    <a class="gh-link" href="${this.escHtml(r.runUrl)}" target="_blank">View run ↗</a>
  </div>
  <div class="plan-output">${planHtml}</div>
</div>`;
      })
      .join('\n');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terraform Drift</title>
<style>
  :root {
    --add:    #3fb950;
    --remove: #f85149;
    --change: #d29922;
    --move:   #58a6ff;
    --meta:   var(--vscode-descriptionForeground, #8b949e);
  }
  body { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
         padding: 0; margin: 0; background: var(--vscode-editor-background);
         color: var(--vscode-editor-foreground); }
  .tab-bar { display: flex; gap: 4px; padding: 8px 12px 0;
             border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .tab { background: transparent; border: 1px solid var(--vscode-panel-border);
         color: var(--vscode-foreground); padding: 4px 12px; cursor: pointer;
         border-radius: 4px 4px 0 0; font-size: 12px; }
  .tab.active { background: var(--vscode-panel-background);
                border-bottom-color: var(--vscode-panel-background);
                color: var(--vscode-foreground); font-weight: bold; }
  .pane { display: none; padding: 12px; }
  .pane.active { display: block; }
  .pane-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
                 font-size: 13px; }
  .source-badge { font-size: 10px; padding: 2px 6px;
                  background: var(--vscode-badge-background);
                  color: var(--vscode-badge-foreground); border-radius: 8px; }
  .gh-link { margin-left: auto; font-size: 11px;
             color: var(--vscode-textLink-foreground); text-decoration: none; }
  .gh-link:hover { text-decoration: underline; }
  .plan-output { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
                 font-size: 12px; line-height: 1.5; overflow-x: auto; }
  .line-add    { color: var(--add); }
  .line-remove { color: var(--remove); }
  .line-change { color: var(--change); }
  .line-move   { color: var(--move); }
  .line-meta   { color: var(--meta); }
  .no-plan     { color: var(--meta); font-style: italic; }
  .no-plan a   { color: var(--vscode-textLink-foreground); }
  .summary-bar { margin-top: 10px; font-size: 11px; color: var(--meta); }
  .sum-add    { color: var(--add); font-weight: bold; }
  .sum-remove { color: var(--remove); font-weight: bold; }
  .sum-change { color: var(--change); font-weight: bold; }
</style>
</head>
<body>
<div class="tab-bar">${tabs}</div>
${panes}
<script>
function showTab(idx) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('.pane').forEach((p, i) => p.classList.toggle('active', i === idx));
}
</script>
</body>
</html>`;
  }

  /** Converts raw `terraform show -no-color` text to colour-coded HTML spans. */
  private renderPlanHtml(raw: string): string {
    const lines = raw.split('\n');
    let adds = 0, removes = 0, changes = 0;

    const body = lines
      .map(line => {
        const esc = this.escHtml(line);
        // resource create / destroy / update header lines
        if (/^\s*\+\s/.test(line)) { adds++; return `<span class="line-add">${esc}</span>`; }
        if (/^\s*-\s/.test(line)) { removes++; return `<span class="line-remove">${esc}</span>`; }
        if (/^\s*~\s/.test(line)) { changes++; return `<span class="line-change">${esc}</span>`; }
        if (/^\s*<=\s/.test(line)) { return `<span class="line-change">${esc}</span>`; }
        // moved blocks
        if (/^\s*moved\s/i.test(line)) { return `<span class="line-move">${esc}</span>`; }
        // section headers / metadata
        if (/^(Terraform|OpenTofu|Plan:|Changes to|No changes|Refreshing|Reading)\b/i.test(line.trim())) {
          return `<span class="line-meta">${esc}</span>`;
        }
        return esc;
      })
      .join('\n');

    const summary = `<div class="summary-bar">` +
      (adds    > 0 ? `<span class="sum-add">+${adds} to add</span>  ` : '') +
      (removes > 0 ? `<span class="sum-remove">-${removes} to destroy</span>  ` : '') +
      (changes > 0 ? `<span class="sum-change">~${changes} to change</span>` : '') +
      `</div>`;

    return body + summary;
  }

  private sourceLabel(src: DriftResult['planSource']): string {
    switch (src) {
      case 'gha-artifact':    return 'GHA artifact';
      case 'gha-logs':        return 'GHA logs';
      case 'codebuild-local': return 'CodeBuild local';
      default:                return 'unknown';
    }
  }

  private escHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
