import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';



// ─── Public types ─────────────────────────────────────────────────────────────

export interface CodeSearchMatch {
  /** Snippet of the matching file content, with surrounding context */
  fragment: string;
  /** Start / end offsets within the file */
  objectType?: string;
}

export interface CodeSearchResult {
  /** Filename (e.g. "main.tf") */
  name: string;
  /** Path within the repo (e.g. "modules/vpc/main.tf") */
  path: string;
  /** Direct URL to the file on GitHub */
  htmlUrl: string;
  /** owner/repo */
  repoFullName: string;
  /** SHA of the blob */
  sha: string;
  /** Text fragments around the match (requires text-match media type) */
  fragments: string[];
}

export interface CodeSearchResponse {
  totalCount: number;
  incompleteResults: boolean;
  items: CodeSearchResult[];
}

// ─── GithubSearchClient ───────────────────────────────────────────────────────

/**
 * Wraps the GitHub Code Search API.
 *
 * Uses `Accept: application/vnd.github.text-match+json` so each result
 * includes `text_matches[].fragment` — actual file content around each match.
 * This gives the LLM real code to reason about rather than just file paths.
 *
 * Scoping to an org: appends `org:{org}` to the query qualifier.
 * Additional common qualifiers the caller can append:
 *   - `language:hcl`    — restrict to Terraform files
 *   - `path:.tf`        — only .tf files
 *   - `repo:owner/repo` — single repo
 */
export class GithubSearchClient {
  constructor(private readonly auth: GithubAuthProvider) {}

  /**
   * Search code across an organization's repos.
   *
   * @param query   Free-text query (e.g. "aws_s3_bucket replication")
   * @param org     GitHub org login — automatically appended as `org:{org}`
   * @param perPage Results per page (max 30 for code search; default 10)
   * @param qualifiers Optional extra qualifiers (e.g. ["language:hcl"])
   */
  async searchOrgCode(
    query: string,
    org: string,
    perPage = 10,
    qualifiers: string[] = [],
  ): Promise<CodeSearchResponse> {
    const token = await this.auth.getToken(false);
    if (!token) {
      return { totalCount: 0, incompleteResults: true, items: [] };
    }

    const parts = [query, ...(org ? [`org:${org}`] : []), ...qualifiers];
    const q = parts.join(' ');
    const url = `${this.auth.apiBaseUrl}/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`;

    // text-match media type returns fragment snippets; overrides the base Accept header
    const headers = { ...this.auth.ghHeaders(token), Accept: 'application/vnd.github.text-match+json' };

    const response = await this.auth.fetch(url, { headers });

    if (response.status === 403) {
      const body = await response.text();
      throw new Error(
        `GitHub Search API returned 403 — check that your token has the \`repo\` scope ` +
        `and that you have access to the \`${org}\` organization. Details: ${body}`,
      );
    }

    if (response.status === 422) {
      const body = await response.text();
      throw new Error(`GitHub Search API rejected the query (422 Unprocessable Entity). Details: ${body}`);
    }

    if (!response.ok) {
      throw new Error(`GitHub Search API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      total_count: number;
      incomplete_results: boolean;
      items: Array<{
        name: string;
        path: string;
        html_url: string;
        sha: string;
        repository: { full_name: string };
        text_matches?: Array<{ fragment: string; object_type?: string }>;
      }>;
    };

    return {
      totalCount: data.total_count,
      incompleteResults: data.incomplete_results,
      items: data.items.map(item => ({
        name: item.name,
        path: item.path,
        htmlUrl: item.html_url,
        repoFullName: item.repository.full_name,
        sha: item.sha,
        fragments: (item.text_matches ?? []).map(m => m.fragment).filter(Boolean),
      })),
    };
  }

  /**
   * Search code across a single repository.
   *
   * @param query   Free-text query
   * @param owner   Repository owner
   * @param repo    Repository name
   * @param perPage Results per page (max 30; default 10)
   */
  async searchRepoCode(
    query: string,
    owner: string,
    repo: string,
    perPage = 10,
  ): Promise<CodeSearchResponse> {
    return this.searchOrgCode(query, '', perPage, [`repo:${owner}/${repo}`].filter(Boolean));
  }
}
