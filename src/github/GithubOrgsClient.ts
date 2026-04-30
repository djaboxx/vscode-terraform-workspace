import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';
import { TfVariableSet, VariableScope } from '../types/index.js';
import { GithubEnvironmentsClient } from './GithubEnvironmentsClient.js';



/**
 * GitHub Orgs client — wraps org-level secrets, variables, and team lookups.
 *
 * Org-level secrets/variables act as "variable sets" shared across all repos
 * in the organization (analogous to Terraform Cloud Variable Sets with
 * global=true, visibility=all).
 */
export class GithubOrgsClient {
  private readonly envsClient: GithubEnvironmentsClient;

  constructor(private readonly auth: GithubAuthProvider) {
    this.envsClient = new GithubEnvironmentsClient(auth);
  }

  /**
   * Returns org secrets and variables as a single TfVariableSet.
   * Secret values are not returned by the API — only names are listed.
   */
  async getOrgVariableSet(org: string): Promise<TfVariableSet> {
    const [secrets, variables] = await Promise.all([
      this.envsClient.listOrgSecrets(org),
      this.envsClient.listOrgVariables(org),
    ]);

    const tfVars = this.envsClient.toTfVariables(
      secrets,
      variables,
      'organization' as VariableScope,
      undefined,
      undefined,
      org
    );

    return {
      id: `org:${org}`,
      name: `${org} organization variables`,
      orgId: org,
      global: true,
      priority: false,
      workspaceNames: [],
      variables: tfVars,
    };
  }

  /**
   * Lists teams in the organization. Used by the AI when generating
   * workspace bootstrap configs that include reviewer teams.
   */
  async listTeams(org: string): Promise<Array<{ id: number; name: string; slug: string }>> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(`${this.auth.apiBaseUrl}/orgs/${org}/teams?per_page=100`, {
      headers: this.headers(token),
    });

    if (!response.ok) {
      return [];
    }

    const teams = (await response.json()) as Array<{
      id: number;
      name: string;
      slug: string;
    }>;

    return teams;
  }

  /**
   * Returns a flat list of all team slugs in the organization — used by the
   * PatternLibrary and AI context to suggest valid reviewer_teams values.
   */
  async listTeamSlugs(org: string): Promise<string[]> {
    const teams = await this.listTeams(org);
    return teams.map(t => t.slug);
  }

  /**
   * Lists all repositories in the organization that contain Terraform config
   * (detected by the presence of the `terraform-managed` topic or *.tf files).
   * This is a best-effort heuristic — not guaranteed to be exhaustive.
   */
  async listTerraformRepos(org: string): Promise<string[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/search/repositories?q=org:${org}+topic:terraform-managed&per_page=100`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { items: Array<{ name: string }> };
    return (data.items ?? []).map(r => `${org}/${r.name}`);
  }

  /**
   * Sets an org-level secret (delegates to envsClient).
   */
  async setOrgSecret(org: string, name: string, value: string): Promise<void> {
    return this.envsClient.setOrgSecret(org, name, value);
  }

  /**
   * Sets an org-level variable (delegates to envsClient).
   */
  async setOrgVariable(org: string, name: string, value: string): Promise<void> {
    return this.envsClient.setOrgVariable(org, name, value);
  }

  private headers(token: string): Record<string, string> {
    return this.auth.ghHeaders(token);
  }
}
