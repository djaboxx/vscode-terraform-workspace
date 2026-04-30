import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ModuleVariable {
  name: string;
  type: string;
  description: string;
  /** Raw default value, or undefined if required */
  defaultValue: string | undefined;
  required: boolean;
  sensitive: boolean;
}

export interface TerraformModule {
  /** owner/repo */
  fullName: string;
  /** owner */
  owner: string;
  /** repo name, e.g. "terraform-aws-vpc" */
  name: string;
  description: string;
  /** Latest release tag (e.g. "v1.2.0"), or undefined if no releases yet */
  latestTag: string | undefined;
  /** HTTPS clone URL */
  cloneUrl: string;
  /** GitHub html_url */
  htmlUrl: string;
  /** Terraform source string: git::https://... or registry path if detected */
  sourceUrl: string;
}

// ─── GithubModuleClient ───────────────────────────────────────────────────────

/**
 * Discovers Terraform module repositories in a GitHub org and fetches their
 * variable declarations so the Module Composer panel can surface them without
 * having to clone the repo locally.
 *
 * Module repos are detected by:
 *   1. Name matching `terraform-<provider>-*` or `terraform-*`.
 *   2. Falling back to the `terraform-managed` topic search if the name-prefix
 *      list returns fewer than 5 results.
 *
 * Variable parsing is done with a lightweight regex over the raw `variables.tf`
 * content — sufficient for generating `module {}` blocks with human-provided
 * values, without needing a full HCL parser.
 */
export class GithubModuleClient {
  constructor(private readonly auth: GithubAuthProvider) {}

  /**
   * Returns all Terraform module repos in `org` sorted by name.
   * Uses the GitHub Repos search API so no local clone is needed.
   */
  async listOrgModules(org: string): Promise<TerraformModule[]> {
    const token = await this.auth.getToken(false);
    if (!token) return [];

    // All repos named terraform-* in the org are treated as modules.
    // GitHub search matches on the prefix; we then keep only repos whose name
    // actually starts with "terraform-" to exclude false positives from the
    // full-text search (e.g. repos that mention "terraform-" in their description).
    const query = `org:${encodeURIComponent(org)}+terraform-+in:name&per_page=100&sort=name`;
    const url = `${this.auth.apiBaseUrl}/search/repositories?q=${query}`;
    const headers = this.auth.ghHeaders(token);

    const res = await this.auth.fetch(url, { headers });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      items: Array<{
        full_name: string;
        owner: { login: string };
        name: string;
        description: string | null;
        clone_url: string;
        html_url: string;
      }>;
    };

    // Any repo whose name starts with "terraform-" is a module.
    const moduleItems = (data.items ?? []).filter(r => r.name.startsWith('terraform-'));

    return Promise.all(
      moduleItems.map(async r => {
        const latestTag = await this.getLatestTag(r.owner.login, r.name, headers).catch(() => undefined);
        const sourceUrl = latestTag
          ? `git::https://github.com/${r.full_name}.git?ref=${latestTag}`
          : `git::https://github.com/${r.full_name}.git`;
        return {
          fullName: r.full_name,
          owner: r.owner.login,
          name: r.name,
          description: r.description ?? '',
          latestTag,
          cloneUrl: r.clone_url,
          htmlUrl: r.html_url,
          sourceUrl,
        } satisfies TerraformModule;
      }),
    );
  }

  /**
   * Fetches the latest release tag for a repo, or the latest semver-looking
   * tag if no formal releases exist.
   */
  private async getLatestTag(owner: string, repo: string, headers: Record<string, string>): Promise<string | undefined> {
    // Try formal release first
    const relRes = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/releases/latest`,
      { headers },
    );
    if (relRes.ok) {
      const rel = (await relRes.json()) as { tag_name?: string };
      if (rel.tag_name) return rel.tag_name;
    }

    // Fall back to the first semver-looking ref in the tags list
    const tagsRes = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/tags?per_page=10`,
      { headers },
    );
    if (!tagsRes.ok) return undefined;
    const tags = (await tagsRes.json()) as Array<{ name: string }>;
    const semver = tags.find(t => /^v?\d+\.\d+/.test(t.name));
    return semver?.name;
  }

  /**
   * Fetches and parses `variables.tf` from the default branch of the given
   * module repo. Falls back to an empty list if the file is not found or
   * parsing finds nothing.
   */
  async fetchModuleVariables(owner: string, repo: string): Promise<ModuleVariable[]> {
    const token = await this.auth.getToken(false);
    if (!token) return [];
    const headers = this.auth.ghHeaders(token);

    // Try variables.tf at repo root first; some repos also use vars.tf
    for (const path of ['variables.tf', 'vars.tf']) {
      const url = `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/contents/${path}`;
      const res = await this.auth.fetch(url, { headers });
      if (!res.ok) continue;
      const data = (await res.json()) as { content?: string; encoding?: string };
      if (!data.content) continue;
      const raw = Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
      return parseVariablesTf(raw);
    }
    return [];
  }
}

// ─── variables.tf lightweight parser ─────────────────────────────────────────

/**
 * Extracts variable declarations from a `variables.tf` string using regex.
 *
 * Handles the most common patterns:
 *   variable "name" {
 *     description = "..."
 *     type        = string | number | bool | list(...) | map(...) | any
 *     default     = ...
 *     sensitive   = true|false
 *   }
 *
 * Does NOT handle nested object types or complex defaults with braces —
 * those are returned as opaque strings.
 */
export function parseVariablesTf(content: string): ModuleVariable[] {
  const variables: ModuleVariable[] = [];

  // Split into variable blocks: variable "name" { ... }
  // Uses a simple brace counter to handle multi-line blocks correctly.
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const headerMatch = lines[i].match(/^\s*variable\s+"([^"]+)"\s*\{/);
    if (!headerMatch) { i++; continue; }

    const varName = headerMatch[1];
    let depth = 1;
    const blockLines: string[] = [];
    i++;

    while (i < lines.length && depth > 0) {
      const line = lines[i];
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth > 0) blockLines.push(line);
      i++;
    }

    const block = blockLines.join('\n');

    const descMatch = block.match(/description\s*=\s*"([^"]*)"/);
    const typeMatch = block.match(/type\s*=\s*(.+?)(?:\n|$)/);
    const sensitiveMatch = block.match(/sensitive\s*=\s*(true|false)/);

    // Default extraction: handle strings, numbers, booleans, null, and lists/maps
    const defaultMatch = block.match(/default\s*=\s*((?:"[^"]*"|[^{\n][^\n]*))/);
    let defaultValue: string | undefined;
    if (defaultMatch) {
      defaultValue = defaultMatch[1].trim();
      // Strip surrounding quotes from string defaults
      if (defaultValue.startsWith('"') && defaultValue.endsWith('"')) {
        defaultValue = defaultValue.slice(1, -1);
      }
    }

    variables.push({
      name: varName,
      type: typeMatch ? typeMatch[1].trim() : 'any',
      description: descMatch ? descMatch[1] : '',
      defaultValue,
      required: defaultValue === undefined,
      sensitive: sensitiveMatch?.[1] === 'true' || false,
    });
  }

  return variables;
}
