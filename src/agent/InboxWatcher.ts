import * as vscode from 'vscode';
import { AgentMemory } from './AgentMemory.js';
import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';
import { asRecord, asString, asNumber, errorMessage } from '../util/narrow.js';

/**
 * Polls GitHub for items the user probably wants to look at and records
 * them in agent memory as `kind: 'todo'` under topic `inbox`. The
 * DigestWatcher's fingerprint then surfaces them to the user.
 *
 * Currently watches:
 *   - PRs awaiting *your* review (`is:pr is:open review-requested:@me`)
 *
 * Idempotent via `recordOnce` keyed on the PR URL. Marking a todo
 * resolved (via `@dave /done <id>`) prevents re-surfacing.
 *
 * Cheap: one search API call per tick. Default tick is 30 minutes; runs
 * on focus regain too.
 */
export class InboxWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly memory: AgentMemory,
    private readonly auth: GithubAuthProvider,
    private readonly intervalMs: number = 30 * 60 * 1000,
  ) {}

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) void this.tick();
      }),
    );
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    setTimeout(() => void this.tick(), 20_000);
  }

  /** Force a poll now. */
  async forceTick(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollReviewRequests();
    } catch (err) {
      // Non-fatal — leave a memory note so the user knows the watcher
      // hit a snag but no notification spam.
      this.memory.record('inbox', 'failure', `InboxWatcher tick errored: ${errorMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async pollReviewRequests(): Promise<void> {
    // The search API understands `review-requested:@me` against the
    // authenticated user. Cheaper than per-repo scanning.
    const q = encodeURIComponent('is:pr is:open review-requested:@me archived:false');
    const url = `${this.auth.apiBaseUrl}/search/issues?q=${q}&per_page=50&sort=updated`;

    const res = await this.auth.fetch(url);
    if (!res.ok) return;
    const json = (await res.json()) as unknown;
    const root = asRecord(json);
    const items = Array.isArray(root.items) ? root.items : [];

    for (const raw of items) {
      const item = asRecord(raw);
      const htmlUrl = asString(item.html_url);
      if (!htmlUrl) continue;
      const title = asString(item.title);
      const repoMatch = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(htmlUrl);
      const repo = repoMatch?.[1] ?? 'unknown';
      const number = asNumber(item.number);
      const content = `Review requested: ${repo}#${number} — ${title} (${htmlUrl})`;
      // Idempotent — same URL never duplicates. Once you `@dave /done <id>`
      // it, the entry has `resolvedAt` and DigestWatcher.openItems() filters
      // it out. If GitHub re-surfaces the same PR we won't re-record because
      // dedupKey hits the resolved entry too, which is correct: the user
      // already triaged it.
      this.memory.recordOnce('inbox', 'todo', content, htmlUrl, {
        source: 'review-request',
        repo,
        number,
        url: htmlUrl,
      });
    }
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const d of this.disposables) d.dispose();
  }
}
