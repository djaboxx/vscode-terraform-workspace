/* eslint-disable no-useless-escape */
import * as vscode from 'vscode';
import {
  WorkspaceConfig,
  WorkspaceConfigEnv,
  WorkspaceConfigStateConfig,
  WorkspaceConfigCodeBuild,
  CompositeActionRefs,
  DEFAULT_COMPOSITE_ACTIONS,
  getWorkspaces,
} from '../types/index.js';
import {
  GithubEnvironmentsClient,
  GhaSecret,
  GhaVariable,
} from '../github/GithubEnvironmentsClient.js';
import { LocalActionsScaffolder, LOCAL_ACTION_REFS } from './LocalActionsScaffolder.js';

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
  constructor(
    private readonly envsClient: GithubEnvironmentsClient,
    private readonly scaffolder?: LocalActionsScaffolder,
  ) {}

  /**
   * Fetches live vars/secrets from GitHub and generates plan + apply workflows
   * for every environment in the config.
   */
  async generateAll(config: WorkspaceConfig): Promise<GeneratedWorkflow[]> {
    const { repoOrg: owner, name: repo } = config.repo;
    if (!owner || !repo) {
      throw new Error('Workspace config is missing repo.repoOrg or repo.name.');
    }

    const cfg = vscode.workspace.getConfiguration('terraformWorkspace');
    const preferOpenTofu  = cfg.get<boolean>('preferOpenTofu', true);
    const useLocalActions = cfg.get<boolean>('useLocalActions', true);
    const useGhaEnvs = config.useGhaEnvironments !== false;

    // Repo-level vars/secrets apply to every environment
    const [repoSecrets, repoVars] = await Promise.all([
      this.envsClient.listRepoSecrets(owner, repo).catch(() => [] as GhaSecret[]),
      this.envsClient.listRepoVariables(owner, repo).catch(() => [] as GhaVariable[]),
    ]);

    const results: GeneratedWorkflow[] = [];

    for (const env of getWorkspaces(config)) {
      // Skip GitHub Environment API calls for flat repos that don't use GHA Environments
      const [envSecrets, envVars] = useGhaEnvs
        ? await Promise.all([
            this.envsClient.listEnvironmentSecrets(owner, repo, env.name).catch(() => [] as GhaSecret[]),
            this.envsClient.listEnvironmentVariables(owner, repo, env.name).catch(() => [] as GhaVariable[]),
          ])
        : [[] as GhaSecret[], [] as GhaVariable[]];

      const actions = useLocalActions
        ? localActionRefs()
        : resolveActions(config.compositeActions, config.compositeActionOrg);
      const stateConf = mergeStateConfig(config.stateConfig, env.stateConfig);
      const envBlock = buildEnvBlock(repoVars, repoSecrets, envVars, envSecrets, env, preferOpenTofu, config.proxy);
      const tfVersion = env.terraformVersion ?? config.terraformVersion;
      const varfile   = env.varfile ?? `varfiles/${env.name}.tfvars`;
      const awsAuthMode = config.awsAuthMode ?? 'oidc';
      const executor = env.executor ?? config.executor ?? 'inline';
      const codebuild = env.codebuild ?? config.codebuild;
      if (executor === 'codebuild' && !codebuild) {
        throw new Error(
          `Env "${env.name}" uses executor=codebuild but no "codebuild" block is configured. ` +
          `Run "Terraform: Scaffold CodeBuild Executor" to provision a project, then add the "codebuild" block.`,
        );
      }

      results.push({
        filename: `terraform-plan-${env.name}.yml`,
        environmentName: env.name,
        type: 'plan',
        yaml: executor === 'codebuild'
          ? generateCodeBuildPlanWorkflow(env, actions, envBlock, useGhaEnvs, awsAuthMode, codebuild!)
          : generatePlanWorkflow(env, actions, stateConf, envBlock, tfVersion, varfile, useGhaEnvs, awsAuthMode),
      });

      results.push({
        filename: `terraform-apply-${env.name}.yml`,
        environmentName: env.name,
        type: 'apply',
        yaml: executor === 'codebuild'
          ? generateCodeBuildApplyWorkflow(env, actions, envBlock, useGhaEnvs, awsAuthMode, codebuild!)
          : generateApplyWorkflow(env, actions, stateConf, envBlock, tfVersion, varfile, useGhaEnvs, awsAuthMode),
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

    // When local actions are enabled, also scaffold them into the repo so the
    // workflows we just wrote can resolve their `uses:` references.
    const useLocalActions = vscode.workspace
      .getConfiguration('terraformWorkspace')
      .get<boolean>('useLocalActions', true);
    if (useLocalActions && this.scaffolder) {
      const actionFiles = await this.scaffolder.scaffold(folder);
      written.push(...actionFiles);
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

/**
 * Returns refs that point at the locally-scaffolded composite actions under
 * `.github/actions/<name>/` in the workspace repo. `checkout` keeps using the
 * official upstream action since it has no project-specific behavior.
 */
function localActionRefs(): CompositeActionRefs {
  return {
    checkout:       'actions/checkout@v4',
    awsAuth:        LOCAL_ACTION_REFS['aws-auth'],
    ghAuth:         LOCAL_ACTION_REFS['gh-auth'],
    setupTerraform: LOCAL_ACTION_REFS['setup-terraform'],
    terraformInit:  LOCAL_ACTION_REFS['terraform-init'],
    terraformPlan:  LOCAL_ACTION_REFS['terraform-plan'],
    terraformApply: LOCAL_ACTION_REFS['terraform-apply'],
    s3Cleanup:      LOCAL_ACTION_REFS['s3-cleanup'],
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
  preferOpenTofu: boolean = true,
  proxy?: { http?: string; https?: string; no?: string },
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
    `  # ── Tooling ──────────────────────────────────────────────────────────────`,
    `  TF_CLI: ${preferOpenTofu ? 'tofu' : 'terraform'}`,
    `  # ── State backend ─────────────────────────────────────────────────────────`,
    `  TF_STATE_BUCKET: \${{ vars.TF_STATE_BUCKET }}`,
    `  TF_STATE_REGION: \${{ vars.TF_STATE_REGION }}`,
    `  TF_STATE_DYNAMODB_TABLE: \${{ vars.TF_STATE_DYNAMODB_TABLE }}`,
    `  TF_STATE_KEY_PREFIX: \${{ vars.TF_STATE_KEY_PREFIX }}`,
    `  # ── Plan / apply artifact cache ────────────────────────────────────────────`,
    `  TF_CACHE_BUCKET: \${{ vars.TF_CACHE_BUCKET }}`,
  ];
  if (proxy && (proxy.http || proxy.https || proxy.no)) {
    lines.push(`  # ── HTTP proxy passthrough ──────────────────────────────────────────────────`);
    if (proxy.http)  lines.push(`  HTTP_PROXY: "${proxy.http}"`);
    if (proxy.https) lines.push(`  HTTPS_PROXY: "${proxy.https}"`);
    if (proxy.no)    lines.push(`  NO_PROXY: "${proxy.no}"`);
  }
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

function setupTerraformStep(actionRef: string, version: string | undefined): string {
  const versionInputs = version
    ? `
        with:
          terraform-version: "${version}"
          tofu-version: "${version}"`
    : '';
  return `      - name: "Setup Terraform"
        uses: "${actionRef}"${versionInputs}`;
}

/**
 * Renders the `permissions:` block. Only requests `id-token: write` when the
 * job actually needs the OIDC token; non-OIDC modes drop it so locked-down
 * orgs can run the workflows without enabling OIDC.
 */
function jobPermissions(awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none', pullRequests: boolean): string {
  const lines: string[] = ['    permissions:'];
  if (awsAuthMode === 'oidc') lines.push('      id-token: write');
  lines.push('      contents: read');
  if (pullRequests) lines.push('      pull-requests: write');
  return lines.join('\n');
}

/**
 * Renders the AWS auth step. The composite action handles all four modes
 * internally, but we still emit a no-op comment for `none` mode and pass the
 * explicit auth-mode/credentials so the step is self-documenting in the YAML.
 */
function awsAuthStepYaml(actionRef: string, awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none'): string {
  if (awsAuthMode === 'none') {
    return `      # AWS auth disabled (awsAuthMode: none) — using a non-AWS state backend or pre-authenticated runner.`;
  }
  if (awsAuthMode === 'access-keys') {
    return `      - name: "Configure AWS Credentials (access keys)"
        uses: "${actionRef}"
        with:
          auth-mode: "access-keys"
          aws-access-key-id:     \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-session-token:     \${{ secrets.AWS_SESSION_TOKEN }}
          # Optional chained AssumeRole — set vars.AWS_ROLE_TO_ASSUME if you want it.
          role-to-assume:        \${{ vars.AWS_ROLE_TO_ASSUME }}`;
  }
  if (awsAuthMode === 'profile') {
    return `      - name: "Configure AWS Credentials (runner profile)"
        uses: "${actionRef}"
        with:
          auth-mode: "profile"
          aws-profile: \${{ vars.AWS_PROFILE }}`;
  }
  // oidc (default) — matches the existing behavior.
  return `      - name: "Configure AWS Credentials (OIDC)"
        uses: "${actionRef}"
        with:
          auth-mode: "oidc"`;
}

function generatePlanWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  state: ResolvedStateConfig,
  envBlock: string,
  tfVersion: string | undefined,
  varfile: string,
  useGhaEnv = true,
  awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none' = 'oidc',
): string {
  const environmentLine = useGhaEnv ? `    environment: "${env.name}"` : `    # No GHA Environment — flat repo mode (useGhaEnvironment: false)`;
  const permissions = jobPermissions(awsAuthMode, /*pullRequests*/ true);
  const awsAuthStep = awsAuthStepYaml(actions.awsAuth, awsAuthMode);
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.

name: "Terraform Plan — ${env.name}"

${planTriggers(env)}

concurrency:
  group: "terraform-${env.name}"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  plan:
    name: "Terraform Plan"
    runs-on: ${runnerLabels(env)}
${environmentLine}
${permissions}
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

${awsAuthStep}

      - name: "Authenticate GitHub App"
        uses: "${actions.ghAuth}"

${setupTerraformStep(actions.setupTerraform, tfVersion)}

      - name: "Terraform Init"
        id: init
        uses: "${actions.terraformInit}"
        with:
          workspace: "${env.name}"
          working_directory: "."
          backend_bucket: \${{ env.TF_STATE_BUCKET }}
          backend_region: \${{ env.TF_STATE_REGION }}
          backend_dynamodb_table: \${{ env.TF_STATE_DYNAMODB_TABLE }}
          backend_key: "\${{ env.TF_STATE_KEY_PREFIX }}/\${{ github.repository }}/${env.name}/terraform.tfstate"
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}

      - name: "Terraform Plan"
        uses: "${actions.terraformPlan}"
        with:
          workspace: "${env.name}"
          working_directory: "."
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}
          cache_key:    \${{ steps.init.outputs.cache_key }}
          varfile: "${varfile}"

      - name: "Cache Cleanup"
        if: always()
        uses: "${actions.s3Cleanup}"
        with:
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}
          cache_key:    \${{ steps.init.outputs.cache_key }}
`;
}

function generateApplyWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  state: ResolvedStateConfig,
  envBlock: string,
  tfVersion: string | undefined,
  varfile: string,
  useGhaEnv = true,
  awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none' = 'oidc',
): string {
  const environmentLine = useGhaEnv ? `    environment: "${env.name}"` : `    # No GHA Environment — flat repo mode (useGhaEnvironment: false)`;
  const permissions = jobPermissions(awsAuthMode, /*pullRequests*/ false);
  const awsAuthStep = awsAuthStepYaml(actions.awsAuth, awsAuthMode);
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.

name: "Terraform Apply — ${env.name}"

${applyTriggers(env)}

concurrency:
  group: "terraform-${env.name}"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  apply:
    name: "Terraform Apply"
    runs-on: ${runnerLabels(env)}
${environmentLine}
${permissions}
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

${awsAuthStep}

      - name: "Authenticate GitHub App"
        uses: "${actions.ghAuth}"

${setupTerraformStep(actions.setupTerraform, tfVersion)}

      - name: "Terraform Init"
        id: init
        uses: "${actions.terraformInit}"
        with:
          workspace: "${env.name}"
          working_directory: "."
          backend_bucket: \${{ env.TF_STATE_BUCKET }}
          backend_region: \${{ env.TF_STATE_REGION }}
          backend_dynamodb_table: \${{ env.TF_STATE_DYNAMODB_TABLE }}
          backend_key: "\${{ env.TF_STATE_KEY_PREFIX }}/\${{ github.repository }}/${env.name}/terraform.tfstate"
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}

      - name: "Terraform Plan"
        id: plan
        uses: "${actions.terraformPlan}"
        with:
          workspace: "${env.name}"
          working_directory: "."
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}
          cache_key:    \${{ steps.init.outputs.cache_key }}
          varfile: "${varfile}"

      - name: "Terraform Apply"
        if: steps.plan.outputs.pending_changes == 'true'
        uses: "${actions.terraformApply}"
        with:
          workspace: "${env.name}"
          working_directory: "."
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}
          cache_key:    \${{ steps.init.outputs.cache_key }}

      - name: "Cache Cleanup"
        if: always()
        uses: "${actions.s3Cleanup}"
        with:
          cache_bucket: \${{ env.TF_CACHE_BUCKET }}
          cache_key:    \${{ steps.init.outputs.cache_key }}
`;
}

// ─── CodeBuild executor ───────────────────────────────────────────────────────
//
// When `executor: codebuild` is configured, the generated workflow's job is a
// thin orchestrator: it authenticates to AWS only enough to call
// `codebuild:StartBuild` + S3 source/artifact, ships the repo into S3, kicks
// off the project, tails CloudWatch logs, and pulls the plan back. The
// CodeBuild project's IAM service role does the actual `terraform plan/apply`
// AWS work — so locked-down GHE Server orgs without OIDC can still run real
// Terraform without giving the GHA runner full provider permissions.

function codebuildDispatchSteps(
  cb: WorkspaceConfigCodeBuild,
  envName: string,
  command: 'plan' | 'apply',
): string {
  const artifactBucket = cb.artifactBucket ?? cb.sourceBucket;
  const region = cb.region ? `\n          AWS_REGION: "${cb.region}"` : '';
  return `      - name: "Package repo for CodeBuild"
        id: pkg
        shell: bash
        run: |
          set -euo pipefail
          KEY="terraform-src/${envName}/\${{ github.run_id }}-\${{ github.run_attempt }}.zip"
          (cd "\${GITHUB_WORKSPACE}" && zip -qr - . -x '.git/*' '.github/workflows/*') > /tmp/src.zip
          aws s3 cp /tmp/src.zip "s3://${cb.sourceBucket}/\${KEY}"
          echo "key=\${KEY}" >> "\$GITHUB_OUTPUT"
          echo "artifact_key=terraform-artifacts/${envName}/\${{ github.run_id }}-\${{ github.run_attempt }}/" >> "\$GITHUB_OUTPUT"

      - name: "Start CodeBuild ${command}"
        id: build
        shell: bash
        env:${region}
          TF_COMMAND: "${command}"
          TF_WORKSPACE: "${envName}"
          SOURCE_BUCKET: "${cb.sourceBucket}"
          ARTIFACT_BUCKET: "${artifactBucket}"
          SOURCE_KEY: \${{ steps.pkg.outputs.key }}
          ARTIFACT_KEY: \${{ steps.pkg.outputs.artifact_key }}
        run: |
          set -euo pipefail
          BUILD_ID=\$(aws codebuild start-build \\
            --project-name "${cb.project}" \\
            --source-type-override S3 \\
            --source-location-override "\${SOURCE_BUCKET}/\${SOURCE_KEY}" \\
            --environment-variables-override \\
              "name=TF_COMMAND,value=\${TF_COMMAND}" \\
              "name=TF_WORKSPACE,value=\${TF_WORKSPACE}" \\
              "name=ARTIFACT_BUCKET,value=\${ARTIFACT_BUCKET}" \\
              "name=ARTIFACT_KEY,value=\${ARTIFACT_KEY}" \\
              "name=GITHUB_REPOSITORY,value=\${{ github.repository }}" \\
              "name=GITHUB_SHA,value=\${{ github.sha }}" \\
            --query 'build.id' --output text)
          echo "build_id=\${BUILD_ID}" >> "\$GITHUB_OUTPUT"
          echo "Started CodeBuild: \${BUILD_ID}"

      - name: "Wait for CodeBuild and stream logs"
        shell: bash
        env:${region}
          BUILD_ID: \${{ steps.build.outputs.build_id }}
        run: |
          set -euo pipefail
          STATUS=""
          LOG_GROUP=""
          LOG_STREAM=""
          NEXT_TOKEN=""
          while :; do
            BUILD_JSON=\$(aws codebuild batch-get-builds --ids "\$BUILD_ID" --query 'builds[0]')
            STATUS=\$(echo "\$BUILD_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("buildStatus",""))')
            if [ -z "\$LOG_GROUP" ]; then
              LOG_GROUP=\$(echo "\$BUILD_JSON"  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("logs",{}).get("groupName") or "")')
              LOG_STREAM=\$(echo "\$BUILD_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("logs",{}).get("streamName") or "")')
            fi
            if [ -n "\$LOG_GROUP" ] && [ -n "\$LOG_STREAM" ]; then
              if [ -z "\$NEXT_TOKEN" ]; then
                OUT=\$(aws logs get-log-events --log-group-name "\$LOG_GROUP" --log-stream-name "\$LOG_STREAM" --start-from-head --limit 1000)
              else
                OUT=\$(aws logs get-log-events --log-group-name "\$LOG_GROUP" --log-stream-name "\$LOG_STREAM" --start-from-head --next-token "\$NEXT_TOKEN" --limit 1000)
              fi
              echo "\$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(e["message"], end="") for e in d.get("events",[])]'
              NEW_TOKEN=\$(echo "\$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("nextForwardToken",""))')
              [ "\$NEW_TOKEN" != "\$NEXT_TOKEN" ] && NEXT_TOKEN="\$NEW_TOKEN"
            fi
            case "\$STATUS" in
              SUCCEEDED) echo "::notice::CodeBuild SUCCEEDED"; exit 0 ;;
              FAILED|FAULT|TIMED_OUT|STOPPED) echo "::error::CodeBuild ended with status: \$STATUS"; exit 1 ;;
              *) sleep 8 ;;
            esac
          done

      - name: "Download plan artifacts"
        if: always()
        shell: bash
        env:${region}
          ARTIFACT_BUCKET: "${artifactBucket}"
          ARTIFACT_KEY:    \${{ steps.pkg.outputs.artifact_key }}
        run: |
          set -euo pipefail
          mkdir -p ./tf-artifacts
          aws s3 cp "s3://\${ARTIFACT_BUCKET}/\${ARTIFACT_KEY}" ./tf-artifacts/ --recursive || true
          ls -la ./tf-artifacts || true

      - name: "Upload plan artifacts to workflow"
        if: always()
        uses: "actions/upload-artifact@v4"
        with:
          name: "terraform-${command}-${envName}"
          path: "./tf-artifacts/"
          if-no-files-found: warn`;
}

function generateCodeBuildPlanWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  envBlock: string,
  useGhaEnv: boolean,
  awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none',
  cb: WorkspaceConfigCodeBuild,
): string {
  const environmentLine = useGhaEnv ? `    environment: "${env.name}"` : `    # No GHA Environment — flat repo mode (useGhaEnvironment: false)`;
  const permissions = jobPermissions(awsAuthMode, /*pullRequests*/ true);
  const awsAuthStep = awsAuthStepYaml(actions.awsAuth, awsAuthMode);
  const dispatch = codebuildDispatchSteps(cb, env.name, 'plan');
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.
# Executor: codebuild — heavy terraform work runs in CodeBuild project "${cb.project}".

name: "Terraform Plan — ${env.name} (CodeBuild)"

${planTriggers(env)}

concurrency:
  group: "terraform-${env.name}"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  plan:
    name: "Terraform Plan (CodeBuild dispatch)"
    runs-on: ${runnerLabels(env)}
${environmentLine}
${permissions}
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

${awsAuthStep}

${dispatch}
`;
}

function generateCodeBuildApplyWorkflow(
  env: WorkspaceConfigEnv,
  actions: CompositeActionRefs,
  envBlock: string,
  useGhaEnv: boolean,
  awsAuthMode: 'oidc' | 'access-keys' | 'profile' | 'none',
  cb: WorkspaceConfigCodeBuild,
): string {
  const environmentLine = useGhaEnv ? `    environment: "${env.name}"` : `    # No GHA Environment — flat repo mode (useGhaEnvironment: false)`;
  const permissions = jobPermissions(awsAuthMode, /*pullRequests*/ false);
  const awsAuthStep = awsAuthStepYaml(actions.awsAuth, awsAuthMode);
  const dispatch = codebuildDispatchSteps(cb, env.name, 'apply');
  return `# Generated by Terraform Workspace VS Code Extension
# Re-sync: Ctrl/Cmd+Shift+P → "Terraform: Sync Workflows"
# WARNING: Do not edit manually — changes will be overwritten on next sync.
# Executor: codebuild — heavy terraform work runs in CodeBuild project "${cb.project}".

name: "Terraform Apply — ${env.name} (CodeBuild)"

${applyTriggers(env)}

concurrency:
  group: "terraform-${env.name}"
  cancel-in-progress: false

env:
${envBlock}

jobs:
  apply:
    name: "Terraform Apply (CodeBuild dispatch)"
    runs-on: ${runnerLabels(env)}
${environmentLine}
${permissions}
    steps:
      - name: "Checkout"
        uses: "${actions.checkout}"

${awsAuthStep}

${dispatch}
`;
}

