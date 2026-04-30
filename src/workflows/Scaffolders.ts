import * as vscode from 'vscode';

/**
 * Generators for snippets the user typically writes once per AWS account:
 *   - S3 + DynamoDB Terraform backend (`backendBootstrapTf`)
 *   - GitHub OIDC IAM trust policy JSON (`oidcTrustPolicy`)
 *
 * These return raw strings — callers decide whether to drop them in an
 * untitled editor, write to disk, or hand off to the chat participant.
 */

export interface BackendBootstrapInputs {
  bucketName: string;
  region: string;
  dynamodbTable: string;
  /** Optional KMS key alias to enable SSE-KMS on the bucket. */
  kmsKeyAlias?: string;
}

export function backendBootstrapTf(inputs: BackendBootstrapInputs): string {
  const sse = inputs.kmsKeyAlias
    ? `\n      kms_master_key_id = "alias/${inputs.kmsKeyAlias}"\n      sse_algorithm     = "aws:kms"`
    : `\n      sse_algorithm = "AES256"`;

  return `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "${inputs.region}"
}

resource "aws_s3_bucket" "tf_state" {
  bucket = "${inputs.bucketName}"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {${sse}
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tf_locks" {
  name         = "${inputs.dynamodbTable}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}
`;
}

export interface OidcTrustPolicyInputs {
  awsAccountId: string;
  /** GitHub org/owner */
  githubOrg: string;
  /** Optional repo name; if omitted, allows any repo in the org */
  repo?: string;
  /** Optional environment name; if omitted, allows any environment */
  environment?: string;
  /** Override the default OIDC provider URL host */
  oidcProvider?: string;
}

/**
 * Returns the OIDC provider host for a given GitHub host.
 *  - github.com  → `token.actions.githubusercontent.com` (the public OIDC issuer)
 *  - GHE Server → `<host>/_services/token` (issuer hosted by the appliance)
 */
export function defaultOidcProvider(hostname: string): string {
  return hostname === 'github.com'
    ? 'token.actions.githubusercontent.com'
    : `${hostname}/_services/token`;
}

export function oidcTrustPolicy(inputs: OidcTrustPolicyInputs): string {
  const provider = inputs.oidcProvider ?? 'token.actions.githubusercontent.com';
  const repoSegment = inputs.repo ? `${inputs.githubOrg}/${inputs.repo}` : `${inputs.githubOrg}/*`;
  const envSegment = inputs.environment
    ? `:environment:${inputs.environment}`
    : ':*';
  const sub = `repo:${repoSegment}${envSegment}`;

  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${inputs.awsAccountId}:oidc-provider/${provider}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { [`${provider}:aud`]: 'sts.amazonaws.com' },
          StringLike: { [`${provider}:sub`]: sub },
        },
      },
    ],
  };
  return JSON.stringify(policy, null, 2) + '\n';
}

// ─── Command handlers ─────────────────────────────────────────────────────────

export async function runBackendBootstrap(): Promise<void> {
  const bucketName = await vscode.window.showInputBox({ prompt: 'S3 state bucket name (must be globally unique)' });
  if (!bucketName) return;
  const region = await vscode.window.showInputBox({ prompt: 'AWS region', value: 'us-east-1' });
  if (!region) return;
  const dynamodbTable = await vscode.window.showInputBox({ prompt: 'DynamoDB lock table name', value: 'terraform-locks' });
  if (!dynamodbTable) return;
  const kmsChoice = await vscode.window.showQuickPick(['AES256', 'SSE-KMS'], { placeHolder: 'Encryption' });
  let kmsKeyAlias: string | undefined;
  if (kmsChoice === 'SSE-KMS') {
    kmsKeyAlias = await vscode.window.showInputBox({ prompt: 'KMS key alias (without alias/ prefix)' });
  }

  const tf = backendBootstrapTf({ bucketName, region, dynamodbTable, kmsKeyAlias });
  const doc = await vscode.workspace.openTextDocument({ language: 'terraform', content: tf });
  await vscode.window.showTextDocument(doc);
}

export async function runOidcTrustPolicy(auth?: { resolveHostname(): Promise<string> }): Promise<void> {
  const awsAccountId = await vscode.window.showInputBox({ prompt: 'AWS account ID', validateInput: v => /^\d{12}$/.test(v) ? null : 'Account ID must be 12 digits' });
  if (!awsAccountId) return;
  const githubOrg = await vscode.window.showInputBox({ prompt: 'GitHub org/owner' });
  if (!githubOrg) return;
  const repo = await vscode.window.showInputBox({ prompt: 'Repo name (leave blank for any repo in org)' });
  const environment = await vscode.window.showInputBox({ prompt: 'Environment (leave blank for any)' });

  const hostname = auth ? await auth.resolveHostname() : 'github.com';
  const defaultProvider = defaultOidcProvider(hostname);
  const oidcProvider = await vscode.window.showInputBox({
    prompt: 'OIDC provider host',
    value: defaultProvider,
    placeHolder: defaultProvider,
  });
  if (oidcProvider === undefined) return;

  const json = oidcTrustPolicy({
    awsAccountId,
    githubOrg,
    repo: repo || undefined,
    environment: environment || undefined,
    oidcProvider: oidcProvider || defaultProvider,
  });
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content: json });
  await vscode.window.showTextDocument(doc);
}

interface AuthLike {
  readonly apiBaseUrl: string;
  fetch(url: string, init?: RequestInit & { maxRetries?: number }): Promise<Response>;
}

/**
 * UI-driven "create a new repo from a template" flow. Designed to be runnable
 * with no folder open — it does not touch the workspace until after the new
 * repo has been created on GitHub. After creation, the user is offered to
 * clone it locally (via the built-in Git extension) and open it in the
 * current window.
 */
export async function runScaffoldFromTemplate(auth: AuthLike): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('terraformWorkspace');
  const defaultOwner = (cfg.get<string>('repoOrg') ?? '').trim();

  const templateOwner = await vscode.window.showInputBox({
    prompt: 'Template repository owner (user or org)',
    value: defaultOwner || undefined,
    placeHolder: defaultOwner || 'e.g. your-org',
    validateInput: v => v.trim() ? null : 'Owner is required',
  });
  if (!templateOwner) return;

  const templateRepo = await vscode.window.showInputBox({
    prompt: `Template repository name (under ${templateOwner})`,
    placeHolder: 'e.g. template-aws-module',
    validateInput: v => v.trim() ? null : 'Template repo is required',
  });
  if (!templateRepo) return;

  const newRepoName = await vscode.window.showInputBox({
    prompt: 'Name for the new repository',
    validateInput: v => /^[a-zA-Z0-9._-]+$/.test(v) ? null : 'Use letters, digits, dot, dash, underscore only',
  });
  if (!newRepoName) return;

  const newRepoOwner = await vscode.window.showInputBox({
    prompt: 'New repository owner (leave blank for the authenticated user)',
    value: defaultOwner || undefined,
    placeHolder: defaultOwner || 'org name, or blank for personal account',
  });

  const description = await vscode.window.showInputBox({
    prompt: 'Description (optional)',
  });

  const visibility = await vscode.window.showQuickPick(
    [
      { label: 'Private', value: true, description: 'Recommended for infrastructure code' },
      { label: 'Public', value: false },
    ],
    { placeHolder: 'Repository visibility' },
  );
  if (!visibility) return;

  const includeAllBranches = await vscode.window.showQuickPick(
    [
      { label: 'Default branch only', value: false, description: 'Recommended' },
      { label: 'All branches from template', value: true },
    ],
    { placeHolder: 'Include which branches?' },
  );
  if (!includeAllBranches) return;

  const body: Record<string, unknown> = {
    name: newRepoName,
    private: visibility.value,
    include_all_branches: includeAllBranches.value,
  };
  if (newRepoOwner && newRepoOwner.trim()) body.owner = newRepoOwner.trim();
  if (description && description.trim()) body.description = description.trim();

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating ${newRepoOwner || '(you)'}/${newRepoName} from ${templateOwner}/${templateRepo}…`,
    },
    async () => {
      const res = await auth.fetch(
        `${auth.apiBaseUrl}/repos/${templateOwner}/${templateRepo}/generate`,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return (await res.json()) as { html_url?: string; full_name?: string; clone_url?: string };
    },
  ).then(
    r => ({ ok: true as const, data: r }),
    err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(
      `Failed to create repository: ${result.error}. ` +
      `Common causes: template repo is not marked as a template, the new repo name already exists, or the token lacks the 'repo' scope on the target owner.`,
    );
    return;
  }

  const { html_url, full_name, clone_url } = result.data;
  const action = await vscode.window.showInformationMessage(
    `Created ${full_name ?? newRepoName}.`,
    'Clone & Open',
    'Open on GitHub',
    'Dismiss',
  );

  if (action === 'Open on GitHub' && html_url) {
    await vscode.env.openExternal(vscode.Uri.parse(html_url));
  } else if (action === 'Clone & Open' && clone_url) {
    try {
      await vscode.commands.executeCommand('git.clone', clone_url);
    } catch (err) {
      await vscode.env.clipboard.writeText(clone_url);
      vscode.window.showWarningMessage(
        `Could not invoke the Git extension (${err instanceof Error ? err.message : String(err)}). The clone URL has been copied to your clipboard.`,
      );
    }
  }
}
