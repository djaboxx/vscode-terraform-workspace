import * as vscode from 'vscode';
import { GheRunnersClient, RunnerFullStatus } from '../runners/GheRunnersClient.js';
import { RunnerEnvironment, discoverRunnerEnvironments } from '../runners/GheRunnerConfig.js';

// ── Tree item types ────────────────────────────────────────────────────────

/** Top-level node — one per deployed runner environment. */
export class RunnerEnvironmentItem extends vscode.TreeItem {
  readonly environment: RunnerEnvironment;

  constructor(env: RunnerEnvironment, status: RunnerFullStatus | 'loading' | 'error') {
    super(env.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.environment = env;
    this.contextValue = 'runnerEnvironment';
    this.tooltip = `${env.ecsCluster} | ${env.githubOrg} | ${env.awsRegion}`;

    if (status === 'loading') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.description = 'loading…';
    } else if (status === 'error') {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      this.description = 'error';
    } else {
      const ecs = status.ecs;
      if (!ecs) {
        this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        this.description = status.ecsError ? 'ECS unavailable' : 'unknown';
      } else {
        const healthy = ecs.runningCount >= ecs.desiredCount;
        const degraded = ecs.runningCount > 0 && ecs.runningCount < ecs.desiredCount;
        if (healthy) {
          this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        } else if (degraded) {
          this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
        } else {
          this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        }
        this.description = `${ecs.runningCount}/${ecs.desiredCount} running`;
      }
    }
  }
}

/** Detail row shown as a child of a `RunnerEnvironmentItem`. */
export class RunnerDetailItem extends vscode.TreeItem {
  constructor(label: string, detail: string, icon: string, iconColor?: vscode.ThemeColor) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.contextValue = 'runnerDetail';
    this.iconPath = iconColor
      ? new vscode.ThemeIcon(icon, iconColor)
      : new vscode.ThemeIcon(icon);
  }
}

/** One self-hosted runner from the GitHub API. */
export class RunnerGithubItem extends vscode.TreeItem {
  readonly runnerId: number;

  constructor(runner: { id: number; name: string; status: string; busy: boolean; labels: string[] }) {
    super(runner.name, vscode.TreeItemCollapsibleState.None);
    this.runnerId = runner.id;
    this.contextValue = 'githubRunner';
    const online = runner.status === 'online';
    const busy = runner.busy;

    if (!online) {
      this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
      this.description = 'offline';
    } else if (busy) {
      this.iconPath = new vscode.ThemeIcon('run', new vscode.ThemeColor('charts.blue'));
      this.description = 'running a job';
    } else {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
      this.description = 'idle';
    }

    this.tooltip = runner.labels.join(', ');
  }
}

export type RunnerTreeItem = RunnerEnvironmentItem | RunnerDetailItem | RunnerGithubItem;

// ── Tree data provider ─────────────────────────────────────────────────────

export class RunnersTreeProvider
  implements vscode.TreeDataProvider<RunnerTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunnerTreeItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Status cache — keyed by env.ecsCluster */
  private _statusCache = new Map<string, RunnerFullStatus>();
  /** Whether a refresh is currently in progress per env */
  private _loading = new Set<string>();
  /** Discovered environments */
  private _environments: RunnerEnvironment[] = [];
  /** Whether we've done the first discovery pass */
  private _discovered = false;

  /** Auto-refresh timer handle */
  private _autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: GheRunnersClient) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start background auto-refresh (every 60 s). Call on extension activate.
   */
  startAutoRefresh(): vscode.Disposable {
    this._autoRefreshTimer = setInterval(() => { this.refresh(); }, 60_000);
    return { dispose: () => this.stopAutoRefresh() };
  }

  stopAutoRefresh(): void {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = null;
    }
  }

  // ── Public control ───────────────────────────────────────────────────────

  /** Trigger a full re-discovery + status refresh. */
  refresh(): void {
    this._discovered = false;
    this._statusCache.clear();
    this._loading.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh status for a single environment by key (ecsCluster).
   * Used by the "refresh this environment" command.
   */
  refreshEnvironment(key: string): void {
    this._statusCache.delete(key);
    this._loading.delete(key);
    this._onDidChangeTreeData.fire();
  }

  getEnvironments(): RunnerEnvironment[] {
    return [...this._environments];
  }

  // ── TreeDataProvider ─────────────────────────────────────────────────────

  getTreeItem(element: RunnerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RunnerTreeItem): Promise<RunnerTreeItem[]> {
    // ── Root: list environments ──────────────────────────────────────────
    if (!element) {
      if (!this._discovered) {
        this._environments = await discoverRunnerEnvironments();
        this._discovered = true;
        // Kick off background status fetch for each environment
        for (const env of this._environments) {
          this._fetchStatus(env);
        }
      }

      if (this._environments.length === 0) {
        return [
          new RunnerDetailItem(
            'No runner environments found',
            'Add ghe-runner workspace folder or configure terraformWorkspace.runners',
            'info',
          ),
        ];
      }

      return this._environments.map(env => {
        const key = env.ecsCluster;
        if (this._loading.has(key) && !this._statusCache.has(key)) {
          return new RunnerEnvironmentItem(env, 'loading');
        }
        const status = this._statusCache.get(key);
        return new RunnerEnvironmentItem(env, status ?? 'error');
      });
    }

    // ── Children of an environment node ────────────────────────────────
    if (element instanceof RunnerEnvironmentItem) {
      const env = element.environment;
      const key = env.ecsCluster;

      // Still loading
      if (this._loading.has(key) && !this._statusCache.has(key)) {
        return [new RunnerDetailItem('Fetching status…', '', 'loading~spin')];
      }

      const status = this._statusCache.get(key);
      if (!status) {
        return [new RunnerDetailItem('Status unavailable', 'click ↻ to retry', 'warning')];
      }

      const items: RunnerTreeItem[] = [];

      // ── ECS row ──────────────────────────────────────────────────────
      if (status.ecs) {
        const { runningCount, desiredCount, pendingCount } = status.ecs;
        const healthy = runningCount >= desiredCount;
        const color = healthy
          ? new vscode.ThemeColor('charts.green')
          : runningCount > 0
            ? new vscode.ThemeColor('charts.yellow')
            : new vscode.ThemeColor('charts.red');

        let ecsDetail = `${runningCount}/${desiredCount} running`;
        if (pendingCount > 0) ecsDetail += `, ${pendingCount} pending`;

        items.push(new RunnerDetailItem('ECS Tasks', ecsDetail, 'server', color));
      } else if (status.ecsError) {
        items.push(
          new RunnerDetailItem(
            'ECS',
            status.ecsError.length > 80 ? status.ecsError.slice(0, 80) + '…' : status.ecsError,
            'error',
            new vscode.ThemeColor('charts.red'),
          ),
        );
      }

      // ── Token refresh row ─────────────────────────────────────────────
      const lambdaEnabled = !!env.lambdaFunctionName;
      items.push(
        new RunnerDetailItem(
          'Token Refresh',
          lambdaEnabled ? `enabled (${env.lambdaFunctionName})` : 'disabled',
          lambdaEnabled ? 'clock' : 'warning',
          lambdaEnabled ? undefined : new vscode.ThemeColor('charts.yellow'),
        ),
      );

      // ── GitHub runners ────────────────────────────────────────────────
      if (status.githubRunners.length > 0) {
        const online = status.githubRunners.filter(r => r.status === 'online').length;
        const busy = status.githubRunners.filter(r => r.busy).length;
        items.push(
          new RunnerDetailItem(
            'GitHub Runners',
            `${online}/${status.githubRunners.length} online, ${busy} busy`,
            'github',
          ),
        );
        for (const runner of status.githubRunners) {
          items.push(new RunnerGithubItem(runner));
        }
      } else if (status.githubError) {
        items.push(
          new RunnerDetailItem('GitHub', 'auth required or API unavailable', 'github'),
        );
      } else {
        items.push(new RunnerDetailItem('GitHub Runners', 'none registered', 'github'));
      }

      // ── Region / cluster info ─────────────────────────────────────────
      items.push(new RunnerDetailItem('Cluster', env.ecsCluster, 'cloud'));
      items.push(new RunnerDetailItem('Region', env.awsRegion, 'globe'));

      const age = status.fetchedAt
        ? `fetched ${relativeTime(new Date(status.fetchedAt))}`
        : '';
      if (age) items.push(new RunnerDetailItem('Last refresh', age, 'history'));

      return items;
    }

    return [];
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Fetch status for one environment in the background, then fire a tree
   * refresh so the UI updates.
   */
  private _fetchStatus(env: RunnerEnvironment): void {
    const key = env.ecsCluster;
    if (this._loading.has(key)) return;
    this._loading.add(key);
    this._onDidChangeTreeData.fire(); // show spinner

    // Hard timeout so a hung AWS API call can't leave the spinner forever.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this._loading.delete(key);
      this._onDidChangeTreeData.fire();
    }, 15_000);

    this.client
      .getFullStatus(env)
      .then(status => {
        if (timedOut) return;
        clearTimeout(timeout);
        this._statusCache.set(key, status);
        this._loading.delete(key);
        this._onDidChangeTreeData.fire();
      })
      .catch(() => {
        if (timedOut) return;
        clearTimeout(timeout);
        this._loading.delete(key);
        this._onDidChangeTreeData.fire();
      });
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}
