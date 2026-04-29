import * as vscode from 'vscode';
import {
  WorkspaceConfig,
  WorkspaceConfigEnv,
  WorkspaceConfigStateConfig,
  CompositeActionRefs,
  DEFAULT_COMPOSITE_ACTIONS,
} from '../types/index.js';
import {
  GithubEnvironmentsClient,
  GhaSecret,
  GhaVariable,
} from '../github/GithubEnvironmentsClient.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GeneratedWorkflow {
  filename: string;
  environmentName: string;
  type: 'plan' | 'apply';
  yaml: string;
}

export interface SyncResult {
  generated: GeneratedWorkflow[];
  writtenUris: vscode.Uri[];
}

// ─── WorkflowGenerator ────────────────────────────────────────────────────────

/**
 * Generates GitHub Actions workflow YAML for each environment defined in
 * `.vscode/terraform-workspace.json`.
 *
 * Strategy for dynamic variable/secret passing:
 *   GitHub Actions workflows cannot enumerate secrets at runtime — each secret
 *   must be explicitly referenced in the YAML.  This generator solves that by:
 *     1. Fetching the live list of variables and secret names from the GitHub API
 *        (repo-level + per-environment).
 *     2. Emitting an explicit `env:` entry for every one of them.
 *     3. Providing a "Terraform: Sync Workflows" command to regenerate whenever
 *        the variable set changes.
 *
 *   Variables/secrets named `TF_VAR_*` are passed directly as Terraform input
 *   variables.  Others (e.g. `AWS_REGION`, `AWS_ROLE_ARN`) flow through as
 *   provider/infrastructure environment variables.
 */
export class WorkflowGenerator {
  constructor(private readonly envsClient: GithubEnvironmentsClient) {}

  /**
   * Fetches live vars/secrets from GitHub and generates plan + apply workflows
   * for every environment in the config.
   */
  async generateAll(config: WorkspaceConfig): Promise<GeneratedWorkflow[]> {
    const { repoOrg: owner, name: repo } = config.repo;
    if (!owner || !repo) {
      throw new Error('Workspace config is missing repo.repoOrg or repo.name.');
    }

    // Repo-level vars/secrets apply to every environment
    const [repoSecrets, repoVars] = await Promise.all([
      this.envsClient.listRepoSecrets(owner, repo).catch(() => [] as GhaSecret[]),
      this.envsClient.listRepoVariables(owner, repo).catch(() => [] as GhaVariable[]),
    ]);

    const results: GeneratedWorkflow[] = [];

    for (const env of config.environments) {
      const [envSecrets, envVars] = await Promise.all([
        this.envsClient.listEnvironmentSecrets(owner, repo, env.name).catch(() => [] as GhaSecret[]),
        this.envsClient.listEnvironmentVariables(owner, repo, env.name).catch(() => [] as GhaVariable[]),
      ]);

      const actions = resolveActions(config.compositeActions, config.compositeActionOrg);
      const stateConf = mergeStateConfig(config.stateConfig, env.stateConfig);
      const envBlock = buildEnvBlock(repoVars, repoSecrets, envVars, envSecrets, env);

      results.push({
        filename: `terraform-plan-${env.name}.yml`,
        environmentName: env.name,
        type: 'plan',
        yaml: generatePlanWorkflow(env, actions, stateConf, envBlock),
      });

      results.push({
        filename: `terraform-apply-${env.name}.yml`,
        environmentName: env.name,
        type: 'apply',
        yaml: generateApplyWorkflow(env, actions, stateConf, envBlock),
      });
    }

    return results;
  }

  /** Writes generated workflows to `.github/workflows/` inside the given folder. */
  async writeToWorkspace(
    folder: vscode.WorkspaceFolder,
    workflows: GeneratedWorkflow[],
  ): Promise<vscode.Uri[]> {
    const dir = vscode.Uri.joinPath(folder.uri, '.github', 'workflows');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // directory already exists — that's fine
    }

    const written: vscode.Uri[] = [];
    for (const wf of workflows) {
      const uri = vscode.Uri.joinPath(dir, wf.filename);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(wf.yaml, 'utf-8'));
      written.push(uri);
    }
    return written;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Names always present in the static state-backend block — excluded from the dynamic var section. */
const STATE_VAR_NAMES = new Set([
  'TF_STATE_BUCKET',
  'TF_STATE_REGION',
  'TF_STATE_DYNAMODB_TABLE',
  'TF_STATE_KEY_PREFIX',
  'TF_CACHE_BUCKET',
]);

/**
 * Resolves the composite action uses-references, supporting two formats:
 *   - partial:  "terraform-init@main"         → "{org}/terraform-init@main"
 *   - full:     "MyOrg/terraform-init@main"   → used as-is
 */
function resolveActions(
  overrides: Partial<CompositeActionRefs> | undefined,
  org: string,
): CompositeActionRefs {
  const d = DEFAULT_COMPOSITE_ACTIONS;
  const resolve = (override: string | undefined, def: string): string => {
    const ref = override ?? def;
    return ref.includes('/') ? ref : `${org}/${ref}`;
  };
  return {
    checkout:       resolve(overrides?.checkout,       d.checkout),
    awsAuth:        resolve(overrides?.awsAuth,        d.awsAuth),
    setupTerraform: resolve(overrides?.setupTerraform, d.setupTerraform),
    terraformInit:  resolve(overrides?.terraformInit,  d.terraformInit),
    terraformPlan:  resolve(overrides?.terraformPlan,  d.terraformPlan),
    terraformApply: resolve(overrides?.terraformApply, d.terraformApply),
    ghAuth:         resolve(overrides?.ghAuth,         d.ghAuth),
    s3Cleanup:      resolve(overrides?.s3Cleanup,      d.s3Cleanup),
  };
}

interface ResolvedStateConfig {
  bucket: string;
  region: string;
  dynamodbTable: string;
  keyPrefix: string;
}

function mergeStateConfig(
  global: WorkspaceConfigStateConfig | undefined,
  envOverride: { bucket?: string; region?: string; dynamodbTable?: string; keyPrefix?: string } | undefined,
): ResolvedStateConfig {
  return {
    bucket:        envOverride?.bucket        ?? global?.bucket        ?? 'tf-state',
    region:        envOverride?.region        ?? global?.region        ?? 'us-east-1',
    dynamodbTable: envOverride?.dynamodbTable ?? global?.dynamodbTable ?? 'terraform-state-lock',
    keyPrefix:     envOverride?.keyPrefix     ?? global?.keyPrefix     ?? 'terraform',
  };
}

/**
 * Builds the `env:` block YAML content (without the `env:` key itself).
 *
 * Layout:
 *   1. Static state-backend entries (always emitted).
 *   2. Non-sensitive variables  — repo-level then env-level (env wins on duplicates).
 *   3. Secrets                  — same merge order.
 *   4. Variables/secrets declared in local config that may not yet be synced to GH.
 *
 * All entries are emitted verbatim: if a variable is named `TF_VAR_db_host` it
 * maps to `${{ vars.TF_VAR_DB_HOST }}` and Terraform picks it up automatically.
 * Non-TF vars (e.g. `AWS_REGION`) are also passed through as provider env vars.
 */
function buildEnvBlock(
  repoVars: GhaVariable[],
  repoSecrets: GhaSecret[],
  envVars: GhaVariable[],
  envSecrets: GhaSecret[],
  localEnv: WorkspaceConfigEnv,
): string {
  // Ordered map: name → "${{ vars.NAME }}" (env-level overwrites repo-level)
  const varMap = new Map<string, string>();
  const secretNames: string[] = [];
  const seenSecrets = new Set<string>();

  for (const v of [...repoVars, ...envVars]) {
    if (!STATE_VAR_NAMES.has(v.name.toUpperCase())) {
      varMap.set(v.name, `\${{ vars.${v.name} }}`);
    }
  }

  for (const s of [...repoSecrets, ...envSecrets]) {
    if (!STATE_VAR_NAMES.has(s.name.toUpperCase()) && !seenSecrets.has(s.name)) {
      seenSecrets.add(s.name);
      secretNames.push(s.name);
    }
  }

  // Also pull in vars declared in the local config (they may not be in GH yet)
  for (const v of localEnv.vars ?? []) {
    if (!STATE_VAR_NAMES.has(v.name.toUpperCase())) {
      varMap.set(v.name, `\${{ vars.${v.name} }}`);
    }
  }
  for (const s of localEnv.secrets ?? []) {
    if (!STATE_VAR_NAMES.has(s.name.toUpperCase()) && !seenSecrets.has(s.name)) {
      seenSecrets.add(s.name);
      secretNames.push(s.name);
    }
  }

  const lines: string[] = [
    `  # ── State backend ─────────────────────────────────────────────────────────`,
    `  TF_STATE_BUCKET: \${{ vars.TF_STATE_BUCKET }}`,
    `  TF_STATE_REGION: \${{ vars.TF_STATE_REGION }}`,
    `  TF_STATE_DYNAMODB_TABLE: \${{ vars.TF_STATE_DYNAMODB_TABLE }}`,
    `  TF_STATE_KEY_PREFIX: \${{ vars.TF_STATE_KEY_PREFIX }}`,
    `  # ── Plan / apply artifact cache ────────────────────────────────────────────`,
    `  TF_CACHE_BUCKET: \${{ vars.TF_CACHE_BUCKET }}`,
  ];

  if (varMap.size > 0) {
    lines.push(`  # ── Variables (non-sensitive) ─────────────────────────────────────────────`);
    for (const [name, ref] of varMap) {
      lines.push(`  ${name}: ${ref}`);
    }
  }

  if (secretNames.length > 0) {
    lines.push(`  # ── Secrets ──────────────────────────────────────────────────────────────`);
    for (const name of secretNames) {
      lines.push(`  ${name}: \${{ secrets.${name} }}`);
    }
  }

  return lines.join('\n');
}

// ─── Trigger blocks ───────────────────────────────────────────────────────────

function planTriggers(env: WorkspaceConfigEnv): string {
  const branch = env.deploymentBranchPolicy?.branch;
  const base =
    `on:\n` +
    `  workflow_dispatch:\n` +
    `    inputs:\n` +
    `      workspace:\n` +
    `        description: "Terraform workspace"\n` +
    `        required: false\n` +
    `        default: "${env.name}"\n` +
    `      working_directory:\n` +
    `        description: "Working directory containing Terraform configuration"\n` +
    `        required: false\n` +
    `        default: "."`;
  if (branch) {
    return (
      base +
      `\n  pull_request:\n` +
      `    branches:\n` +
      `      - "${branch}"`
    );
  }
  return base;
}

function applyTriggers(env: WorkspaceConfigEnv): string {
  const branch = env.deploymentBranchPolicy?.branch;
  const base =
    `on:\n` +
    `  workflow_dispatch:\n` +
    `    inputs:\n` +
    `      workspace:\n` +
    `        description: "Terraform workspace"\n` +
    `        required: false\n` +
    `        default: "${env.name}"\n` +
    `      working_directory:\n` +
    `        description: "Working directory containing Terraform configuration"\n` +
    `        required: false\n` +
    `        default: "."`;
  if (branch) {
    return (
      base +
      `\n  push:\n` +
      `    branches:\n` +
      `      - "${branch}"`
    );
  }
  return base;
}

function runnerLabels(env: WorkspaceConfigEnv): string {
  const group = env.runnerGroup ?? 'self-hosted';
  if (group === 'self-hosted') {
    return `["self-hosted"]`;
  }
  return `["self-hosted", "${group}"]`;
}

// ─── YAML generators ──────────────────────────────────────────────────────────

function generatePlanWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  state: ResolvedStateConfig,
  envBlock: string,
): string {
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.

name: "Terraform Plan — ${env.name}"

${planTriggers(env)}

concurrency:
  group: "terraform-${env.name}-plan-\${{ github.ref }}"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  plan:
    name: "Terraform Plan"
    runs-on: ${runnerLabels(env)}
    environment: "${env.name}"
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

      - name: "Configure AWS Credentials"
        uses: "${actions.awsAuth}"

      - name: "Authenticate GitHub App"
        uses: "${actions.ghAuth}"

      - name: "Setup Terraform"
        uses: "${actions.setupTerraform}"

      - name: "Terraform Init"
        uses: "${actions.terraformInit}"
        with:
          workspace: \${{ inputs.workspace }}
          working_directory: \${{ inputs.working_directory }}
          backend_bucket: \${{ env.TF_STATE_BUCKET }}
          backend_region: \${{ env.TF_STATE_REGION }}
          backend_dynamodb_table: \${{ env.TF_STATE_DYNAMODB_TABLE }}
          backend_key: "\${{ env.TF_STATE_KEY_PREFIX }}/\${{ github.repository }}/${env.name}/terraform.tfstate"

      - name: "Terraform Plan"
        uses: "${actions.terraformPlan}"
        with:
          workspace: \${{ inputs.workspace }}
          working_directory: \${{ inputs.working_directory }}
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}

      - name: "S3 Cleanup"
        if: always()
        uses: "${actions.s3Cleanup}"
        with:
          bucket: \${{ env.TF_CACHE_BUCKET }}
`;
}

function generateApplyWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  state: ResolvedStateConfig,
  envBlock: string,
): string {
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.

name: "Terraform Apply — ${env.name}"

${applyTriggers(env)}

concurrency:
  group: "terraform-${env.name}-apply"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  apply:
    name: "Terraform Apply"
    runs-on: ${runnerLabels(env)}
    environment: "${env.name}"
    permissions:
      id-token: write
      contents: read
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

      - name: "Configure AWS Credentials"
        uses: "${actions.awsAuth}"

      - name: "Authenticate GitHub App"
        uses: "${actions.ghAuth}"

      - name: "Setup Terraform"
        uses: "${actions.setupTerraform}"

      - name: "Terraform Init"
        uses: "${actions.terraformInit}"
        with:
          workspace: \${{ inputs.workspace }}
          working_directory: \${{ inputs.working_directory }}
          backend_bucket: \${{ env.TF_STATE_BUCKET }}
          backend_region: \${{ env.TF_STATE_REGION }}
          backend_dynamodb_table: \${{ env.TF_STATE_DYNAMODB_TABLE }}
          backend_key: "\${{ env.TF_STATE_KEY_PREFIX }}/\${{ github.repository }}/${env.name}/terraform.tfstate"

      - name: "Terraform Apply"
        uses: "${actions.terraformApply}"
        with:
          workspace: \${{ inputs.workspace }}
          working_directory: \${{ inputs.working_directory }}
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}

      - name: "S3 Cleanup"
        if: always()
        uses: "${actions.s3Cleanup}"
        with:
          bucket: \${{ env.TF_CACHE_BUCKET }}
`;
}
