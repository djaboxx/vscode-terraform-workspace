/**
 * Status bar item for Dave's open work.
 *
 * Inspired by the IRON STATIC homework scheduler — left of the bridge status,
 * shows pending todo count, click opens a QuickPick to triage. High-priority
 * todos (`meta.priority === 'high'`) tint the background warning-yellow.
 *
 * Refreshes:
 *   - On a 60s timer (cheap — just reads in-memory AgentMemory)
 *   - On explicit refresh() (call after `recordOnce` / `resolve`)
 */

import * as vscode from 'vscode';
import type { AgentMemory, MemoryEntry } from './AgentMemory.js';

const REFRESH_INTERVAL_MS = 60 * 1000;

export class DaveStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly memory: AgentMemory) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = 'terraform.dave.showInbox';
    this.item.show();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
  }

  refresh(): void {
    const open = this.memory.openItems();
    const failures = this.memory.recentFailures(50).filter(f => !f.resolvedAt);
    const total = open.length + failures.length;

    if (total === 0) {
      this.item.text = '$(sparkle) Dave';
      this.item.tooltip = new vscode.MarkdownString(
        '**Dave** — all clear.\n\n' +
        'No open todos, no recent failures.\n\n' +
        'Click for `/digest`.',
      );
      this.item.backgroundColor = undefined;
      return;
    }

    const highPriority = open.filter(e => e.meta?.priority === 'high').length;
    const icon = highPriority > 0 || failures.length > 0 ? '$(warning)' : '$(bell)';
    const parts: string[] = [];
    if (open.length > 0) parts.push(`${open.length} open`);
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    this.item.text = `${icon} Dave: ${parts.join(' · ')}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Dave's inbox** — ${total} item${total === 1 ? '' : 's'}\n\n`);
    if (open.length > 0) md.appendMarkdown(`- ${open.length} open todo${open.length === 1 ? '' : 's'}`);
    if (highPriority > 0) md.appendMarkdown(` (${highPriority} high-priority)`);
    if (open.length > 0) md.appendMarkdown('\n');
    if (failures.length > 0) md.appendMarkdown(`- ${failures.length} unresolved failure${failures.length === 1 ? '' : 's'}\n`);
    md.appendMarkdown('\nClick to triage.');
    this.item.tooltip = md;

    this.item.backgroundColor = highPriority > 0 || failures.length > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}

/**
 * QuickPick of open todos + unresolved failures. Selecting an item offers:
 *   - Mark resolved (calls memory.resolve)
 *   - Open URL (if entry has meta.url)
 *   - Open in chat (`@dave` with the entry content as context)
 */
export async function showInboxQuickPick(memory: AgentMemory, refresh: () => void): Promise<void> {
  const open = memory.openItems();
  const failures = memory.recentFailures(20).filter(f => !f.resolvedAt);
  const all: MemoryEntry[] = [...open, ...failures];

  if (all.length === 0) {
    vscode.window.showInformationMessage('Dave: nothing in the inbox. Nice.');
    return;
  }

  type Pick = vscode.QuickPickItem & { entry: MemoryEntry };
  const picks: Pick[] = all.map(e => {
    const priority = (e.meta?.priority as string) ?? '';
    const priorityIcon = priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : priority === 'low' ? '🟢' : '';
    const kindIcon = e.kind === 'failure' ? '$(error)' : e.kind === 'todo' ? '$(circle-large-outline)' : '$(question)';
    const ageMs = Date.now() - e.createdAt;
    const ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
    const age = ageDays === 0 ? 'today' : ageDays === 1 ? '1d' : `${ageDays}d`;
    return {
      label: `${kindIcon} ${priorityIcon ? priorityIcon + ' ' : ''}#${e.id} ${e.content.split('\n')[0]}`,
      description: `${e.topic} · ${age}`,
      detail: e.content.length > 120 ? e.content.slice(0, 120) + '…' : undefined,
      entry: e,
    };
  });

  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: `${all.length} item${all.length === 1 ? '' : 's'} — pick one to triage`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const entry = picked.entry;
  const url = typeof entry.meta?.url === 'string' ? entry.meta.url : undefined;
  const actions: string[] = ['Mark resolved'];
  if (url) actions.push('Open URL');
  actions.push('Discuss with @dave', 'Cancel');

  const action = await vscode.window.showQuickPick(actions, {
    placeHolder: `#${entry.id}: ${entry.content.split('\n')[0].slice(0, 60)}`,
  });
  if (!action || action === 'Cancel') return;

  if (action === 'Mark resolved') {
    const note = await vscode.window.showInputBox({
      prompt: `Resolution note for #${entry.id}`,
      placeHolder: '(optional — what did you do?)',
    });
    if (note === undefined) return; // user pressed Esc
    memory.resolve(entry.id, note || '(triaged)');
    refresh();
    vscode.window.showInformationMessage(`Marked #${entry.id} resolved.`);
    return;
  }

  if (action === 'Open URL' && url) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  if (action === 'Discuss with @dave') {
    const query = `@dave I want to handle this: #${entry.id} (${entry.topic}) — ${entry.content.split('\n')[0]}`;
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', query);
      } catch {
        vscode.window.showWarningMessage('Could not open Copilot Chat. Open it manually.');
      }
    }
  }
}
