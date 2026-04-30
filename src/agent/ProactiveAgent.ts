import * as vscode from 'vscode';
import { AgentMemory } from './AgentMemory.js';
import { AgentTaskQueue, AgentTask } from './AgentTaskQueue.js';
import { AgentRunner, AgentRunnerOptions } from './AgentRunner.js';
import { RepoLearner } from './RepoLearner.js';
import { errorMessage } from '../util/narrow.js';

export interface ProactiveAgentOptions extends AgentRunnerOptions {
  /** Owners (orgs / users) to scan for agent-labelled issues. */
  owners: string[];
  /** Idle interval between wake-ups. Default: 10 minutes. */
  pollIntervalMs?: number;
  /** Run on focus regain in addition to the timer. */
  runOnFocus?: boolean;
  /** Maximum tasks to attempt per wake-up. */
  maxTasksPerTick?: number;
  /** Optional knowledge ingester run at the start of each tick. */
  learner?: RepoLearner;
}

/**
 * The wake-up harness. Combines a timer with focus-regain events to mark
 * the queue dirty, then drains it in `tick()` — but only one tick runs at
 * a time. Disposes cleanly with the extension.
 *
 * Status is surfaced via a status-bar item so the user always knows what
 * the agent is doing without opening any panel.
 */
export class ProactiveAgent implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private timer: NodeJS.Timeout | undefined;
  private isTicking = false;
  private dirty = true;          // start dirty so first focus/tick runs
  private cancelSource = new vscode.CancellationTokenSource();
  private enabled = false;
  private completedTaskIds = new Set<string>();

  constructor(
    private readonly memory: AgentMemory,
    private readonly taskQueue: AgentTaskQueue,
    private readonly runner: AgentRunner,
    private readonly options: ProactiveAgentOptions,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = 'terraform.agent.showStatus';
    this.disposables.push(this.statusBar);

    this.output = vscode.window.createOutputChannel('Terraform Agent');
    this.disposables.push(this.output);
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.updateStatus('idle', 'agent ready');

    const interval = this.options.pollIntervalMs ?? 10 * 60 * 1000;
    this.timer = setInterval(() => { this.dirty = true; this.maybeTick(); }, interval);

    if (this.options.runOnFocus !== false) {
      this.disposables.push(
        vscode.window.onDidChangeWindowState(e => {
          if (e.focused) this.maybeTick();
        }),
      );
    }

    // Kick off an initial tick shortly after start.
    setTimeout(() => this.maybeTick(), 5_000);
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.cancelSource.cancel();
    this.cancelSource = new vscode.CancellationTokenSource();
    this.updateStatus('off', 'agent stopped');
  }

  /** Force a tick now, ignoring the dirty flag (called from a command). */
  async forceTick(): Promise<void> {
    this.dirty = true;
    await this.maybeTick(true);
  }

  /** Re-entrancy guard around the actual work. */
  private async maybeTick(force = false): Promise<void> {
    if (!this.enabled && !force) return;
    if (this.isTicking) return;
    if (!this.dirty && !force) return;

    this.isTicking = true;
    this.dirty = false;
    try {
      await this.tick();
    } catch (err) {
      this.log(`Tick errored: ${errorMessage(err)}`);
      this.memory.record('agent', 'failure', `Tick errored: ${errorMessage(err)}`);
      this.updateStatus('error', 'agent error — see output');
    } finally {
      this.isTicking = false;
    }
  }

  /**
   * Inspect the queue, pick the most pressing untouched task, run it.
   */
  private async tick(): Promise<void> {
    // 1. Refresh knowledge first so any task that runs sees current intel.
    if (this.options.learner) {
      this.updateStatus('working', 'learning from repos');
      try {
        const result = await this.options.learner.tick();
        this.log(`Learner: scanned ${result.reposScanned} repo(s), updated ${result.reposUpdated}`);
        for (const e of result.errors.slice(0, 5)) this.log(`  ! ${e}`);
      } catch (err) {
        this.log(`Learner errored: ${errorMessage(err)}`);
      }
    }

    if (this.options.owners.length === 0) {
      this.updateStatus('idle', 'no owners configured');
      return;
    }

    this.updateStatus('working', 'scanning issue queue');
    this.log(`[${new Date().toISOString()}] Pulling issue queue from: ${this.options.owners.join(', ')}`);

    const allTasks = await this.taskQueue.pullIssueQueue(this.options.owners);
    const tasks = allTasks.filter(t => !this.completedTaskIds.has(t.id));

    if (tasks.length === 0) {
      this.updateStatus('idle', 'queue empty');
      this.log('Queue empty.');
      return;
    }

    const limit = this.options.maxTasksPerTick ?? 1;
    const selected = tasks.slice(0, limit);
    this.log(`Selected ${selected.length} task(s) of ${tasks.length} pending.`);

    for (const task of selected) {
      await this.executeOne(task);
    }

    this.updateStatus('idle', `${tasks.length - selected.length} pending`);
  }

  private async executeOne(task: AgentTask): Promise<void> {
    this.updateStatus('working', `running: ${truncate(task.title, 40)}`);
    this.log(`\n→ Task ${task.id}: ${task.title}\n  ${task.url}`);

    const outcome = await this.runner.runTask(task, this.cancelSource.token);
    this.log(`  Outcome: ${outcome.status} (${outcome.iterations} iterations, ${outcome.toolCalls.length} tool calls)`);
    this.log(`  Summary: ${outcome.summary}`);

    // Mark in-memory so we don't immediately retry within the same session.
    if (outcome.status === 'completed' || outcome.status === 'failed') {
      this.completedTaskIds.add(task.id);
    }
  }

  private updateStatus(state: 'idle' | 'working' | 'off' | 'error', detail: string): void {
    const icons: Record<typeof state, string> = {
      idle: '$(robot)',
      working: '$(sync~spin)',
      off: '$(circle-slash)',
      error: '$(error)',
    };
    this.statusBar.text = `${icons[state]} Agent: ${detail}`;
    this.statusBar.tooltip = `Terraform autonomous agent — ${state}\nClick for details.`;
    this.statusBar.show();
  }

  private log(msg: string): void {
    this.output.appendLine(msg);
  }

  showOutput(): void { this.output.show(true); }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
