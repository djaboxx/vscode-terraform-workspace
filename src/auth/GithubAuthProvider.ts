import * as vscode from 'vscode';
import { TfOrganization } from '../types/index.js';
import { GitRemoteParser } from './GitRemoteParser.js';

const GITHUB_COM = 'github.com';
const REQUIRED_SCOPES = ['repo', 'read:org', 'workflow'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset) {
    const ms = Number(reset) * 1000 - Date.now();
    if (ms > 0) return Math.min(ms, 30_000);
  }
  return Math.min(2 ** attempt * 500, 8_000);
}

/**
 * Manages GitHub OAuth authentication and org discovery.
 *
 * Supports both github.com and GitHub Enterprise Server.  The active hostname
 * is auto-detected from git remotes in the open workspace on first use.
 *
 * github.com  → VS Code built-in `github` provider, api base https://api.github.com
 * GHE host    → VS Code built-in `github-enterprise` provider, api base https://{host}/api/v3
 *
 * The `X-GitHub-Api-Version` header is only sent for github.com — older GHE
 * versions don't support it.
 */
export class GithubAuthProvider {
  private _session: vscode.AuthenticationSession | undefined;
  private _hostname: string = GITHUB_COM;
  private _hostDetected = false;

  // ── Host detection ─────────────────────────────────────────────────────────

  /** Lazily detect the GitHub host from workspace git remotes. */
  private async ensureHostDetected(): Promise<void> {
    if (this._hostDetected) {
      return;
    }
    this._hostname = await GitRemoteParser.getHostname();
    this._hostDetected = true;
  }

  get hostname(): string {
    return this._hostname;
  }

  /** Awaits git-remote detection and returns the resolved hostname. */
  async resolveHostname(): Promise<string> {
    await this.ensureHostDetected();
    return this._hostname;
  }

  get isEnterprise(): boolean {
    return this._hostname !== GITHUB_COM;
  }

  get apiBaseUrl(): string {
    return this.isEnterprise
      ? `https://${this._hostname}/api/v3`
      : 'https://api.github.com';
  }

  /** Provider ID for vscode.authentication.getSession */
  private get authProviderId(): string {
    return this.isEnterprise ? 'github-enterprise' : 'github';
  }

  /**
   * Returns standard request headers for the GitHub API.
   * `X-GitHub-Api-Version` is omitted for GHE servers that don't support it.
   */
  ghHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };
    if (!this.isEnterprise) {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }
    return headers;
  }

  // ── Session / token ────────────────────────────────────────────────────────

  /** Returns the active GitHub session, prompting login if needed. */
  async getSession(silent = false): Promise<vscode.AuthenticationSession | undefined> {
    await this.ensureHostDetected();
    try {
      this._session = await vscode.authentication.getSession(
        this.authProviderId,
        REQUIRED_SCOPES,
        { createIfNone: !silent, silent }
      );
      return this._session;
    } catch (err) {
      if (!silent) {
        vscode.window.showErrorMessage(`GitHub authentication failed: ${String(err)}`);
      }
      return undefined;
    }
  }

  /** Returns the OAuth access token, prompting login if needed. */
  async getToken(silent = false): Promise<string | undefined> {
    const session = await this.getSession(silent);
    return session?.accessToken;
  }

  /**
   * fetch() wrapper with retry-after / secondary-rate-limit / 5xx exponential backoff.
   * Use this in place of `fetch()` for every GitHub API call so transient
   * failures don't surface as user-visible errors.
   *
   * Retries up to `maxRetries` (default 3) times on:
   *   - 429 / 403 with `x-ratelimit-remaining: 0` or `retry-after` header
   *   - 502, 503, 504 (transient gateway errors)
   *   - network errors (fetch throws)
   *
   * Honors `Retry-After` when present; otherwise uses exponential backoff
   * (500ms → 1s → 2s).
   */
  async fetch(url: string, init?: RequestInit & { maxRetries?: number }): Promise<Response> {
    const maxRetries = init?.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          if (attempt === maxRetries) return response;
          const wait = retryDelayMs(response, attempt);
          await sleep(wait);
          continue;
        }
        if (response.status >= 502 && response.status <= 504) {
          if (attempt === maxRetries) return response;
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        return response;
      } catch (err) {
        lastErr = err;
        if (attempt === maxRetries) throw err;
        await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr ?? new Error('GitHub fetch failed after retries');
  }

  /** Returns the authenticated GitHub username. */
  get username(): string | undefined {
    return this._session?.account.label;
  }

  // ── Org discovery ──────────────────────────────────────────────────────────

  /**
   * Discovers GitHub organizations by cross-referencing:
   * 1. Org names parsed from git remotes in open workspace folders
   * 2. Orgs the authenticated user is a member of (via GitHub API)
   */
  async discoverOrganizations(): Promise<TfOrganization[]> {
    const token = await this.getToken();
    if (!token) {
      return [];
    }

    const remoteOrgs = await GitRemoteParser.getOrgs();
    const repoSlugs = await GitRemoteParser.getRepoSlugs();
    const memberOrgs = await this.fetchOrgMemberships(token);
    const memberOrgSet = new Set(memberOrgs.map(o => o.toLowerCase()));

    const config = vscode.workspace.getConfiguration('terraformWorkspace');
    const compositeActionOrg = config.get<string>('compositeActionOrg', 'HappyPathway');
    const runnerGroup = config.get<string>('defaultRunnerGroup', 'self-hosted');

    const orgs: TfOrganization[] = [];
    for (const orgName of remoteOrgs) {
      if (memberOrgSet.has(orgName.toLowerCase())) {
        const orgRepos = repoSlugs.filter(s => s.startsWith(`${orgName}/`));
        orgs.push({
          id: orgName,
          name: orgName,
          repoSlugs: orgRepos,
          compositeActionOrg,
          runnerGroup,
        });
      }
    }

    return orgs;
  }

  private async fetchOrgMemberships(token: string): Promise<string[]> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/user/orgs?per_page=100`, {
        headers: this.ghHeaders(token),
      });

      if (!response.ok) {
        return [];
      }

      const orgs = (await response.json()) as Array<{ login: string }>;
      return orgs.map(o => o.login);
    } catch {
      return [];
    }
  }
}

