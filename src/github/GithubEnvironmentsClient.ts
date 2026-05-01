import { TfVariable, TfWorkspace, VariableScope } from '../types/index.js';
import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';



export interface GhaEnvironment {
  id: number;
  name: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  protection_rules?: Array<{ id: number; type: string }>;
  deployment_branch_policy?: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}

export interface GhaSecret {
  name: string;
  created_at: string;
  updated_at: string;
}

export interface GhaVariable {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface GhaRepoPublicKey {
  key_id: string;
  key: string;
}

/**
 * Manages GitHub Environments, Secrets, and Variables via the GitHub REST API.
 *
 * Security: Secret values are encrypted with the repo's public key using
 * libsodium sealed boxes (as required by GitHub API) before transmission.
 * Secrets are never stored locally — they go directly from user input to the
 * GitHub API encrypted payload.
 */
export class GithubEnvironmentsClient {
  constructor(private readonly auth: GithubAuthProvider) {}

  // ─── Environments (= Terraform workspaces) ───────────────────────────────

  /** Lists all GitHub Environments for a repository. */
  async listEnvironments(owner: string, repo: string): Promise<GhaEnvironment[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/environments?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { environments: GhaEnvironment[] };
    return data.environments ?? [];
  }

  /** Converts a GhaEnvironment to our TfWorkspace domain type. */
  toTfWorkspace(env: GhaEnvironment, owner: string, repo: string, orgId: string): TfWorkspace {
    return {
      id: `${owner}/${repo}/${env.name}`,
      name: env.name,
      orgId,
      repoSlug: `${owner}/${repo}`,
      branch: 'main',
      workingDirectory: '.',
      isActive: false,
      htmlUrl: env.html_url,
      updatedAt: env.updated_at,
    };
  }

  // ─── Environment Secrets ─────────────────────────────────────────────────

  /** Lists secret names (not values) for a GitHub Environment. */
  async listEnvironmentSecrets(
    owner: string,
    repo: string,
    environment: string
  ): Promise<GhaSecret[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    // Environment secrets API requires repo ID
    const repoId = await this.getRepoId(owner, repo, token);
    if (!repoId) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repositories/${repoId}/environments/${encodeURIComponent(environment)}/secrets`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { secrets: GhaSecret[] };
    return data.secrets ?? [];
  }

  /**
   * Sets an environment secret. The value is encrypted with the repo's Sodium
   * public key before being sent — the plaintext never hits the wire.
   */
  async setEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const repoId = await this.getRepoId(owner, repo, token);
    if (!repoId) {
      throw new Error(`Could not find repo ${owner}/${repo}`);
    }

    const pubKey = await this.getEnvironmentPublicKey(repoId, environment, token);
    const encryptedValue = await encryptSecret(pubKey.key, value);

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repositories/${repoId}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: pubKey.key_id,
        }),
      }
    );

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set secret ${name}: ${body}`);
    }
  }

  /** Deletes an environment secret. */
  async deleteEnvironmentSecret(
    owner: string,
    repo: string,
    environment: string,
    name: string
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const repoId = await this.getRepoId(owner, repo, token);
    if (!repoId) {
      return;
    }

    await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repositories/${repoId}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.headers(token) }
    );
  }

  // ─── Environment Variables ───────────────────────────────────────────────

  /** Lists all variables for a GitHub Environment. */
  async listEnvironmentVariables(
    owner: string,
    repo: string,
    environment: string
  ): Promise<GhaVariable[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { variables: GhaVariable[] };
    return data.variables ?? [];
  }

  /** Creates or updates an environment variable (plaintext). */
  async setEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string,
    value: string
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    // Try PATCH first (update), then POST (create)
    const baseUrl = `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}/variables`;

    let response = await this.auth.fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value }),
    });

    if (response.status === 404) {
      response = await this.auth.fetch(baseUrl, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ name, value }),
      });
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set variable ${name}: ${body}`);
    }
  }

  /** Deletes an environment variable. */
  async deleteEnvironmentVariable(
    owner: string,
    repo: string,
    environment: string,
    name: string
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      return;
    }

    await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.headers(token) }
    );
  }

  // ─── Org Secrets/Variables (org-level variable sets) ─────────────────────

  /** Lists org-level secret names. */
  async listOrgSecrets(org: string): Promise<GhaSecret[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/orgs/${org}/actions/secrets?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { secrets: GhaSecret[] };
    return data.secrets ?? [];
  }

  /** Lists org-level variables with their values. */
  async listOrgVariables(org: string): Promise<GhaVariable[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/orgs/${org}/actions/variables?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { variables: GhaVariable[] };
    return data.variables ?? [];
  }

  /** Sets an org-level secret (encrypted). */
  async setOrgSecret(org: string, name: string, value: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const pubKey = await this.getOrgPublicKey(org, token);
    const encryptedValue = await encryptSecret(pubKey.key, value);

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/orgs/${org}/actions/secrets/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: pubKey.key_id,
          visibility: 'all',
        }),
      }
    );

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set org secret ${name}: ${body}`);
    }
  }

  /** Sets an org-level variable (plaintext). */
  async setOrgVariable(org: string, name: string, value: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const baseUrl = `${this.auth.apiBaseUrl}/orgs/${org}/actions/variables`;

    let response = await this.auth.fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value, visibility: 'all' }),
    });

    if (response.status === 404) {
      response = await this.auth.fetch(baseUrl, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ name, value, visibility: 'all' }),
      });
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set org variable ${name}: ${body}`);
    }
  }

  /** Converts GHA secrets/variables to TfVariable domain objects. */
  toTfVariables(
    secrets: GhaSecret[],
    variables: GhaVariable[],
    scope: VariableScope,
    environment?: string,
    repoSlug?: string,
    orgId?: string
  ): TfVariable[] {
    const result: TfVariable[] = [];

    for (const s of secrets) {
      result.push({
        id: `${scope}:${s.name}`,
        key: s.name,
        sensitive: true,
        category: 'terraform',
        scope,
        environment,
        repoSlug,
        orgId,
        updatedAt: s.updated_at,
      });
    }

    for (const v of variables) {
      result.push({
        id: `${scope}:${v.name}`,
        key: v.name,
        value: v.value,
        sensitive: false,
        category: 'terraform',
        scope,
        environment,
        repoSlug,
        orgId,
        updatedAt: v.updated_at,
      });
    }

    return result;
  }

  // ─── Repo-level Secrets ──────────────────────────────────────────────────

  /** Lists repo-level secret names. */
  async listRepoSecrets(owner: string, repo: string): Promise<GhaSecret[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/secrets?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { secrets: GhaSecret[] };
    return data.secrets ?? [];
  }

  /** Sets a repo-level secret (encrypted). */
  async setRepoSecret(owner: string, repo: string, name: string, value: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const pubKey = await this.getRepoPublicKey(owner, repo, token);
    const encryptedValue = await encryptSecret(pubKey.key, value);

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({ encrypted_value: encryptedValue, key_id: pubKey.key_id }),
      }
    );

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set repo secret ${name}: ${body}`);
    }
  }

  /** Deletes a repo-level secret. */
  async deleteRepoSecret(owner: string, repo: string, name: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      return;
    }

    await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.headers(token) }
    );
  }

  // ─── Repo-level Variables ────────────────────────────────────────────────

  /** Lists all repo-level variables. */
  async listRepoVariables(owner: string, repo: string): Promise<GhaVariable[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/variables?per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { variables: GhaVariable[] };
    return data.variables ?? [];
  }

  /** Creates or updates a repo-level variable. */
  async setRepoVariable(owner: string, repo: string, name: string, value: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const baseUrl = `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/variables`;

    let response = await this.auth.fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value }),
    });

    if (response.status === 404) {
      response = await this.auth.fetch(baseUrl, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ name, value }),
      });
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Failed to set repo variable ${name}: ${body}`);
    }
  }

  /** Deletes a repo-level variable. */
  async deleteRepoVariable(owner: string, repo: string, name: string): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      return;
    }

    await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.headers(token) }
    );
  }

  // ─── Environment metadata (PUT-style upsert) ──────────────────────────────

  /**
   * Creates or updates a GitHub Environment with protection rules.
   * Uses `PUT /repos/{owner}/{repo}/environments/{name}` which is upsert-safe.
   *
   * `reviewerIds`/`reviewerTeamIds` are numeric IDs (the API does not accept
   * slugs/usernames); resolve them via `resolveReviewerIds()` first if you only
   * have names.
   */
  async upsertEnvironment(
    owner: string,
    repo: string,
    environment: string,
    opts: {
      waitTimer?: number;
      preventSelfReview?: boolean;
      reviewerUserIds?: number[];
      reviewerTeamIds?: number[];
      deploymentBranchPolicy?: { protected_branches: boolean; custom_branch_policies: boolean } | null;
    } = {},
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }
    const reviewers: Array<{ type: 'User' | 'Team'; id: number }> = [
      ...(opts.reviewerUserIds ?? []).map(id => ({ type: 'User' as const, id })),
      ...(opts.reviewerTeamIds ?? []).map(id => ({ type: 'Team' as const, id })),
    ];
    const body: Record<string, unknown> = {};
    if (opts.waitTimer !== undefined) body.wait_timer = opts.waitTimer;
    if (opts.preventSelfReview !== undefined) body.prevent_self_review = opts.preventSelfReview;
    if (reviewers.length > 0) body.reviewers = reviewers;
    if (opts.deploymentBranchPolicy !== undefined) body.deployment_branch_policy = opts.deploymentBranchPolicy;

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/environments/${encodeURIComponent(environment)}`,
      { method: 'PUT', headers: this.headers(token), body: JSON.stringify(body) },
    );
    if (!response.ok) {
      throw new Error(`Failed to upsert environment ${environment}: ${await response.text()}`);
    }
  }

  /** Resolves a list of GitHub usernames to numeric user IDs. Skips unknown logins. */
  async resolveUserIds(logins: string[]): Promise<number[]> {
    const token = await this.auth.getToken(true);
    if (!token) return [];
    const ids: number[] = [];
    for (const login of logins) {
      const r = await this.auth.fetch(
        `${this.auth.apiBaseUrl}/users/${encodeURIComponent(login)}`,
        { headers: this.headers(token) },
      );
      if (r.ok) {
        const u = (await r.json()) as { id: number };
        ids.push(u.id);
      }
    }
    return ids;
  }

  /** Resolves `<org>/<team-slug>` (or just `<team-slug>` against `owner`) to numeric team IDs. */
  async resolveTeamIds(owner: string, teamSlugs: string[]): Promise<number[]> {
    const token = await this.auth.getToken(true);
    if (!token) return [];
    const ids: number[] = [];
    for (const slug of teamSlugs) {
      const [org, team] = slug.includes('/') ? slug.split('/', 2) : [owner, slug];
      const r = await this.auth.fetch(
        `${this.auth.apiBaseUrl}/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}`,
        { headers: this.headers(token) },
      );
      if (r.ok) {
        const t = (await r.json()) as { id: number };
        ids.push(t.id);
      }
    }
    return ids;
  }

  // ─── Repo metadata (PATCH /repos + PUT topics) ────────────────────────────

  /**
   * Patches repository metadata (description, visibility) and replaces topics.
   * Only fields that are explicitly provided are sent.
   */
  async updateRepoMetadata(
    owner: string,
    repo: string,
    opts: { description?: string; isPrivate?: boolean; topics?: string[] },
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }
    const patch: Record<string, unknown> = {};
    if (opts.description !== undefined) patch.description = opts.description;
    if (opts.isPrivate !== undefined) patch.private = opts.isPrivate;
    if (Object.keys(patch).length > 0) {
      const r = await this.auth.fetch(
        `${this.auth.apiBaseUrl}/repos/${owner}/${repo}`,
        { method: 'PATCH', headers: this.headers(token), body: JSON.stringify(patch) },
      );
      if (!r.ok) {
        throw new Error(`Failed to update repo metadata: ${await r.text()}`);
      }
    }
    if (opts.topics) {
      const r = await this.auth.fetch(
        `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/topics`,
        {
          method: 'PUT',
          headers: { ...this.headers(token), Accept: 'application/vnd.github.mercy-preview+json' },
          body: JSON.stringify({ names: opts.topics }),
        },
      );
      if (!r.ok) {
        throw new Error(`Failed to update repo topics: ${await r.text()}`);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async getRepoPublicKey(owner: string, repo: string, token: string): Promise<GhaRepoPublicKey> {
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/secrets/public-key`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      throw new Error(`Failed to get repo public key for ${owner}/${repo}`);
    }

    return (await response.json()) as GhaRepoPublicKey;
  }

  private async getRepoId(owner: string, repo: string, token: string): Promise<number | undefined> {
    const response = await this.auth.fetch(`${this.auth.apiBaseUrl}/repos/${owner}/${repo}`, {
      headers: this.headers(token),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { id: number };
    return data.id;
  }

  private async getEnvironmentPublicKey(
    repoId: number,
    environment: string,
    token: string
  ): Promise<GhaRepoPublicKey> {
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repositories/${repoId}/environments/${encodeURIComponent(environment)}/secrets/public-key`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      throw new Error(`Failed to get public key for environment ${environment}`);
    }

    return (await response.json()) as GhaRepoPublicKey;
  }

  private async getOrgPublicKey(org: string, token: string): Promise<GhaRepoPublicKey> {
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/orgs/${org}/actions/secrets/public-key`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      throw new Error(`Failed to get org public key for ${org}`);
    }

    return (await response.json()) as GhaRepoPublicKey;
  }

  private headers(token: string): Record<string, string> {
    return { ...this.auth.ghHeaders(token), 'Content-Type': 'application/json' };
  }
}

/**
 * Encrypts a secret value using the GitHub repo/org public key.
 * GitHub requires libsodium sealed box encryption (X25519 + XSalsa20-Poly1305).
 *
 * Uses libsodium-wrappers (maintained, WASM-backed, no native deps).
 */
let sodiumPromise: Promise<typeof import('libsodium-wrappers')> | undefined;

async function loadSodium(): Promise<typeof import('libsodium-wrappers')> {
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      // Dynamic import keeps libsodium out of the startup path (it loads a WASM blob)
      const mod = await import('libsodium-wrappers');
      await mod.ready;
      return mod;
    })();
  }
  return sodiumPromise;
}

async function encryptSecret(base64PublicKey: string, secretValue: string): Promise<string> {
  const sodium = await loadSodium();
  const publicKeyBytes = sodium.from_base64(base64PublicKey, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(secretValue);
  const encryptedBytes = sodium.crypto_box_seal(messageBytes, publicKeyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}
