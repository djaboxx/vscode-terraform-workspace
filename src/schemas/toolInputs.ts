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
}

export const ScaffoldLambdaImageInputSchema = defineSchema<ScaffoldLambdaImageInput>({
  type: 'object',
  required: ['functionName', 'region', 'packerSourceBucket', 'packerCodebuildProject'],
  properties: {
    functionName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    packerSourceBucket: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    packerCodebuildProject: { type: 'string', minLength: 2, maxLength: 150 },
    baseImage: { type: 'string', minLength: 1 },
    handler: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$' },
    memorySize: { type: 'number', minimum: 128, maximum: 10240 },
    timeout: { type: 'number', minimum: 1, maximum: 900 },
    envVars: { type: 'object', additionalProperties: { type: 'string' } },
    extraManagedPolicyArns: { type: 'array', items: { type: 'string', pattern: '^arn:aws[a-z-]*:iam::' } },
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
  productName: string;
  portfolioId: string;
  owner: string;
  supportEmail: string;
  templateBucket: string;
  templateKey: string;
  launchRoleName: string;
  region: string;
  description?: string;
  distributor?: string;
  initialVersion?: string;
}

export const ScaffoldScProductInputSchema = defineSchema<ScaffoldScProductInput>({
  type: 'object',
  required: ['productName', 'portfolioId', 'owner', 'supportEmail', 'templateBucket', 'templateKey', 'launchRoleName', 'region'],
  properties: {
    productName: { type: 'string', minLength: 1, maxLength: 100 },
    portfolioId: { type: 'string', pattern: '^port-[a-z0-9]+$' },
    owner: { type: 'string', minLength: 1 },
    supportEmail: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    templateBucket: { type: 'string', pattern: '^[a-z0-9.-]{3,63}$' },
    templateKey: { type: 'string', minLength: 1 },
    launchRoleName: { type: 'string', minLength: 1, maxLength: 64 },
    region: { type: 'string', pattern: '^[a-z]{2}-[a-z]+-\\d+$' },
    description: { type: 'string' },
    distributor: { type: 'string' },
    initialVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
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
