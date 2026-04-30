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
