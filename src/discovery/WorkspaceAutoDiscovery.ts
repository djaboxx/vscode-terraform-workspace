import * as vscode from 'vscode';
import * as path from 'path';
import { GitRemoteParser } from '../auth/GitRemoteParser.js';
import { GithubEnvironmentsClient } from '../github/GithubEnvironmentsClient.js';
import { GithubActionsClient } from '../github/GithubActionsClient.js';

/**
 * Auto-discovery of reasonable defaults for a Terraform workspace config.
 *
 * Scrapes signals available *without prompting the user*:
 *
 *  - `git remote -v` → owner/repo, hostname, default branch
 *  - `**\/*.tf`       → backend "s3" block, required_version, providers,
 *                      AWS regions in provider blocks, working directories
 *  - `varfiles\/*.tfvars` and `*.tfvars` → environment-name candidates
 *  - `.github\/workflows\/*.yml` → existing terraform workflows + envs referenced
 *  - GitHub Environments API → already-configured environments
 *  - GitHub repo metadata    → description, visibility
 *
 * All network calls degrade gracefully — missing auth or offline still yields
 * the local-only signals. The result is a pure data structure that callers
 * (the LM tool, the bootstrap command, the WebView panel) can turn into a
 * concrete `WorkspaceConfig`.
 */

export interface DiscoveredBackend {
  bucket?: string;
  region?: string;
  keyPrefix?: string;
  dynamodbTable?: string;
  /** Raw `key = "..."` value from the backend block, if present. */
  key?: string;
}

export interface DiscoveredProvider {
  /** Provider name (e.g. "aws", "google", "azurerm"). */
  name: string;
  /** Source (e.g. "hashicorp/aws"), if specified. */
  source?: string;
  /** Version constraint, if specified. */
  version?: string;
}

export interface DiscoveredEnvironment {
  name: string;
  /** Source: where we learned about this env. */
  source: 'github-environment' | 'workflow-yaml' | 'tfvars-file' | 'directory-name';
  /** Branch hint if we could deduce one (e.g. "main" → prod, "develop" → dev). */
  branchHint?: string;
  /** Path of the tfvars file if source=tfvars-file. */
  tfvarsPath?: string;
}

export interface DiscoveredWorkflow {
  /** File path under .github/workflows. */
  path: string;
  /** True if the YAML mentions terraform/tofu in command position. */
  isTerraform: boolean;
  /** Environment names referenced via `environment:` blocks. */
  environments: string[];
}

export interface DiscoveryResult {
  /** Folder that was scanned. */
  folderPath: string;
  /** owner/repo from git remote, if any. */
  repoSlug?: string;
  owner?: string;
  repo?: string;
  hostname: string;
  defaultBranch?: string;
  /** Repo description from GitHub, if reachable. */
  repoDescription?: string;
  isPrivate?: boolean;
  /** Working directories (relative to folderPath) that contain .tf files. */
  workingDirectories: string[];
  /** Inferred backend config from `terraform { backend "s3" { ... } }`. */
  backend?: DiscoveredBackend;
  /** required_version constraint from `terraform {}` block. */
  terraformVersion?: string;
  /** Distinct providers referenced by required_providers blocks. */
  providers: DiscoveredProvider[];
  /** Distinct AWS regions referenced in provider blocks. */
  awsRegions: string[];
  /** Candidate environments deduplicated by name (case-insensitive). */
  environments: DiscoveredEnvironment[];
  /** Existing `.github/workflows/*.yml` files. */
  workflows: DiscoveredWorkflow[];
  /** Repo-level GHA variable names (non-sensitive). */
  repoVariableNames: string[];
  /** Repo-level GHA secret names (sensitive — values not fetched). */
  repoSecretNames: string[];
  /** Free-text notes about why each suggestion was made — surfaced to the LM. */
  notes: string[];
  /** Errors swallowed during discovery (e.g. auth missing). Surfaced for transparency. */
  warnings: string[];
}

interface DiscoveryDeps {
  envsClient?: GithubEnvironmentsClient;
  actionsClient?: GithubActionsClient;
}

export class WorkspaceAutoDiscovery {
  constructor(private readonly deps: DiscoveryDeps = {}) {}

  /**
   * Run the full discovery pipeline against a workspace folder.
   * Never throws — failures collapse into `warnings`.
   */
  async discover(folder: vscode.WorkspaceFolder): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      folderPath: folder.uri.fsPath,
      hostname: 'github.com',
      workingDirectories: [],
      providers: [],
      awsRegions: [],
      environments: [],
      workflows: [],
      repoVariableNames: [],
      repoSecretNames: [],
      notes: [],
      warnings: [],
    };

    // 1. Git remote → owner/repo/host/default-branch
    try {
      result.hostname = await GitRemoteParser.getHostname();
      const slug = await GitRemoteParser.getPrimaryRepoSlug(folder.uri.fsPath);
      if (slug) {
        result.repoSlug = slug;
        const [owner, repo] = slug.split('/');
        result.owner = owner;
        result.repo = repo;
        result.notes.push(`Detected repo \`${slug}\` from git remote.`);
      } else {
        result.warnings.push('No git remote found — owner/repo must be supplied manually.');
      }
      result.defaultBranch = await GitRemoteParser.getDefaultBranch(folder.uri.fsPath);
    } catch (err) {
      result.warnings.push(`git remote scan failed: ${String(err)}`);
    }

    // 2. Local file scans (tf, tfvars, workflows)
    await this.scanTerraformFiles(folder, result);
    await this.scanTfvarsFiles(folder, result);
    await this.scanWorkflowFiles(folder, result);

    // 3. GitHub API enrichment (best-effort, skipped silently if no auth)
    if (result.owner && result.repo) {
      await this.enrichFromGithub(result.owner, result.repo, result);
    }

    this.dedupeEnvironments(result);
    return result;
  }

  // ── Local scanners ───────────────────────────────────────────────────────

  private async scanTerraformFiles(folder: vscode.WorkspaceFolder, result: DiscoveryResult): Promise<void> {
    const pattern = new vscode.RelativePattern(folder, '**/*.tf');
    const exclude = '{**/.terraform/**,**/node_modules/**,**/vendor/**}';
    const uris = await vscode.workspace.findFiles(pattern, exclude, 200);

    if (uris.length === 0) {
      result.warnings.push('No .tf files found in this folder.');
      return;
    }

    const dirs = new Set<string>();
    const providers = new Map<string, DiscoveredProvider>();
    const regions = new Set<string>();
    let backend: DiscoveredBackend | undefined;
    let tfVersion: string | undefined;

    for (const uri of uris) {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      const dir = path.dirname(rel) || '.';
      dirs.add(dir);

      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString('utf-8');
      } catch {
        continue;
      }

      // Strip comments to keep regex matches honest.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)#.*$/gm, '$1')
        .replace(/(^|\s)\/\/.*$/gm, '$1');

      // Backend "s3" { ... }
      if (!backend) {
        const m = /backend\s+"s3"\s*\{([\s\S]*?)\}/.exec(stripped);
        if (m) {
          backend = parseBackendBlock(m[1]);
          result.notes.push(`Found S3 backend in \`${rel}\`.`);
        }
      }

      // required_version
      if (!tfVersion) {
        const m = /required_version\s*=\s*"([^"]+)"/.exec(stripped);
        if (m) tfVersion = m[1];
      }

      // required_providers { aws = { source = "hashicorp/aws", version = "..." } }
      const reqBlock = /required_providers\s*\{([\s\S]*?)\}/.exec(stripped);
      if (reqBlock) {
        for (const p of parseRequiredProviders(reqBlock[1])) {
          if (!providers.has(p.name)) providers.set(p.name, p);
        }
      }

      // AWS provider regions: provider "aws" { region = "us-east-1" }
      const awsRe = /provider\s+"aws"\s*\{([\s\S]*?)\}/g;
      let aws: RegExpExecArray | null;
      while ((aws = awsRe.exec(stripped))) {
        const r = /region\s*=\s*"([a-z]{2}-[a-z]+-\d+)"/.exec(aws[1]);
        if (r) regions.add(r[1]);
      }
    }

    result.workingDirectories = Array.from(dirs).sort();
    result.providers = Array.from(providers.values());
    result.awsRegions = Array.from(regions);
    if (backend) result.backend = backend;
    if (tfVersion) result.terraformVersion = tfVersion;

    // Pin files (tfenv / asdf) take precedence over the `required_version`
    // constraint because they're an explicit choice, not a constraint range.
    const pinned = await readVersionPinFiles(folder);
    if (pinned) {
      result.terraformVersion = pinned.version;
      result.notes.push(`Honoring \`${pinned.source}\` pin: \`${pinned.version}\`.`);
    }

    if (result.providers.length > 0) {
      result.notes.push(`Detected providers: ${result.providers.map(p => p.name).join(', ')}.`);
    }
    if (result.awsRegions.length > 0) {
      result.notes.push(`AWS regions referenced: ${result.awsRegions.join(', ')}.`);
    }
  }

  private async scanTfvarsFiles(folder: vscode.WorkspaceFolder, result: DiscoveryResult): Promise<void> {
    const pattern = new vscode.RelativePattern(folder, '{varfiles,vars,environments}/*.tfvars');
    const uris = await vscode.workspace.findFiles(pattern, undefined, 100);
    // Also pick up root-level <env>.tfvars
    const rootPattern = new vscode.RelativePattern(folder, '*.tfvars');
    const rootUris = await vscode.workspace.findFiles(rootPattern, undefined, 50);

    for (const uri of [...uris, ...rootUris]) {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      const base = path.basename(uri.fsPath, '.tfvars');
      if (!base || base === 'terraform' || base === 'common') continue;
      result.environments.push({
        name: base,
        source: 'tfvars-file',
        tfvarsPath: rel,
        branchHint: branchHintForEnv(base),
      });
    }
  }

  private async scanWorkflowFiles(folder: vscode.WorkspaceFolder, result: DiscoveryResult): Promise<void> {
    const pattern = new vscode.RelativePattern(folder, '.github/workflows/*.{yml,yaml}');
    const uris = await vscode.workspace.findFiles(pattern, undefined, 100);

    for (const uri of uris) {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString('utf-8');
      } catch {
        continue;
      }

      const isTerraform = /\b(terraform|tofu)\b/i.test(text);
      const envs = new Set<string>();
      // `environment: foo` or `environment:\n  name: foo`
      const envInline = /^\s*environment:\s*([A-Za-z0-9._-]+)\s*$/gm;
      const envName = /^\s*environment:\s*\n\s*name:\s*([A-Za-z0-9._-]+)\s*$/gm;
      let m: RegExpExecArray | null;
      while ((m = envInline.exec(text))) envs.add(m[1]);
      while ((m = envName.exec(text))) envs.add(m[1]);

      result.workflows.push({ path: rel, isTerraform, environments: Array.from(envs) });

      for (const e of envs) {
        result.environments.push({ name: e, source: 'workflow-yaml', branchHint: branchHintForEnv(e) });
      }
    }
  }

  // ── Remote enrichment (best-effort) ──────────────────────────────────────

  private async enrichFromGithub(owner: string, repo: string, result: DiscoveryResult): Promise<void> {
    const { envsClient } = this.deps;
    if (!envsClient) return;

    try {
      const envs = await envsClient.listEnvironments(owner, repo);
      for (const env of envs) {
        result.environments.push({
          name: env.name,
          source: 'github-environment',
          branchHint: branchHintForEnv(env.name),
        });
      }
      if (envs.length > 0) {
        result.notes.push(`Found ${envs.length} existing GitHub Environment(s): ${envs.map(e => e.name).join(', ')}.`);
      }
    } catch (err) {
      result.warnings.push(`Could not list GitHub Environments (${String(err).split('\n')[0]}).`);
    }

    try {
      const vars = await envsClient.listRepoVariables(owner, repo);
      result.repoVariableNames = vars.map(v => v.name);
    } catch {
      // ignore — likely auth scope
    }

    try {
      const secs = await envsClient.listRepoSecrets(owner, repo);
      result.repoSecretNames = secs.map(s => s.name);
    } catch {
      // ignore
    }
  }

  private dedupeEnvironments(result: DiscoveryResult): void {
    const byName = new Map<string, DiscoveredEnvironment>();
    // Priority: github-environment > workflow-yaml > tfvars-file > directory-name
    const rank: Record<DiscoveredEnvironment['source'], number> = {
      'github-environment': 4,
      'workflow-yaml': 3,
      'tfvars-file': 2,
      'directory-name': 1,
    };
    for (const env of result.environments) {
      const key = env.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing || rank[env.source] > rank[existing.source]) {
        byName.set(key, env);
      } else if (env.tfvarsPath && !existing.tfvarsPath) {
        existing.tfvarsPath = env.tfvarsPath;
      }
    }
    result.environments = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
}

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

export function parseBackendBlock(body: string): DiscoveredBackend {
  const out: DiscoveredBackend = {};
  const grab = (key: string): string | undefined => {
    const re = new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`);
    const m = re.exec(body);
    return m?.[1];
  };
  out.bucket = grab('bucket');
  out.region = grab('region');
  out.dynamodbTable = grab('dynamodb_table');
  const key = grab('key');
  if (key) {
    out.key = key;
    // "envs/prod/terraform.tfstate" → keyPrefix "envs"
    const slash = key.indexOf('/');
    if (slash > 0) out.keyPrefix = key.slice(0, slash);
  }
  return out;
}

export function parseRequiredProviders(body: string): DiscoveredProvider[] {
  const out: DiscoveredProvider[] = [];
  // Match `name = { source = "...", version = "..." }`
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1];
    const inner = m[2];
    const source = /source\s*=\s*"([^"]+)"/.exec(inner)?.[1];
    const version = /version\s*=\s*"([^"]+)"/.exec(inner)?.[1];
    out.push({ name, source, version });
  }
  return out;
}

/**
 * Heuristic: well-known env names map to common branch names. Used only as a
 * suggestion — never authoritative.
 */
export function branchHintForEnv(env: string): string | undefined {
  const e = env.toLowerCase();
  if (e === 'prod' || e === 'production' || e === 'main' || e === 'master') return 'main';
  if (e === 'staging' || e === 'stage' || e === 'preprod') return 'staging';
  if (e === 'dev' || e === 'develop' || e === 'development') return 'develop';
  if (e === 'qa' || e === 'test') return 'develop';
  return undefined;
}

/**
 * Reads tfenv (`.terraform-version`) and asdf (`.tool-versions`) pin files
 * from the workspace root, returning the pinned Terraform/OpenTofu version
 * if either is present. tfenv takes priority since it's terraform-specific.
 */
export async function readVersionPinFiles(
  folder: vscode.WorkspaceFolder,
): Promise<{ version: string; source: '.terraform-version' | '.tool-versions' } | undefined> {
  const tfvUri = vscode.Uri.joinPath(folder.uri, '.terraform-version');
  try {
    const bytes = await vscode.workspace.fs.readFile(tfvUri);
    const v = Buffer.from(bytes).toString('utf-8').trim();
    if (v) return { version: v, source: '.terraform-version' };
  } catch {
    // not present — fall through
  }

  const tvUri = vscode.Uri.joinPath(folder.uri, '.tool-versions');
  try {
    const bytes = await vscode.workspace.fs.readFile(tvUri);
    const text = Buffer.from(bytes).toString('utf-8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:terraform|opentofu|tofu)\s+(\S+)/i.exec(line);
      if (m) return { version: m[1], source: '.tool-versions' };
    }
  } catch {
    // not present
  }

  return undefined;
}
