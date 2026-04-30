import { WorkspaceConfig, WorkspaceConfigEnv } from '../types/index.js';
import { DiscoveryResult } from './WorkspaceAutoDiscovery.js';

/**
 * Build a `WorkspaceConfig` seeded with values from a `DiscoveryResult`.
 *
 * Pure function — no I/O — so it's trivially unit-testable. Anything the
 * discovery couldn't determine falls back to sensible defaults pulled from
 * `defaults` (typically the user's VS Code settings).
 *
 * Caller is expected to write the returned config to disk and let the user
 * tweak it from the WebView panel. We err on the side of populating fields
 * (a half-filled form is friendlier than an empty one).
 */
export interface DefaultsContext {
  /** GitHub org owning composite action repos. From settings. */
  compositeActionOrg: string;
  /** Default AWS region if discovery found none. From settings. */
  defaultStateRegion: string;
  /** Runner group label for generated workflows. From settings. */
  defaultRunnerGroup: string;
}

export function buildConfigFromDiscovery(
  discovery: DiscoveryResult,
  defaults: DefaultsContext,
): WorkspaceConfig {
  const owner = discovery.owner ?? '';
  const repo = discovery.repo ?? '';

  // Region: backend > AWS provider > settings default
  const region =
    discovery.backend?.region ?? discovery.awsRegions[0] ?? defaults.defaultStateRegion;

  // Bucket: backend > predictable default
  const bucket = discovery.backend?.bucket ?? `inf-tfstate-${region}`;
  const keyPrefix = discovery.backend?.keyPrefix ?? 'terraform-state-files';
  const dynamodbTable = discovery.backend?.dynamodbTable ?? 'tf_remote_state';

  const environments: WorkspaceConfigEnv[] = discovery.environments.map(env => ({
    name: env.name,
    cacheBucket: `terraform-cache-${env.name}`,
    runnerGroup: defaults.defaultRunnerGroup,
    varfile: env.tfvarsPath ?? `varfiles/${env.name}.tfvars`,
    deploymentBranchPolicy: env.branchHint
      ? { branch: env.branchHint, protectedBranches: true }
      : undefined,
  }));

  return {
    version: 1,
    compositeActionOrg: defaults.compositeActionOrg,
    terraformVersion: discovery.terraformVersion,
    repo: {
      name: repo,
      repoOrg: owner,
      description: discovery.repoDescription ?? '',
      isPrivate: discovery.isPrivate,
      createRepo: false,
      enforcePrs: true,
      adminTeams: [],
      repoTopics: ['terraform-managed'],
      vars: [],
      secrets: [],
    },
    stateConfig: {
      bucket,
      region,
      keyPrefix,
      dynamodbTable,
      setBackend: !discovery.backend, // Only flip on if the user doesn't already have one
    },
    environments,
    compositeActions: {
      checkout: 'gh-actions-checkout@v4',
      awsAuth: 'aws-auth@main',
      ghAuth: 'gh-auth@main',
      setupTerraform: 'gh-actions-terraform@v1',
      terraformInit: 'terraform-init@main',
      terraformPlan: 'terraform-plan@main',
      terraformApply: 'terraform-apply@main',
      s3Cleanup: 's3-cleanup@main',
    },
  };
}

/**
 * Render a discovery result as a compact human-readable summary suitable for
 * an LM tool response or a quickpick description.
 */
export function summarizeDiscovery(d: DiscoveryResult): string {
  const lines: string[] = [];
  if (d.repoSlug) lines.push(`**Repo:** \`${d.repoSlug}\` (default branch: \`${d.defaultBranch ?? 'unknown'}\`)`);
  if (d.terraformVersion) lines.push(`**Terraform version:** \`${d.terraformVersion}\``);
  if (d.providers.length) lines.push(`**Providers:** ${d.providers.map(p => p.name).join(', ')}`);
  if (d.awsRegions.length) lines.push(`**AWS regions:** ${d.awsRegions.join(', ')}`);
  if (d.backend) {
    const b = d.backend;
    const parts = [b.bucket && `bucket=\`${b.bucket}\``, b.region && `region=\`${b.region}\``, b.dynamodbTable && `lock=\`${b.dynamodbTable}\``].filter(Boolean);
    lines.push(`**S3 backend:** ${parts.join(', ')}`);
  }
  if (d.workingDirectories.length) {
    lines.push(`**Working dirs (with .tf):** ${d.workingDirectories.slice(0, 6).join(', ')}${d.workingDirectories.length > 6 ? ', …' : ''}`);
  }
  if (d.environments.length) {
    lines.push(`**Environments:** ${d.environments.map(e => `${e.name}${e.branchHint ? ` (→${e.branchHint})` : ''} [${e.source}]`).join(', ')}`);
  } else {
    lines.push('**Environments:** none detected — you\'ll need to add at least one.');
  }
  if (d.workflows.length) {
    const tf = d.workflows.filter(w => w.isTerraform);
    if (tf.length) lines.push(`**Existing TF workflows:** ${tf.map(w => w.path).join(', ')}`);
  }
  if (d.repoVariableNames.length) lines.push(`**Repo vars:** ${d.repoVariableNames.length} found (${d.repoVariableNames.slice(0, 5).join(', ')}${d.repoVariableNames.length > 5 ? ', …' : ''})`);
  if (d.repoSecretNames.length) lines.push(`**Repo secrets:** ${d.repoSecretNames.length} found (names only)`);
  if (d.notes.length) lines.push(`\n_Notes:_\n${d.notes.map(n => `- ${n}`).join('\n')}`);
  if (d.warnings.length) lines.push(`\n_Warnings:_\n${d.warnings.map(w => `- ${w}`).join('\n')}`);
  return lines.join('\n');
}
