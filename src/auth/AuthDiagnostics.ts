import * as vscode from 'vscode';
import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';
import { WorkspaceConfigManager } from '../config/WorkspaceConfigManager.js';

/**
 * Probes the authenticated GitHub session against each scope the extension
 * needs and reports actual reachability. Distinguishes 401 (no token) from
 * 403 (token lacks scope) from 404 (resource missing) from 429 (rate limited)
 * — each implies a different remediation.
 *
 * Surfacing this as a one-shot command lets users self-diagnose the most
 * common class of "tool says not found but I can see it on github.com" bugs.
 */
export interface ScopeProbe {
  name: string;
  endpoint: string;
  status: 'ok' | 'unauthenticated' | 'forbidden' | 'not_found' | 'rate_limited' | 'error';
  httpStatus?: number;
  detail?: string;
}

export interface ScopeReport {
  hostname: string;
  user?: string;
  probes: ScopeProbe[];
  summary: 'all_good' | 'partial' | 'unauthenticated';
}

export class AuthDiagnostics {
  constructor(
    private readonly auth: GithubAuthProvider,
    private readonly configManager: WorkspaceConfigManager,
  ) {}

  async run(token?: vscode.CancellationToken): Promise<ScopeReport> {
    const session = await this.auth.getSession(true);
    const probes: ScopeProbe[] = [];

    if (!session) {
      return {
        hostname: this.auth.hostname,
        probes: [{
          name: 'session',
          endpoint: 'vscode.authentication.getSession',
          status: 'unauthenticated',
          detail: 'No active GitHub session. Run `Sign in to GitHub` in the Command Palette.',
        }],
        summary: 'unauthenticated',
      };
    }

    const accessToken = session.accessToken;
    const baseUrl = this.auth.apiBaseUrl;

    // Always test /user (sanity ping)
    probes.push(await this.probe('user', `${baseUrl}/user`, accessToken, token));

    // Try the workspace's configured org/repo if one is selected
    const active = await this.configManager.getActive().catch(() => undefined);
    const owner = active?.config.repo.repoOrg;
    const repo = active?.config.repo.name;

    if (owner) {
      probes.push(await this.probe(
        `org:${owner}`,
        `${baseUrl}/orgs/${encodeURIComponent(owner)}`,
        accessToken,
        token,
      ));
      probes.push(await this.probe(
        `org:${owner}/variables`,
        `${baseUrl}/orgs/${encodeURIComponent(owner)}/actions/variables?per_page=1`,
        accessToken,
        token,
      ));
    }
    if (owner && repo) {
      probes.push(await this.probe(
        `repo:${owner}/${repo}`,
        `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        accessToken,
        token,
      ));
      probes.push(await this.probe(
        `repo:${owner}/${repo}/environments`,
        `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments?per_page=1`,
        accessToken,
        token,
      ));
      probes.push(await this.probe(
        `repo:${owner}/${repo}/actions`,
        `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=1`,
        accessToken,
        token,
      ));
    }

    const okCount = probes.filter(p => p.status === 'ok').length;
    const summary: ScopeReport['summary'] =
      okCount === probes.length ? 'all_good'
      : okCount === 0 ? 'unauthenticated'
      : 'partial';

    return {
      hostname: this.auth.hostname,
      user: session.account.label,
      probes,
      summary,
    };
  }

  private async probe(
    name: string,
    endpoint: string,
    accessToken: string,
    token?: vscode.CancellationToken,
  ): Promise<ScopeProbe> {
    if (token?.isCancellationRequested) {
      return { name, endpoint, status: 'error', detail: 'cancelled' };
    }
    try {
      // Use the bare fetch (not the retrying wrapper) — diagnostics should
      // surface the first response, including 403, not retry past it.
      const response = await fetch(endpoint, { headers: this.auth.ghHeaders(accessToken) });
      if (response.ok) {
        return { name, endpoint, status: 'ok', httpStatus: response.status };
      }
      if (response.status === 401) {
        return { name, endpoint, status: 'unauthenticated', httpStatus: 401, detail: 'Token rejected — re-authenticate.' };
      }
      if (response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
          return { name, endpoint, status: 'rate_limited', httpStatus: 403, detail: 'Primary rate limit exhausted.' };
        }
        return {
          name, endpoint, status: 'forbidden', httpStatus: 403,
          detail: 'Token lacks the required scope. Re-authenticate with `read:org` / `repo` / `workflow`.',
        };
      }
      if (response.status === 404) {
        return {
          name, endpoint, status: 'not_found', httpStatus: 404,
          detail: 'Resource missing or invisible to this token (private repo without access?).',
        };
      }
      if (response.status === 429) {
        return { name, endpoint, status: 'rate_limited', httpStatus: 429, detail: 'Secondary rate limit.' };
      }
      return { name, endpoint, status: 'error', httpStatus: response.status, detail: response.statusText };
    } catch (err) {
      return { name, endpoint, status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Render a `ScopeReport` as a human-readable Markdown block. */
  static renderReport(report: ScopeReport): string {
    const icon = (s: ScopeProbe['status']): string => {
      switch (s) {
        case 'ok': return '✓';
        case 'unauthenticated': return '⛔';
        case 'forbidden': return '🚫';
        case 'not_found': return '❓';
        case 'rate_limited': return '⏳';
        default: return '⚠';
      }
    };
    const head = `**GitHub auth diagnostic for** \`${report.hostname}\`` +
      (report.user ? ` (signed in as \`${report.user}\`)` : '');
    const lines: string[] = [head, ''];
    for (const p of report.probes) {
      const status = p.httpStatus ? `${p.status} (HTTP ${p.httpStatus})` : p.status;
      lines.push(`- ${icon(p.status)} **${p.name}** — ${status}${p.detail ? ` · ${p.detail}` : ''}`);
    }
    lines.push('');
    lines.push(report.summary === 'all_good'
      ? '**All scopes reachable.**'
      : report.summary === 'unauthenticated'
        ? '**Not authenticated.** Run `Sign in to GitHub` and try again.'
        : '**Some scopes unreachable.** Tools touching those scopes will silently return empty results.');
    return lines.join('\n');
  }
}
