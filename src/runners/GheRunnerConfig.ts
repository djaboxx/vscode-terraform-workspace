import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Represents one deployed runner environment — an ECS cluster running
 * persistent GitHub Actions runners in a specific AWS account + region.
 *
 * Environments are either auto-discovered from ghe-runner-style Terraform
 * directories or supplied manually via the `terraformWorkspace.runners`
 * VS Code setting.
 */
export interface RunnerEnvironment {
  /** Human-readable label, e.g. "csvd-dev-ew". Derived from the `aws_account` tfvar. */
  name: string;
  /** AWS region, e.g. "us-gov-west-1". */
  awsRegion: string;
  /** Full ECS cluster name, e.g. "ecs-ghe-runners-us-gov-west-1". */
  ecsCluster: string;
  /** ECS service name — equals `repo_org`, e.g. "SCT-Engineering". */
  ecsService: string;
  /** `desired_count` from tfvars (used as threshold for alarm display). */
  desiredCount: number;
  /**
   * Lambda function name for token refresh, e.g.
   * "github-runner-token-refresh-csvd-dev-ew".
   * Null when `enable_lambda_token_refresh = false`.
   */
  lambdaFunctionName: string | null;
  /** GitHub org name, e.g. "SCT-Engineering". */
  githubOrg: string;
  /** GitHub Enterprise base URL, e.g. "https://github.e.it.census.gov". */
  githubUrl: string;
  /** Absolute path to the Terraform configuration directory. */
  repoPath: string;
  /** How this environment was found. */
  source: 'discovered' | 'manual';
}

// ── tfvars parser ──────────────────────────────────────────────────────────

/** Read a simple scalar string/number from a HCL tfvars file. */
function parseTfVar<T extends string | number | boolean>(
  content: string,
  key: string,
  type: 'string' | 'number' | 'boolean',
): T | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = content.match(pattern);
  if (!m) return undefined;
  const raw = m[1].trim().replace(/\s*#.*$/, '').trim(); // strip trailing comments
  if (type === 'string') {
    return raw.replace(/^["']|["']$/g, '') as T;
  }
  if (type === 'number') {
    const n = Number(raw);
    return (Number.isNaN(n) ? undefined : n) as T;
  }
  if (type === 'boolean') {
    return (raw === 'true') as unknown as T;
  }
  return undefined;
}

/**
 * Try to extract an AWS region from providers.tf or backend.tf in the
 * given directory. Falls back to "us-gov-west-1" (the project default).
 */
async function inferRegion(dir: string): Promise<string> {
  const candidates = ['providers.tf', 'backend.tf'];
  for (const fileName of candidates) {
    try {
      const content = await fs.readFile(path.join(dir, fileName), 'utf-8');
      const m = content.match(/region\s*=\s*["']([a-z0-9-]+)["']/);
      if (m) return m[1];
    } catch {
      // file not found — try next
    }
  }
  return 'us-gov-west-1';
}

/**
 * Given a directory, attempt to parse it as a ghe-runner Terraform config
 * and return a `RunnerEnvironment` on success, or `null` if the directory
 * doesn't look like a runner config.
 */
async function discoverFromDir(dir: string): Promise<RunnerEnvironment | null> {
  // We require at least one auto.tfvars file that has ecs_cluster_name + repo_org
  let tfvarsContent = '';

  try {
    // Prefer default.auto.tfvars, fall back to any *.auto.tfvars
    const defaultPath = path.join(dir, 'default.auto.tfvars');
    try {
      tfvarsContent = await fs.readFile(defaultPath, 'utf-8');
    } catch {
      const entries = await fs.readdir(dir);
      const auto = entries.find(e => e.endsWith('.auto.tfvars'));
      if (!auto) return null;
      tfvarsContent = await fs.readFile(path.join(dir, auto), 'utf-8');
    }
  } catch {
    return null;
  }

  const ecsClusterBase = parseTfVar<string>(tfvarsContent, 'ecs_cluster_name', 'string');
  const repoOrg = parseTfVar<string>(tfvarsContent, 'repo_org', 'string');
  if (!ecsClusterBase || !repoOrg) return null;

  const awsAccount = parseTfVar<string>(tfvarsContent, 'aws_account', 'string') ?? path.basename(dir);
  const desiredCount = parseTfVar<number>(tfvarsContent, 'desired_count', 'number') ?? 1;
  const lambdaEnabled = parseTfVar<boolean>(tfvarsContent, 'enable_lambda_token_refresh', 'boolean') ?? false;
  const serverUrl = parseTfVar<string>(tfvarsContent, 'server_url', 'string') ?? 'https://github.e.it.census.gov';

  const awsRegion = await inferRegion(dir);
  const ecsCluster = `${ecsClusterBase}-${awsRegion}`;
  const lambdaFunctionName = lambdaEnabled ? `github-runner-token-refresh-${awsAccount}` : null;

  return {
    name: awsAccount,
    awsRegion,
    ecsCluster,
    ecsService: repoOrg,
    desiredCount,
    lambdaFunctionName,
    githubOrg: repoOrg,
    githubUrl: serverUrl,
    repoPath: dir,
    source: 'discovered',
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover runner environments from:
 * 1. Workspace folders that look like ghe-runner Terraform configs.
 * 2. The `terraformWorkspace.runners` VS Code setting (manual entries).
 *
 * Results are deduplicated by `ecsCluster`.
 */
export async function discoverRunnerEnvironments(): Promise<RunnerEnvironment[]> {
  const results: RunnerEnvironment[] = [];
  const seen = new Set<string>();

  // ── 1. Auto-discover from workspace folders ────────────────────────────
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    // Check the folder root and one level of subdirectories
    const candidates = [folder.uri.fsPath];
    try {
      const entries = await fs.readdir(folder.uri.fsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(folder.uri.fsPath, entry.name));
        }
      }
    } catch {
      // ignore
    }

    for (const candidate of candidates) {
      const env = await discoverFromDir(candidate);
      if (env && !seen.has(env.ecsCluster)) {
        seen.add(env.ecsCluster);
        results.push(env);
      }
    }
  }

  // ── 2. Manual entries from VS Code settings ───────────────────────────
  const cfg = vscode.workspace.getConfiguration('terraformWorkspace');
  const manual = cfg.get<Partial<RunnerEnvironment>[]>('runners', []);
  for (const entry of manual) {
    if (!entry.ecsCluster || !entry.ecsService) continue;
    if (seen.has(entry.ecsCluster)) continue;
    seen.add(entry.ecsCluster);
    results.push({
      name: entry.name ?? entry.ecsCluster,
      awsRegion: entry.awsRegion ?? 'us-gov-west-1',
      ecsCluster: entry.ecsCluster,
      ecsService: entry.ecsService,
      desiredCount: entry.desiredCount ?? 1,
      lambdaFunctionName: entry.lambdaFunctionName ?? null,
      githubOrg: entry.githubOrg ?? entry.ecsService,
      githubUrl: entry.githubUrl ?? 'https://github.e.it.census.gov',
      repoPath: entry.repoPath ?? '',
      source: 'manual',
    });
  }

  return results;
}
