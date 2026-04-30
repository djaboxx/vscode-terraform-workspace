import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';
import { AgentMemory } from './AgentMemory.js';
import { asRecord, asString, asNumber, errorMessage } from '../util/narrow.js';

export interface RepoLearnerOptions {
  /** Orgs / users to scan. */
  owners: string[];
  /** Repo topic that opts a repo into continuous ingestion. */
  topic: string;
  /** Cap on commits inspected per repo per tick. */
  commitsPerRepo?: number;
  /** Cap on closed PRs inspected per repo per tick. */
  pullsPerRepo?: number;
  /** Cap on review comments fetched per PR. */
  reviewCommentsPerPr?: number;
  /** Cap on patch bytes recorded per file (truncated for memory hygiene). */
  patchBytesPerFile?: number;
  /** Cap on repos processed per tick across all owners. */
  reposPerTick?: number;
}

/**
 * Continuously updates the agent's knowledge from repos topic-tagged with the
 * configured learning topic (default: `learning`).
 *
 * The goal is **not** to catalog modules — it's to absorb the user's coding
 * patterns and practices so the agent can write code the user would write.
 *
 * Per-repo ingestion shape:
 *   - First encounter: convention docs (CONTRIBUTING.md, AGENTS.md,
 *     .github/copilot-instructions.md, .editorconfig). These are the user's
 *     *explicit* statements of preference — highest signal per byte.
 *   - Every tick (delta-only):
 *       * Recent commits: message body + per-file change counts + truncated
 *         patches. Captures *what* the user changed and *how*.
 *       * Recently merged/closed PRs: title + body + review comments. Reveals
 *         what gets accepted vs. requested-changes — the *implicit* style guide.
 *
 * State (last-ingested commit SHA + last-ingested PR number) is stored in
 * AgentMemory under topic `repo:{fullName}` as `__lastSha=…` / `__lastPr=…`
 * markers, derived on read. Idempotent and bandwidth-frugal.
 */
export class RepoLearner {
  constructor(
    private readonly auth: GithubAuthProvider,
    private readonly memory: AgentMemory,
    private readonly options: RepoLearnerOptions,
  ) {}

  async tick(): Promise<{ reposScanned: number; reposUpdated: number; errors: string[] }> {
    const errors: string[] = [];
    const reposPerTick = this.options.reposPerTick ?? 25;
    let reposScanned = 0;
    let reposUpdated = 0;

    for (const owner of this.options.owners) {
      let repos: Array<{ fullName: string; description: string; topics: string[]; defaultBranch: string; language: string }> = [];
      try {
        repos = await this.discoverRepos(owner);
      } catch (err) {
        errors.push(`Discover ${owner}: ${errorMessage(err)}`);
        continue;
      }

      for (const repo of repos) {
        if (reposScanned >= reposPerTick) break;
        reposScanned++;
        try {
          const updated = await this.ingestRepo(repo);
          if (updated) reposUpdated++;
        } catch (err) {
          const msg = errorMessage(err);
          errors.push(`Ingest ${repo.fullName}: ${msg}`);
          this.memory.record(`repo:${repo.fullName}`, 'failure', `Ingest failed: ${msg}`);
        }
      }
      if (reposScanned >= reposPerTick) break;
    }

    this.memory.record('learner', 'fact', `Tick scanned ${reposScanned} repo(s), updated ${reposUpdated}.`,
      { errors: errors.length });
    return { reposScanned, reposUpdated, errors };
  }

  private async discoverRepos(owner: string): Promise<Array<{ fullName: string; description: string; topics: string[]; defaultBranch: string; language: string }>> {
    const q = encodeURIComponent(`user:${owner} topic:${this.options.topic}`);
    const url = `${this.auth.apiBaseUrl}/search/repositories?q=${q}&per_page=100`;
    const response = await this.auth.fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const root = asRecord(await response.json());
    const items = Array.isArray(root.items) ? root.items : [];
    return items.map(raw => {
      const r = asRecord(raw);
      return {
        fullName: asString(r.full_name),
        description: asString(r.description),
        topics: Array.isArray(r.topics) ? r.topics.map(t => asString(t)) : [],
        defaultBranch: asString(r.default_branch, 'main'),
        language: asString(r.language),
      };
    }).filter(r => r.fullName);
  }

  private async ingestRepo(repo: { fullName: string; description: string; topics: string[]; defaultBranch: string; language: string }): Promise<boolean> {
    const memTopic = `repo:${repo.fullName}`;
    const lastSha = this.findMarker(memTopic, '__lastSha=');
    const lastPr = this.findMarker(memTopic, '__lastPr=');

    let updated = false;

    // First-time ingestion: capture *explicit* convention docs.
    if (!lastSha && !lastPr) {
      this.memory.record(memTopic, 'fact',
        `Repo ${repo.fullName} (${repo.language || 'mixed'}): ${repo.description || '(no description)'}`,
        { topics: repo.topics });

      const conventionFiles = [
        'AGENTS.md',
        'CONTRIBUTING.md',
        '.github/copilot-instructions.md',
        '.editorconfig',
      ];
      for (const path of conventionFiles) {
        const content = await this.tryFetchFile(repo.fullName, path);
        if (content) {
          this.memory.record(memTopic, 'fact',
            `Convention doc ${path}:\n${truncate(content, 4000)}`,
            { kind: 'convention', path });
          updated = true;
        }
      }
    }

    // Delta: new commits with patches.
    if (await this.ingestCommitDelta(memTopic, repo, lastSha)) updated = true;

    // Delta: recently closed PRs with review comments.
    if (await this.ingestPullDelta(memTopic, repo, lastPr)) updated = true;

    return updated;
  }

  /** Fetch commits since lastSha and record each with its patch summary. */
  private async ingestCommitDelta(
    memTopic: string,
    repo: { fullName: string; defaultBranch: string },
    lastSha: string | undefined,
  ): Promise<boolean> {
    const limit = this.options.commitsPerRepo ?? 20;
    const url = `${this.auth.apiBaseUrl}/repos/${repo.fullName}/commits?per_page=${limit}&sha=${repo.defaultBranch}`;
    const resp = await this.auth.fetch(url);
    if (!resp.ok) throw new Error(`commits HTTP ${resp.status}`);
    const list = (await resp.json()) as unknown;
    const commits = Array.isArray(list) ? list : [];
    if (commits.length === 0) return false;

    const newest = asString(asRecord(commits[0]).sha);
    if (!newest || newest === lastSha) return false;

    let newCommits = commits;
    if (lastSha) {
      const idx = commits.findIndex(c => asString(asRecord(c).sha) === lastSha);
      if (idx >= 0) newCommits = commits.slice(0, idx);
    }

    // Oldest first so the timeline reads forward.
    for (const raw of newCommits.reverse()) {
      const c = asRecord(raw);
      const sha = asString(c.sha);
      const commit = asRecord(c.commit);
      const author = asRecord(commit.author);
      const message = asString(commit.message);
      const date = asString(author.date);
      const authorName = asString(author.name, 'unknown');

      // Pull the full commit (with file patches) — patterns live in diffs.
      const detail = await this.tryFetchCommitDetail(repo.fullName, sha);
      let patchDigest = '';
      if (detail) {
        const files = Array.isArray(detail.files) ? detail.files.map(asRecord) : [];
        const fileSummaries = files.slice(0, 8).map(f => {
          const filename = asString(f.filename);
          const additions = asNumber(f.additions);
          const deletions = asNumber(f.deletions);
          const patch = asString(f.patch);
          const truncatedPatch = patch ? truncate(patch, this.options.patchBytesPerFile ?? 1500) : '';
          return `### ${filename} (+${additions}/-${deletions})\n${truncatedPatch}`;
        });
        patchDigest = fileSummaries.join('\n\n');
        if (files.length > 8) patchDigest += `\n\n…and ${files.length - 8} more file(s)`;
      }

      const subject = message.split('\n')[0];
      const body = message.includes('\n') ? message.split('\n').slice(1).join('\n').trim() : '';
      const content = [
        `[${date}] ${authorName}: ${subject}`,
        body ? `\nMessage body:\n${body}` : '',
        patchDigest ? `\nDiff:\n${patchDigest}` : '',
      ].filter(Boolean).join('\n');

      this.memory.record(memTopic, 'decision', truncate(content, 8000), {
        sha,
        htmlUrl: asString(c.html_url),
        kind: 'commit',
      });
    }

    this.memory.record(memTopic, 'fact', `__lastSha=${newest}`,
      { kind: 'state', sha: newest, ingestedAt: Date.now() });
    return true;
  }

  /** Fetch recently closed PRs (with review comments) since lastPr. */
  private async ingestPullDelta(
    memTopic: string,
    repo: { fullName: string },
    lastPr: string | undefined,
  ): Promise<boolean> {
    const limit = this.options.pullsPerRepo ?? 10;
    const url = `${this.auth.apiBaseUrl}/repos/${repo.fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=${limit}`;
    const resp = await this.auth.fetch(url);
    if (!resp.ok) return false; // many repos have no PRs — non-fatal
    const list = (await resp.json()) as unknown;
    const pulls = Array.isArray(list) ? list : [];
    if (pulls.length === 0) return false;

    const newest = asNumber(asRecord(pulls[0]).number);
    const lastN = lastPr ? Number(lastPr) : 0;
    if (!newest || newest <= lastN) return false;

    const newPulls = pulls.filter(p => asNumber(asRecord(p).number) > lastN);
    if (newPulls.length === 0) return false;

    // Oldest-first.
    for (const raw of newPulls.reverse()) {
      const p = asRecord(raw);
      const num = asNumber(p.number);
      const merged = asString(p.merged_at);
      const title = asString(p.title);
      const body = asString(p.body);
      const user = asString(asRecord(p.user).login, 'unknown');

      // Review comments — the "this is how I want things" signal.
      const reviewComments = await this.tryFetchReviewComments(repo.fullName, num);

      const content = [
        `PR #${num} ${merged ? '(merged)' : '(closed)'}: ${title}`,
        `Author: ${user}`,
        body ? `\nBody:\n${truncate(body, 2000)}` : '',
        reviewComments.length
          ? `\nReview comments:\n${reviewComments.map(c => `- ${c.author} on ${c.path}: ${truncate(c.body, 500)}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');

      this.memory.record(memTopic, 'decision', truncate(content, 6000), {
        prNumber: num,
        htmlUrl: asString(p.html_url),
        kind: 'pr',
        merged: !!merged,
      });
    }

    this.memory.record(memTopic, 'fact', `__lastPr=${newest}`,
      { kind: 'state', prNumber: newest, ingestedAt: Date.now() });
    return true;
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private async tryFetchFile(fullName: string, path: string): Promise<string | undefined> {
    try {
      const url = `${this.auth.apiBaseUrl}/repos/${fullName}/contents/${path}`;
      const resp = await this.auth.fetch(url);
      if (!resp.ok) return undefined;
      const json = asRecord(await resp.json());
      const encoding = asString(json.encoding);
      const content = asString(json.content);
      if (!content) return undefined;
      if (encoding === 'base64') return Buffer.from(content, 'base64').toString('utf8');
      return content;
    } catch {
      return undefined;
    }
  }

  private async tryFetchCommitDetail(fullName: string, sha: string): Promise<Record<string, unknown> | undefined> {
    try {
      const url = `${this.auth.apiBaseUrl}/repos/${fullName}/commits/${sha}`;
      const resp = await this.auth.fetch(url);
      if (!resp.ok) return undefined;
      return asRecord(await resp.json());
    } catch {
      return undefined;
    }
  }

  private async tryFetchReviewComments(fullName: string, prNumber: number): Promise<Array<{ author: string; path: string; body: string }>> {
    try {
      const limit = this.options.reviewCommentsPerPr ?? 20;
      const url = `${this.auth.apiBaseUrl}/repos/${fullName}/pulls/${prNumber}/comments?per_page=${limit}`;
      const resp = await this.auth.fetch(url);
      if (!resp.ok) return [];
      const list = (await resp.json()) as unknown;
      if (!Array.isArray(list)) return [];
      return list.map(raw => {
        const r = asRecord(raw);
        return {
          author: asString(asRecord(r.user).login, 'unknown'),
          path: asString(r.path),
          body: asString(r.body),
        };
      }).filter(c => c.body);
    } catch {
      return [];
    }
  }

  /** Retrieve the most recently stored marker (e.g. "__lastSha=" or "__lastPr="). */
  private findMarker(memTopic: string, prefix: string): string | undefined {
    const entries = this.memory.forTopic(memTopic, 200);
    for (const e of entries) {
      if (e.kind === 'fact' && e.content.startsWith(prefix)) {
        return e.content.slice(prefix.length);
      }
    }
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
