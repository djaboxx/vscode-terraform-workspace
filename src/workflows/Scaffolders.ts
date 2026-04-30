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
  const cfg = vscode.workspace.getConfiguration('terraformWorkspace');
  const enableOidc = cfg.get<boolean>('auth.enableOidc', true);
  if (!enableOidc) {
    const choice = await vscode.window.showInformationMessage(
      'OIDC appears disabled for this workspace. The extension can show guidance for GitHub App or Personal Access Token (PAT) fallbacks.',
      'Open Guidance',
      'Continue Anyway',
    );
    if (choice === 'Open Guidance') {
      try {
        const doc = await vscode.workspace.openTextDocument('README.md');
        await vscode.window.showTextDocument(doc);
      } catch {
        vscode.window.showInformationMessage('Open the README for more details about non-OIDC fallbacks.');
      }
      return;
    }
  }

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

// ─── CodeBuild executor (Pattern A: dispatched via aws codebuild start-build) ─

export interface CodeBuildExecutorInputs {
  /** AWS region the CodeBuild project lives in. */
  region: string;
  /** GitHub `<owner>/<repo>` the executor serves (used in tags + descriptions). */
  repoFullName: string;
  /** CodeBuild project name. Becomes `codebuild.project` in workspace config. */
  projectName: string;
  /**
   * S3 bucket the GHA orchestrator uploads the repo zip to. The CodeBuild
   * project's S3 source pulls from here, and the buildspec writes plan
   * artifacts back. Created by this module.
   */
  sourceBucketName: string;
  /**
   * Optional managed CodeBuild image. Defaults to the standard Amazon Linux
   * image which has terraform/tofu installable via the buildspec.
   */
  image?: string;
  /** Optional compute type. Defaults to `BUILD_GENERAL1_MEDIUM` (7 GiB / 4 vCPU). */
  computeType?: string;
  /** Terraform / OpenTofu version the buildspec installs. */
  terraformVersion?: string;
  /** Optional VPC config — required for builds that need to reach private subnets. */
  vpcConfig?: { vpcId: string; subnetIds: string[]; securityGroupIds: string[] };
  /** S3 bucket ARNs the build role needs read/write on (tfstate + cache). Empty list = no S3 perms beyond the source bucket. */
  stateBucketArns?: string[];
  /** Optional DynamoDB table ARN for terraform state locking. */
  lockTableArn?: string;
  /** Extra managed-policy ARNs to attach (e.g. `arn:aws:iam::aws:policy/AdministratorAccess` for sandboxes, or a tightly-scoped provider-permissions policy for prod). */
  extraManagedPolicyArns?: string[];
}

/**
 * Generates a Terraform module that provisions an AWS CodeBuild project used
 * as a *dispatched* terraform executor (Pattern A — same shape as
 * djaboxx/packer-pipeline). The GHA workflow uploads the repo to an S3 source
 * bucket and calls `aws codebuild start-build`; CodeBuild runs the buildspec
 * which performs `terraform init`/`plan`/`apply` and writes artifacts back to
 * S3. No GHE-Server↔AWS webhook is required.
 *
 * After apply, set this in `.vscode/terraform-workspace.json`:
 *
 *   "executor": "codebuild",
 *   "codebuild": {
 *     "project":      "<projectName>",
 *     "sourceBucket": "<sourceBucketName>",
 *     "region":       "<region>"
 *   }
 *
 * Then re-run "Terraform: Sync Workflows".
 */
export function codebuildExecutorTf(inputs: CodeBuildExecutorInputs): string {
  const image = inputs.image ?? 'aws/codebuild/amazonlinux2-x86_64-standard:5.0';
  const compute = inputs.computeType ?? 'BUILD_GENERAL1_MEDIUM';
  const tfVersion = inputs.terraformVersion ?? '1.9.5';

  const stateArns = (inputs.stateBucketArns ?? [])
    .flatMap((arn) => [JSON.stringify(arn), JSON.stringify(`${arn}/*`)])
    .join(', ');
  const lockArn = inputs.lockTableArn ? JSON.stringify(inputs.lockTableArn) : '';
  const extraAttachments = (inputs.extraManagedPolicyArns ?? [])
    .map(
      (arn, i) => `resource "aws_iam_role_policy_attachment" "extra_${i}" {
  role       = aws_iam_role.executor.name
  policy_arn = "${arn}"
}`,
    )
    .join('\n\n');

  const stateStatement = stateArns
    ? `  statement {
    sid     = "TerraformStateS3"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [${stateArns}]
  }`
    : '';
  const lockStatement = lockArn
    ? `  statement {
    sid     = "TerraformStateLock"
    effect  = "Allow"
    actions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [${lockArn}]
  }`
    : '';

  const vpcBlock = inputs.vpcConfig
    ? `  vpc_config {
    vpc_id             = "${inputs.vpcConfig.vpcId}"
    subnets            = ${JSON.stringify(inputs.vpcConfig.subnetIds)}
    security_group_ids = ${JSON.stringify(inputs.vpcConfig.securityGroupIds)}
  }`
    : '';

  return `# CodeBuild executor for ${inputs.repoFullName}
# Generated by the Terraform Workspace VS Code extension.
#
# After \`terraform apply\`, set this in .vscode/terraform-workspace.json:
#
#   "executor": "codebuild",
#   "codebuild": {
#     "project":      "${inputs.projectName}",
#     "sourceBucket": "${inputs.sourceBucketName}",
#     "region":       "${inputs.region}"
#   }
#
# Then re-run "Terraform: Sync Workflows".

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.40" }
  }
}

provider "aws" {
  region = "${inputs.region}"
}

# ─── S3 source / artifact bucket ────────────────────────────────────────────

resource "aws_s3_bucket" "source" {
  bucket        = "${inputs.sourceBucketName}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "source" {
  bucket = aws_s3_bucket.source.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    filter { prefix = "terraform-src/" }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
  rule {
    id     = "expire-artifacts"
    status = "Enabled"
    filter { prefix = "terraform-artifacts/" }
    expiration { days = 30 }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# ─── IAM ────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "executor" {
  name               = "${inputs.projectName}-executor"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  description        = "Terraform executor (CodeBuild) for ${inputs.repoFullName}"
}

data "aws_iam_policy_document" "baseline" {
  statement {
    sid     = "Logs"
    effect  = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
  statement {
    sid     = "SourceBucketRW"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.source.arn,
      "\${aws_s3_bucket.source.arn}/*",
    ]
  }
${stateStatement}
${lockStatement}
}

resource "aws_iam_role_policy" "baseline" {
  role   = aws_iam_role.executor.id
  policy = data.aws_iam_policy_document.baseline.json
}

${extraAttachments}

# ─── CodeBuild project ──────────────────────────────────────────────────────

resource "aws_codebuild_project" "executor" {
  name         = "${inputs.projectName}"
  description  = "Terraform executor for ${inputs.repoFullName} (dispatched via aws codebuild start-build)"
  service_role = aws_iam_role.executor.arn

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    type            = "LINUX_CONTAINER"
    image           = "${image}"
    compute_type    = "${compute}"
    privileged_mode = false

    environment_variable {
      name  = "TERRAFORM_VERSION"
      value = "${tfVersion}"
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = "${inputs.region}"
    }
  }

  source {
    type      = "S3"
    location  = "\${aws_s3_bucket.source.bucket}/terraform-src/"
    buildspec = file("\${path.module}/buildspec.yml")
  }

  logs_config {
    cloudwatch_logs { status = "ENABLED" }
  }
${vpcBlock}
}

# ─── Outputs ────────────────────────────────────────────────────────────────

output "codebuild_config" {
  description = "Paste this under the top-level \\"codebuild\\" key in .vscode/terraform-workspace.json"
  value = {
    project      = aws_codebuild_project.executor.name
    sourceBucket = aws_s3_bucket.source.bucket
    region       = "${inputs.region}"
  }
}

output "executor_role_arn" {
  value       = aws_iam_role.executor.arn
  description = "IAM role the CodeBuild project assumes when running terraform. Attach extra provider permissions to this role."
}
`;
}

/**
 * Static buildspec that runs alongside the executor module. Save this as
 * `buildspec.yml` in the same directory as the generated `main.tf`.
 *
 * Reads env vars set by `aws codebuild start-build --environment-variables-override`:
 *   - TF_COMMAND       (plan|apply)
 *   - TF_WORKSPACE     (workspace/env name)
 *   - ARTIFACT_BUCKET  (where to upload tfplan + summary)
 *   - ARTIFACT_KEY     (S3 prefix for this run's artifacts)
 *   - GITHUB_REPOSITORY (informational)
 *   - GITHUB_SHA       (informational)
 *
 * The repo zip is auto-extracted by CodeBuild from the S3 source.
 */
export function codebuildExecutorBuildspec(): string {
  return `version: 0.2

env:
  variables:
    TF_IN_AUTOMATION: "true"
    TF_INPUT: "false"

phases:
  install:
    commands:
      - echo "Installing Terraform \${TERRAFORM_VERSION}"
      - curl -fsSL "https://releases.hashicorp.com/terraform/\${TERRAFORM_VERSION}/terraform_\${TERRAFORM_VERSION}_linux_amd64.zip" -o /tmp/tf.zip
      - unzip -q /tmp/tf.zip -d /usr/local/bin/
      - terraform version

  pre_build:
    commands:
      - 'echo "Run: \${TF_COMMAND} workspace=\${TF_WORKSPACE} repo=\${GITHUB_REPOSITORY} sha=\${GITHUB_SHA}"'
      - terraform init -input=false
      - terraform workspace select "\${TF_WORKSPACE}" || terraform workspace new "\${TF_WORKSPACE}"

  build:
    commands:
      - |
        case "\${TF_COMMAND}" in
          plan)
            terraform plan -input=false -out=tfplan -no-color | tee plan.out
            terraform show -no-color tfplan > plan.txt
            terraform show -json tfplan > plan.json
            ;;
          apply)
            terraform plan -input=false -out=tfplan -no-color | tee plan.out
            terraform show -no-color tfplan > plan.txt
            terraform apply -input=false -no-color tfplan | tee apply.out
            ;;
          *)
            echo "Unknown TF_COMMAND: \${TF_COMMAND}" >&2
            exit 64
            ;;
        esac

  post_build:
    commands:
      - |
        if [ -n "\${ARTIFACT_BUCKET:-}" ] && [ -n "\${ARTIFACT_KEY:-}" ]; then
          for f in tfplan plan.out plan.txt plan.json apply.out; do
            [ -f "\$f" ] && aws s3 cp "\$f" "s3://\${ARTIFACT_BUCKET}/\${ARTIFACT_KEY}\$f" || true
          done
        fi
`;
}

