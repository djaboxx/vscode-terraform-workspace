import { defineSchema } from './defineSchema.js';

/**
 * JSON Schemas for chat-tool inputs.
 *
 * Each schema is the runtime counterpart of the `inputSchema` declared in
 * `package.json` under `contributes.languageModelTools`. Declaring them again
 * here in TypeScript — and validating with these wrappers in every tool's
 * `invoke()` — defends against:
 *   - LMs that hallucinate property names,
 *   - schema drift between `package.json` and the TS interfaces,
 *   - missing required fields that would otherwise crash deep in a handler.
 *
 * Convention: one exported `XxxInputSchema` per registered tool, named to
 * match the TypeScript input interface. Keep field shapes in lock-step with
 * `package.json`.
 */

export interface RunPlanInput {
  workspace?: string;
  workingDirectory?: string;
}

export const RunPlanInputSchema = defineSchema<RunPlanInput>({
  type: 'object',
  properties: {
    workspace: { type: 'string', minLength: 1 },
    workingDirectory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface RunApplyInput {
  workspace: string;
  workingDirectory?: string;
}

export const RunApplyInputSchema = defineSchema<RunApplyInput>({
  type: 'object',
  required: ['workspace'],
  properties: {
    workspace: { type: 'string', minLength: 1 },
    workingDirectory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface SetVariableInput {
  key: string;
  value: string;
  sensitive: boolean;
  category?: 'terraform' | 'env';
  workspace?: string;
  scope?: 'environment' | 'repository' | 'organization';
}

export const SetVariableInputSchema = defineSchema<SetVariableInput>({
  type: 'object',
  required: ['key', 'value', 'sensitive'],
  properties: {
    key: { type: 'string', minLength: 1, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    value: { type: 'string' },
    sensitive: { type: 'boolean' },
    category: { type: 'string', enum: ['terraform', 'env'] },
    workspace: { type: 'string', minLength: 1 },
    scope: { type: 'string', enum: ['environment', 'repository', 'organization'] },
  },
  additionalProperties: false,
});

export interface GenerateCodeInput {
  description: string;
  targetFile?: string;
  useModules?: boolean;
}

export const GenerateCodeInputSchema = defineSchema<GenerateCodeInput>({
  type: 'object',
  required: ['description'],
  properties: {
    description: { type: 'string', minLength: 1 },
    targetFile: { type: 'string', minLength: 1 },
    useModules: { type: 'boolean' },
  },
  additionalProperties: false,
});

export interface SearchTfCodeInput {
  query: string;
  limit?: number;
}

export const SearchTfCodeInputSchema = defineSchema<SearchTfCodeInput>({
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 30 },
  },
  additionalProperties: false,
});

export interface LookupProviderDocInput {
  /** `<namespace>/<name>` (e.g. `hashicorp/aws`). */
  provider: string;
  /** Resource / data-source slug, e.g. `s3_bucket` or `aws_s3_bucket` (prefix stripped). */
  resource: string;
  /** Doc category. Defaults to `resources`. */
  category?: 'resources' | 'data-sources' | 'guides' | 'functions' | 'overview';
  /** Truncate response to this many characters. Defaults to 8000. */
  maxChars?: number;
}

export const LookupProviderDocInputSchema = defineSchema<LookupProviderDocInput>({
  type: 'object',
  required: ['provider', 'resource'],
  properties: {
    provider: { type: 'string', minLength: 3 },
    resource: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: ['resources', 'data-sources', 'guides', 'functions', 'overview'] },
    maxChars: { type: 'number', minimum: 200, maximum: 50000 },
  },
  additionalProperties: false,
});

export interface BootstrapEnvironment {
  name?: string;
  branch?: string;
  enforceReviewers?: boolean;
  reviewerTeams?: string[];
  cacheBucket?: string;
}

export interface BootstrapWorkspaceInput {
  repoName: string;
  repoOrg: string;
  environments: BootstrapEnvironment[];
  stateBucket?: string;
  stateRegion?: string;
}

export const BootstrapWorkspaceInputSchema = defineSchema<BootstrapWorkspaceInput>({
  type: 'object',
  required: ['repoName', 'repoOrg', 'environments'],
  properties: {
    repoName: { type: 'string', minLength: 1 },
    repoOrg: { type: 'string', minLength: 1 },
    environments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          branch: { type: 'string' },
          enforceReviewers: { type: 'boolean' },
          reviewerTeams: { type: 'array', items: { type: 'string' } },
          cacheBucket: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    stateBucket: { type: 'string' },
    stateRegion: { type: 'string' },
  },
  additionalProperties: false,
});

export interface GetRunStatusInput {
  workspace?: string;
  limit?: number;
}

export const GetRunStatusInputSchema = defineSchema<GetRunStatusInput>({
  type: 'object',
  properties: {
    workspace: { type: 'string', minLength: 1 },
    limit: { type: 'number', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
});

export interface DiscoverWorkspaceInput {
  /** Optional: scan a specific subdirectory of the workspace folder. */
  subdirectory?: string;
  /** When true, also write the suggested config to disk after discovery. */
  applyDefaults?: boolean;
}

export const DiscoverWorkspaceInputSchema = defineSchema<DiscoverWorkspaceInput>({
  type: 'object',
  properties: {
    subdirectory: { type: 'string', minLength: 1 },
    applyDefaults: { type: 'boolean' },
  },
  additionalProperties: false,
});

// ─── Variable management ──────────────────────────────────────────────────────

export interface DeleteVariableInput {
  scope: 'environment' | 'repository';
  key: string;
  environment?: string;
  sensitive?: boolean;
}

export const DeleteVariableInputSchema = defineSchema<DeleteVariableInput>({
  type: 'object',
  required: ['scope', 'key'],
  properties: {
    scope: { type: 'string', enum: ['environment', 'repository'] },
    key: { type: 'string', minLength: 1, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    environment: { type: 'string', minLength: 1 },
    sensitive: { type: 'boolean' },
  },
  additionalProperties: false,
});

export interface ResolveVariableInput {
  key: string;
  environment?: string;
}

export const ResolveVariableInputSchema = defineSchema<ResolveVariableInput>({
  type: 'object',
  required: ['key'],
  properties: {
    key: { type: 'string', minLength: 1, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    environment: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

// ─── Deployment review ───────────────────────────────────────────────────────

export interface ReviewDeploymentInput {
  runId: number;
  state: 'approved' | 'rejected';
  environments?: string[];
  comment?: string;
}

export const ReviewDeploymentInputSchema = defineSchema<ReviewDeploymentInput>({
  type: 'object',
  required: ['runId', 'state'],
  properties: {
    runId: { type: 'number', minimum: 1 },
    state: { type: 'string', enum: ['approved', 'rejected'] },
    environments: { type: 'array', items: { type: 'string', minLength: 1 } },
    comment: { type: 'string' },
  },
  additionalProperties: false,
});

// ─── Workflow lint / drift ────────────────────────────────────────────────────

export interface LintWorkflowsInput {
  /** No fields — operates on the active workspace folder. */
}

export const LintWorkflowsInputSchema = defineSchema<LintWorkflowsInput>({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

export interface CheckDriftInput {
  /** No fields — checks all configured environments. */
}

export const CheckDriftInputSchema = defineSchema<CheckDriftInput>({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

// ─── Scaffolders ─────────────────────────────────────────────────────────────

export interface ScaffoldBackendInput {
  bucketName: string;
  region: string;
  dynamodbTable: string;
  kmsKeyAlias?: string;
}

export const ScaffoldBackendInputSchema = defineSchema<ScaffoldBackendInput>({
  type: 'object',
  required: ['bucketName', 'region', 'dynamodbTable'],
  properties: {
    bucketName: { type: 'string', minLength: 3 },
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    dynamodbTable: { type: 'string', minLength: 3 },
    kmsKeyAlias: { type: 'string' },
  },
  additionalProperties: false,
});

export interface ScaffoldOidcTrustInput {
  awsAccountId: string;
  githubOrg: string;
  repo?: string;
  environment?: string;
  oidcProvider?: string;
}

export const ScaffoldOidcTrustInputSchema = defineSchema<ScaffoldOidcTrustInput>({
  type: 'object',
  required: ['awsAccountId', 'githubOrg'],
  properties: {
    awsAccountId: { type: 'string', pattern: '^\\d{12}$' },
    githubOrg: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    environment: { type: 'string', minLength: 1 },
    oidcProvider: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface ScaffoldFromTemplateInput {
  templateOwner: string;
  templateRepo: string;
  newRepoName: string;
  newRepoOwner?: string;
  description?: string;
  privateRepo?: boolean;
  includeAllBranches?: boolean;
}

export const ScaffoldFromTemplateInputSchema = defineSchema<ScaffoldFromTemplateInput>({
  type: 'object',
  required: ['templateOwner', 'templateRepo', 'newRepoName'],
  properties: {
    templateOwner: { type: 'string', minLength: 1 },
    templateRepo: { type: 'string', minLength: 1 },
    newRepoName: { type: 'string', pattern: '^[a-zA-Z0-9._-]+$', minLength: 1 },
    newRepoOwner: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    privateRepo: { type: 'boolean' },
    includeAllBranches: { type: 'boolean' },
  },
  additionalProperties: false,
});

export interface ScaffoldModuleRepoInput {
  moduleName: string;
  provider: string;
  description?: string;
  exampleNames?: string[];
  includeDevcontainer?: boolean;
  requiredVersion?: string;
  targetDirectory?: string;
  overwrite?: boolean;
}

export const ScaffoldModuleRepoInputSchema = defineSchema<ScaffoldModuleRepoInput>({
  type: 'object',
  required: ['moduleName', 'provider'],
  properties: {
    moduleName: { type: 'string', minLength: 1, pattern: '^[a-zA-Z0-9._-]+$' },
    provider: { type: 'string', minLength: 1, pattern: '^[a-z][a-z0-9_-]*$' },
    description: { type: 'string' },
    exampleNames: {
      type: 'array',
      items: { type: 'string', minLength: 1, pattern: '^[a-zA-Z0-9._-]+$' },
    },
    includeDevcontainer: { type: 'boolean' },
    requiredVersion: { type: 'string', minLength: 1 },
    targetDirectory: { type: 'string' },
    overwrite: { type: 'boolean' },
  },
  additionalProperties: false,
});

export interface ScaffoldCodebuildExecutorInput {
  region: string;
  repoFullName: string;
  projectName: string;
  sourceBucketName: string;
  image?: string;
  computeType?: string;
  terraformVersion?: string;
  stateBucketArns?: string[];
  lockTableArn?: string;
  extraManagedPolicyArns?: string[];
}

export const ScaffoldCodebuildExecutorInputSchema = defineSchema<ScaffoldCodebuildExecutorInput>({
  type: 'object',
  required: ['region', 'repoFullName', 'projectName', 'sourceBucketName'],
  properties: {
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    repoFullName: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
    projectName: { type: 'string', pattern: '^[A-Za-z0-9._-]+$', minLength: 2, maxLength: 150 },
    sourceBucketName: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    image: { type: 'string', minLength: 1 },
    computeType: { type: 'string', enum: ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_2XLARGE'] },
    terraformVersion: { type: 'string', minLength: 1 },
    stateBucketArns: { type: 'array', items: { type: 'string', pattern: '^arn:aws[a-z-]*:s3:::[^/]+$' } },
    lockTableArn: { type: 'string', pattern: '^arn:aws[a-z-]*:dynamodb:' },
    extraManagedPolicyArns: { type: 'array', items: { type: 'string', pattern: '^arn:aws[a-z-]*:iam::' } },
  },
  additionalProperties: false,
});

export interface DispatchCodebuildRunInput {
  command: 'plan' | 'apply';
  workspace: string;
}

export const DispatchCodebuildRunInputSchema = defineSchema<DispatchCodebuildRunInput>({
  type: 'object',
  required: ['command', 'workspace'],
  properties: {
    command: { type: 'string', enum: ['plan', 'apply'] },
    workspace: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

// ── Lambda image (L1) ────────────────────────────────────────────────────────

export interface ScaffoldLambdaImageInput {
  functionName: string;
  region: string;
  packerSourceBucket: string;
  packerCodebuildProject: string;
  baseImage?: string;
  handler?: string;
  memorySize?: number;
  timeout?: number;
  envVars?: Record<string, string>;
  extraManagedPolicyArns?: string[];
  // VPC support
  subnetNameTag?: string;
  securityGroupName?: string;
  // CodeBuild integration
  codebuildProjectName?: string;
  codebuildRoleName?: string;
  githubTokenSecretName?: string;
}

export const ScaffoldLambdaImageInputSchema = defineSchema<ScaffoldLambdaImageInput>({
  type: 'object',
  required: ['functionName', 'region', 'packerSourceBucket', 'packerCodebuildProject'],
  properties: {
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    region: { type: 'string', pattern: '^[a-z]{2}(-gov)?-[a-z]+-\\d+$' },
    packerSourceBucket: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    packerCodebuildProject: { type: 'string', minLength: 2, maxLength: 150 },
    baseImage: { type: 'string', minLength: 1 },
    handler: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$' },
    memorySize: { type: 'number', minimum: 128, maximum: 10240 },
    timeout: { type: 'number', minimum: 1, maximum: 900 },
    envVars: { type: 'object', additionalProperties: { type: 'string' } },
    extraManagedPolicyArns: { type: 'array', items: { type: 'string' } },
    subnetNameTag: { type: 'string', minLength: 1 },
    securityGroupName: { type: 'string', minLength: 1 },
    codebuildProjectName: { type: 'string', minLength: 2, maxLength: 150 },
    codebuildRoleName: { type: 'string', minLength: 1 },
    githubTokenSecretName: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface BuildLambdaImageInput {
  functionName: string;
  region: string;
  packerSourceBucket: string;
  packerCodebuildProject: string;
  ecrRepoName: string;
  imageTag?: string;
  /** Workspace-relative path to the lambda image directory (e.g. infra/lambda-image-myfn). */
  directory: string;
}

export const BuildLambdaImageInputSchema = defineSchema<BuildLambdaImageInput>({
  type: 'object',
  required: ['functionName', 'region', 'packerSourceBucket', 'packerCodebuildProject', 'ecrRepoName', 'directory'],
  properties: {
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    packerSourceBucket: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    packerCodebuildProject: { type: 'string', minLength: 2, maxLength: 150 },
    ecrRepoName: { type: 'string', pattern: '^[a-z0-9._/-]{2,256}$' },
    imageTag: { type: 'string', minLength: 1, maxLength: 128 },
    directory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

// ── Service Catalog (L3 + L4) ────────────────────────────────────────────────

export interface ScaffoldScProductInput {
  /** Short slug used for resource names and the auto-created S3 bucket. */
  productSlug: string;
  portfolioName: string;
  portfolioDescription?: string;
  owner: string;
  templateKey: string;
  region: string;
  description?: string;
  initialVersion?: string;
  /** Full Lambda ARN for the launch role's InvokeFunction policy statement. */
  lambdaArn?: string;
  /** IAM principal ARNs (or IAM_PATTERN globs) granted portfolio access. */
  principalArns?: string[];
  /** When set, uses an existing launch role by this name instead of creating one. */
  existingLaunchRoleName?: string;
}

export const ScaffoldScProductInputSchema = defineSchema<ScaffoldScProductInput>({
  type: 'object',
  required: ['productSlug', 'portfolioName', 'owner', 'templateKey', 'region'],
  properties: {
    productSlug: { type: 'string', pattern: '^[a-z0-9-]{1,60}$' },
    portfolioName: { type: 'string', minLength: 1 },
    portfolioDescription: { type: 'string' },
    owner: { type: 'string', minLength: 1 },
    templateKey: { type: 'string', minLength: 1 },
    region: { type: 'string', pattern: '^[a-z]{2}(-gov)?-[a-z]+-\\d+$' },
    description: { type: 'string' },
    initialVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    lambdaArn: { type: 'string' },
    principalArns: { type: 'array', items: { type: 'string' } },
    existingLaunchRoleName: { type: 'string' },
  },
  additionalProperties: false,
});

export interface BumpScArtifactInput {
  productResourceName: string;
  newVersion: string;
  templateBucket: string;
  templateKey: string;
  description?: string;
  /** Workspace-relative directory containing the existing product.tf to append to. */
  directory: string;
}

export const BumpScArtifactInputSchema = defineSchema<BumpScArtifactInput>({
  type: 'object',
  required: ['productResourceName', 'newVersion', 'templateBucket', 'templateKey', 'directory'],
  properties: {
    productResourceName: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
    newVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    templateBucket: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    templateKey: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    directory: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface DryRenderScProductInput {
  /** JSON schema describing the SC form's input parameters. */
  schema: Record<string, unknown>;
  /** Sample inputs to validate against the schema. */
  sample: Record<string, unknown>;
}

export const DryRenderScProductInputSchema = defineSchema<DryRenderScProductInput>({
  type: 'object',
  required: ['schema', 'sample'],
  properties: {
    schema: { type: 'object' },
    sample: { type: 'object' },
  },
  additionalProperties: false,
});



// ───────────────────────────────────────────────────────────────────────────
// Python developer inner-loop (Phase A of docs/plans/python-lambda-devloop.md).
// All venv-only — the target environment cannot run Docker.
// ───────────────────────────────────────────────────────────────────────────

export interface ScaffoldPythonDevEnvInput {
  /** Workspace-relative path to the lambda image dir (e.g. "infra/lambda-image-my-fn"). */
  directory: string;
  /** Logical function name. */
  functionName: string;
  /** Python version to pin (e.g. "3.12"). */
  pythonVersion: string;
  /** Handler dotted path (e.g. "handler.lambda_handler"). */
  handler: string;
  /** Optional AWS region — baked into the devcontainer post-create env. */
  region?: string;
}

export const ScaffoldPythonDevEnvInputSchema = defineSchema<ScaffoldPythonDevEnvInput>({
  type: 'object',
  required: ['directory', 'functionName', 'pythonVersion', 'handler'],
  properties: {
    directory: { type: 'string', minLength: 1 },
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    pythonVersion: { type: 'string', pattern: '^3\\.\\d+$' },
    handler: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)+$' },
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$', nullable: true },
  },
  additionalProperties: false,
});

export interface InvokeLambdaLocallyInput {
  /** Workspace-relative path to the lambda image dir. */
  directory: string;
  /** Logical function name (used for log context). */
  functionName: string;
  /** Dotted handler path (e.g. "handler.lambda_handler"). */
  handler: string;
  /** Path to the JSON event file (workspace-relative or absolute). */
  eventPath: string;
  /** Optional explicit Python interpreter override. */
  pythonPath?: string;
}

export const InvokeLambdaLocallyInputSchema = defineSchema<InvokeLambdaLocallyInput>({
  type: 'object',
  required: ['directory', 'functionName', 'handler', 'eventPath'],
  properties: {
    directory: { type: 'string', minLength: 1 },
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    handler: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)+$' },
    eventPath: { type: 'string', minLength: 1 },
    pythonPath: { type: 'string', nullable: true },
  },
  additionalProperties: false,
});

export interface TailLambdaLogsInput {
  region: string;
  functionName: string;
  filterPattern?: string;
  sinceMinutes?: number;
}

export const TailLambdaLogsInputSchema = defineSchema<TailLambdaLogsInput>({
  type: 'object',
  required: ['region', 'functionName'],
  properties: {
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    filterPattern: { type: 'string', nullable: true },
    sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440, nullable: true },
  },
  additionalProperties: false,
});

// ── GitHub Actions Runner (ghe-runner) tools ───────────────────────────────

export interface RunnerGetStatusInput {
  /**
   * Optional name of a specific runner environment, e.g. "csvd-dev-ew".
   * When omitted, status for all discovered environments is returned.
   */
  environment?: string;
}

export const RunnerGetStatusInputSchema = defineSchema<RunnerGetStatusInput>({
  type: 'object',
  properties: {
    environment: { type: 'string', minLength: 1, nullable: true },
  },
  additionalProperties: false,
});

export interface RunnerRefreshTokenInput {
  /** Name of the runner environment whose token Lambda should be invoked. */
  environment?: string;
}

export const RunnerRefreshTokenInputSchema = defineSchema<RunnerRefreshTokenInput>({
  type: 'object',
  properties: {
    environment: { type: 'string', minLength: 1, nullable: true },
  },
  additionalProperties: false,
});

export interface RunnerForceRedeployInput {
  /** Name of the runner environment to redeploy. */
  environment?: string;
}

export const RunnerForceRedeployInputSchema = defineSchema<RunnerForceRedeployInput>({
  type: 'object',
  properties: {
    environment: { type: 'string', minLength: 1, nullable: true },
  },
  additionalProperties: false,
});

export interface RunnerScaleInput {
  /** Name of the runner environment to scale. */
  environment?: string;
  /** New ECS desired task count. Use 0 to stop all runners. */
  desiredCount: number;
}

export const RunnerScaleInputSchema = defineSchema<RunnerScaleInput>({
  type: 'object',
  required: ['desiredCount'],
  properties: {
    environment: { type: 'string', minLength: 1, nullable: true },
    desiredCount: { type: 'integer', minimum: 0, maximum: 20 },
  },
  additionalProperties: false,
});

export interface RunnerGetLogsInput {
  /** Name of the runner environment. */
  environment?: string;
  /**
   * Explicit CloudWatch log group name. When omitted, the first group
   * matching /ecs-ghe-runners* in the environment's region is used.
   */
  logGroup?: string;
  /** CloudWatch filter pattern, e.g. "error" or "Job". */
  filterPattern?: string;
  /** Number of log lines to return (default 50, max 100). */
  lines?: number;
}

export const RunnerGetLogsInputSchema = defineSchema<RunnerGetLogsInput>({
  type: 'object',
  properties: {
    environment: { type: 'string', minLength: 1, nullable: true },
    logGroup: { type: 'string', minLength: 1, nullable: true },
    filterPattern: { type: 'string', nullable: true },
    lines: { type: 'integer', minimum: 1, maximum: 100, nullable: true },
  },
  additionalProperties: false,
});

// ─── terraform_self_introspect ────────────────────────────────────────────────

export interface SelfIntrospectInput {
  /**
   * What to do against this extension's own source repository
   * (`Happypathway/vscode-terraform-workspace`).
   *  - `list`: list directory contents at `path` (default repo root).
   *  - `read`: read a single file at `path` (must be specified).
   *  - `search`: GitHub code search restricted to this repo for `query`.
   */
  operation: 'list' | 'read' | 'search';
  /** Repo-relative path. Used by `list` and `read`. */
  path?: string;
  /** Free-text code search query. Used by `search`. */
  query?: string;
  /** Git ref (branch / tag / sha). Defaults to `main`. */
  ref?: string;
  /** Max search results to return (default 15, max 30). */
  limit?: number;
}

export const SelfIntrospectInputSchema = defineSchema<SelfIntrospectInput>({
  type: 'object',
  required: ['operation'],
  properties: {
    operation: { type: 'string', enum: ['list', 'read', 'search'] },
    path: { type: 'string', nullable: true },
    query: { type: 'string', nullable: true },
    ref: { type: 'string', nullable: true },
    limit: { type: 'integer', minimum: 1, maximum: 30, nullable: true },
  },
  additionalProperties: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// terraform_remember / terraform_recall — agent persistent memory
// ─────────────────────────────────────────────────────────────────────────────

export interface RememberInput {
  /** Topic key for grouping notes — usually `repo:{owner}/{name}` or a free-form label. */
  topic: string;
  /** Note category. */
  kind: 'fact' | 'decision' | 'hypothesis' | 'failure' | 'todo';
  /** The note content itself. Keep it short and self-contained. */
  content: string;
}

export const RememberInputSchema = defineSchema<RememberInput>({
  type: 'object',
  required: ['topic', 'kind', 'content'],
  properties: {
    topic: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['fact', 'decision', 'hypothesis', 'failure', 'todo'] },
    content: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export interface RecallInput {
  /** Topic key — same shape as in `terraform_remember`. */
  topic: string;
  /** Max notes to return for this topic. Defaults to 20. */
  limit?: number;
  /** When true, also include recent failures across all topics (default false). */
  includeRecentFailures?: boolean;
  /** When true, also include open todos/hypotheses across all topics (default false). */
  includeOpenItems?: boolean;
}

export const RecallInputSchema = defineSchema<RecallInput>({
  type: 'object',
  required: ['topic'],
  properties: {
    topic: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, nullable: true },
    includeRecentFailures: { type: 'boolean', nullable: true },
    includeOpenItems: { type: 'boolean', nullable: true },
  },
  additionalProperties: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// terraform_match_playbook — proactive playbook discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchPlaybookInput {
  /** Free-text description of what the user wants to do. */
  query: string;
  /** Max matches to return. Defaults to 5. */
  limit?: number;
}

export const MatchPlaybookInputSchema = defineSchema<MatchPlaybookInput>({
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 20, nullable: true },
  },
  additionalProperties: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// terraform_recall_decisions — search past tradeoff decisions by keyword
// ─────────────────────────────────────────────────────────────────────────────

export interface RecallDecisionsInput {
  /** Free-text description of the decision being faced. */
  query: string;
  /** Max decisions to return. Defaults to 5. */
  limit?: number;
}

export const RecallDecisionsInputSchema = defineSchema<RecallDecisionsInput>({
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 20, nullable: true },
  },
  additionalProperties: false,
});
