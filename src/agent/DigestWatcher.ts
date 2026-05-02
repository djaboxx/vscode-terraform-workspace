import * as vscode from 'vscode';
import { AgentMemory } from './AgentMemory.js';

/**
 * Surfaces Dave's `/digest` unprompted when there's something new worth
 * the user's attention.
 *
 * The contract:
 *   - Computes a "fingerprint" of memory state (open todos + recent
 *     failures + low-rated playbooks).
 *   - Compares to the last fingerprint we showed the user (persisted in
 *     globalState).
 *   - If the fingerprint changed AND there's at least one item to surface
 *     AND the user hasn't snoozed, shows a non-modal notification.
 *
 * The notification has two actions:
 *   - "Show me" → opens chat with `@dave /digest` pre-filled.
 *   - "Snooze 24h" → suppresses for one day even if fingerprint changes.
 *
 * This is the seed of proactive Dave: he wakes up on focus regain and on
 * a timer, and shows up with an agenda when there is one — instead of
 * waiting for the user to ask "what's on my plate?"
 */
export class DigestWatcher implements vscode.Disposable {
  private static readonly FP_KEY = 'dave.digest.lastFingerprint';
  private static readonly AT_KEY = 'dave.digest.lastSurfacedAt';
  private static readonly SNOOZE_KEY = 'dave.digest.snoozeUntil';

  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(
    private readonly memory: AgentMemory,
    private readonly context: vscode.ExtensionContext,
    private readonly intervalMs: number = 60 * 60 * 1000, // 1 hour
  ) {}

  start(): void {
    // Wake on focus regain (cheap; we re-check fingerprint, no notification
    // unless something is actually new).
    this.disposables.push(
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) void this.check();
      }),
    );

    // Periodic wake. Even with the window minimized we still check so the
    // notification queues up for when the user comes back.
    this.timer = setInterval(() => void this.check(), this.intervalMs);

    // Initial check shortly after start — gives extension activation room
    // to settle.
    setTimeout(() => void this.check(), 15_000);
  }

  /** Force a check ignoring snooze. Used by `terraform.dave.checkDigestNow`. */
  async forceCheck(): Promise<void> {
    await this.check(true);
  }

  private async check(force = false): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      // Honor snooze unless force.
      if (!force) {
        const snoozeUntil = this.context.globalState.get<number>(DigestWatcher.SNOOZE_KEY) ?? 0;
        if (Date.now() < snoozeUntil) return;
      }

      const summary = this.computeSummary();
      if (summary.totalSignal === 0) return; // nothing to surface

      const lastFp = this.context.globalState.get<string>(DigestWatcher.FP_KEY);
      if (!force && lastFp === summary.fingerprint) return; // already shown this exact state

      const message = this.formatNotification(summary);
      const action = await vscode.window.showInformationMessage(
        message,
        'Show me',
        'Snooze 24h',
      );

      // Always record that we surfaced — even if user dismissed — so we
      // don't keep poking them with the same fingerprint.
      await this.context.globalState.update(DigestWatcher.FP_KEY, summary.fingerprint);
      await this.context.globalState.update(DigestWatcher.AT_KEY, Date.now());

      if (action === 'Show me') {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: '@dave /digest',
          });
        } catch {
          // Older / variant builds: try the string form.
          try {
            await vscode.commands.executeCommand('workbench.action.chat.open', '@dave /digest');
          } catch { /* give up silently */ }
        }
      } else if (action === 'Snooze 24h') {
        await this.context.globalState.update(
          DigestWatcher.SNOOZE_KEY,
          Date.now() + 24 * 60 * 60 * 1000,
        );
      }
    } finally {
      this.checking = false;
    }
  }

  private computeSummary(): DigestSummary {
    const todos = this.memory.openItems();
    const failures = this.memory.recentFailures(5);
    const allPb = this.memory.allPlaybookNames();
    const badPb = allPb.filter(n => {
      const r = this.memory.playbookRating(n);
      return r.bad > r.good && r.bad > 0;
    });
    const unratedPb = this.memory.unratedPlaybooks();

    // Fingerprint captures *what's currently noteworthy* — todos by id,
    // failures by id, bad playbooks by name. Adding a new failure or a
    // new bad rating changes the fingerprint and re-surfaces.
    const fingerprint = JSON.stringify({
      t: todos.map(e => e.id),
      f: failures.map(e => e.id),
      b: badPb,
    });

    return {
      todoCount: todos.length,
      failureCount: failures.length,
      badPlaybookCount: badPb.length,
      unratedPlaybookCount: unratedPb.length,
      // "Signal" excludes unrated playbooks — those are nice-to-have but
      // not worth pinging the user over on their own.
      totalSignal: todos.length + failures.length + badPb.length,
      fingerprint,
    };
  }

  private formatNotification(s: DigestSummary): string {
    const bits: string[] = [];
    if (s.failureCount > 0) bits.push(`${s.failureCount} recent failure${s.failureCount === 1 ? '' : 's'}`);
    if (s.todoCount > 0) bits.push(`${s.todoCount} open todo${s.todoCount === 1 ? '' : 's'}`);
    if (s.badPlaybookCount > 0) bits.push(`${s.badPlaybookCount} playbook${s.badPlaybookCount === 1 ? '' : 's'} needing attention`);
    return `Dave noticed: ${bits.join(', ')}.`;
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const d of this.disposables) d.dispose();
  }
}

interface DigestSummary {
  todoCount: number;
  failureCount: number;
  badPlaybookCount: number;
  unratedPlaybookCount: number;
  totalSignal: number;
  fingerprint: string;
}
