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

    const response = await fetch(
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

    const response = await fetch(
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

    const response = await fetch(
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

    await fetch(
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

    const response = await fetch(
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

    let response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value }),
    });

    if (response.status === 404) {
      response = await fetch(baseUrl, {
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

    await fetch(
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

    const response = await fetch(
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

    const response = await fetch(
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

    const response = await fetch(
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

    let response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value, visibility: 'all' }),
    });

    if (response.status === 404) {
      response = await fetch(baseUrl, {
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

    const response = await fetch(
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

    const response = await fetch(
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

    await fetch(
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

    const response = await fetch(
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

    let response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ name, value }),
    });

    if (response.status === 404) {
      response = await fetch(baseUrl, {
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

    await fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.headers(token) }
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async getRepoPublicKey(owner: string, repo: string, token: string): Promise<GhaRepoPublicKey> {
    const response = await fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/secrets/public-key`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      throw new Error(`Failed to get repo public key for ${owner}/${repo}`);
    }

    return (await response.json()) as GhaRepoPublicKey;
  }

  private async getRepoId(owner: string, repo: string, token: string): Promise<number | undefined> {
    const response = await fetch(`${this.auth.apiBaseUrl}/repos/${owner}/${repo}`, {
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
    const response = await fetch(
      `${this.auth.apiBaseUrl}/repositories/${repoId}/environments/${encodeURIComponent(environment)}/secrets/public-key`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      throw new Error(`Failed to get public key for environment ${environment}`);
    }

    return (await response.json()) as GhaRepoPublicKey;
  }

  private async getOrgPublicKey(org: string, token: string): Promise<GhaRepoPublicKey> {
    const response = await fetch(
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
 * Uses tweetsodium (pure JS, no native deps) for compatibility in VS Code extensions.
 */
async function encryptSecret(base64PublicKey: string, secretValue: string): Promise<string> {
  // Dynamic import keeps tweetsodium out of the startup path
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sodium = require('tweetsodium') as {
    seal: (message: Uint8Array, recipientPublicKey: Uint8Array) => Uint8Array;
  };

  const publicKeyBytes = Buffer.from(base64PublicKey, 'base64');
  const messageBytes = Buffer.from(secretValue, 'utf-8');
  const encryptedBytes = sodium.seal(messageBytes, publicKeyBytes);
  return Buffer.from(encryptedBytes).toString('base64');
}
