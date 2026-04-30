import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';
import { asRecord, asString, asNumber } from '../util/narrow.js';

/**
 * One pulled-from-the-queue work item the agent should consider doing.
 * Sources are pluggable (Issues today; could add scheduled drift checks,
 * failed runs, dependabot PRs).
 */
export interface AgentTask {
  id: string;
  source: 'github-issue' | 'drift' | 'failed-run' | 'manual';
  title: string;
  body: string;
  /** Stable URL the agent can link back to in PRs / comments. */
  url: string;
  /** Repo slug (`owner/name`) the work targets, if known. */
  repo?: string;
  /** Free-form labels/metadata for routing. */
  labels: string[];
  createdAt: number;
}

/**
 * Pulls work for the autonomous agent from external sources. Today: GitHub
 * issues labeled with a configurable trigger label (default `agent`).
 */
export class AgentTaskQueue {
  constructor(
    private readonly auth: GithubAuthProvider,
    private readonly triggerLabel: string = 'agent',
  ) {}

  /**
   * Pull open issues across the configured orgs that carry the trigger label.
   * `owners` is a list of `org/user` slugs whose repos to scan.
   */
  async pullIssueQueue(owners: string[]): Promise<AgentTask[]> {
    if (owners.length === 0) return [];
    const tasks: AgentTask[] = [];

    for (const owner of owners) {
      // Search issues across all repos in the owner with the trigger label.
      // Uses the search API which respects token scopes.
      const q = encodeURIComponent(`is:issue is:open user:${owner} label:"${this.triggerLabel}"`);
      const url = `${this.auth.apiBaseUrl}/search/issues?q=${q}&per_page=50&sort=updated`;

      let response: Response;
      try {
        response = await this.auth.fetch(url);
      } catch {
        continue;
      }
      if (!response.ok) continue;

      const json = (await response.json()) as unknown;
      const root = asRecord(json);
      const items = Array.isArray(root.items) ? root.items : [];

      for (const raw of items) {
        const item = asRecord(raw);
        const htmlUrl = asString(item.html_url);
        const repoMatch = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(htmlUrl);
        const labels = Array.isArray(item.labels)
          ? item.labels.map(l => asString(asRecord(l).name)).filter(Boolean)
          : [];
        tasks.push({
          id: `gh-issue:${asNumber(item.id)}`,
          source: 'github-issue',
          title: asString(item.title),
          body: asString(item.body),
          url: htmlUrl,
          repo: repoMatch?.[1],
          labels,
          createdAt: Date.parse(asString(item.created_at)) || Date.now(),
        });
      }
    }

    // Most recent first.
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }
}
