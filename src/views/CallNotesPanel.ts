import * as vscode from 'vscode';
import { parseActionItems, formatActionItemsAsMarkdown } from './callNotesParser.js';

type PanelToHost =
  | { type: 'ready' }
  | { type: 'save'; content: string }
  | { type: 'generatePlan'; content: string };

type HostToPanel =
  | { type: 'saved'; uri: string }
  | { type: 'planDraft'; markdown: string }
  | { type: 'error'; message: string };

export class CallNotesPanel {
  static readonly viewType = 'terraformWorkspace.callNotes';
  private static instance: CallNotesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      CallNotesPanel.viewType,
      'Call Notes',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((m: PanelToHost) => void this.handleMessage(m), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    context.subscriptions.push({ dispose: () => this.dispose() });
  }

  static open(context: vscode.ExtensionContext): void {
    if (CallNotesPanel.instance) { CallNotesPanel.instance.panel.reveal(); return; }
    CallNotesPanel.instance = new CallNotesPanel(context);
  }

  private async handleMessage(msg: PanelToHost): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          // nothing
          break;
        case 'save':
          {
            const uri = await this.saveNotes(msg.content);
            this.postMessage({ type: 'saved', uri: uri.toString() });
          }
          break;
        case 'generatePlan':
          {
              const draft = this.buildPlanFromNotes(msg.content);
              // Open draft as an untitled markdown document for user review
              const doc = await vscode.workspace.openTextDocument({ content: draft, language: 'markdown' });
              await vscode.window.showTextDocument(doc, { preview: false });
              this.postMessage({ type: 'planDraft', markdown: draft });
          }
          break;
      }
    } catch (err) {
      this.postMessage({ type: 'error', message: String(err) });
    }
  }

  private async saveNotes(raw: string): Promise<vscode.Uri> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('Open a workspace folder first.');
    const root = folders[0].uri;
    const callnotesDir = vscode.Uri.joinPath(root, '.callnotes');
    // ensure directory exists
    try { await vscode.workspace.fs.stat(callnotesDir); } catch { await vscode.workspace.fs.createDirectory(callnotesDir); }

    const date = new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const baseName = `callnotes-${y}-${m}-${d}.md`;

    let target = vscode.Uri.joinPath(callnotesDir, baseName);
    // avoid overwrite by adding numeric suffix
    let suffix = 0;
    while (true) {
      try { await vscode.workspace.fs.stat(target); if (suffix === 0) { suffix = 1; target = vscode.Uri.joinPath(callnotesDir, `callnotes-${y}-${m}-${d}-${suffix}.md`); continue; } else { suffix++; target = vscode.Uri.joinPath(callnotesDir, `callnotes-${y}-${m}-${d}-${suffix}.md`); continue; } } catch { break; }
    }

    const md = this.renderMarkdown(raw, date);
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(target, enc.encode(md));
    return target;
  }

  private renderMarkdown(raw: string, date: Date): string {
    const header = `# Call notes — ${date.toISOString().slice(0,10)}\n\n`;
    const items = parseActionItems(raw);
    let out = header;
    out += '## Notes\n\n';
    out += raw.split(/\r?\n/).map(l => l || ' ').join('\n') + '\n\n';
    if (items.length) {
      out += '## Action Items\n\n';
      out += formatActionItemsAsMarkdown(items) + '\n\n';
    }
    out += `\n*Saved on ${new Date().toISOString()}*\n`;
    return out;
  }

  private buildPlanFromNotes(raw: string): string {
    // Simple plan: list extracted action items as checklist with brief steps
    const items = parseActionItems(raw);
    const planLines: string[] = ['# Draft Work Plan', ''];
    if (items.length === 0) {
      planLines.push('- No explicit action items detected. Review notes and add tasks.');
    } else {
      planLines.push(formatActionItemsAsMarkdown(items));
    }
    planLines.push('', '_Generated from call notes_');
    return planLines.join('\n');
  }

  private postMessage(msg: HostToPanel): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    CallNotesPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private buildHtml(): string {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Call Notes</title>
  <style>
    :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); }
    body { margin: 0; padding: 12px; font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); }
    textarea { width: 100%; height: calc(100vh - 140px); padding: 8px; font-family: var(--vscode-editor-font-family); font-size: 13px; }
    .toolbar { display:flex; gap:8px; margin-top:8px; }
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    .status { margin-left: 8px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Call Notes</h2>
  <textarea id="notes" placeholder="Type or paste call notes here..."></textarea>
  <div class="toolbar">
    <button id="save">Save notes</button>
    <button id="plan">Generate Plan</button>
    <div class="status" id="status"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('save').addEventListener('click', () => {
      const content = document.getElementById('notes').value;
      vscode.postMessage({ type: 'save', content });
      document.getElementById('status').textContent = 'Saving…';
    });
    document.getElementById('plan').addEventListener('click', () => {
      const content = document.getElementById('notes').value;
      vscode.postMessage({ type: 'generatePlan', content });
      document.getElementById('status').textContent = 'Generating plan…';
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.type) {
        case 'saved':
          document.getElementById('status').textContent = 'Saved: ' + msg.uri;
          break;
        case 'planDraft':
          document.getElementById('status').textContent = 'Plan ready — opening draft.';
          break;
        case 'error':
          document.getElementById('status').textContent = 'Error: ' + msg.message;
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
