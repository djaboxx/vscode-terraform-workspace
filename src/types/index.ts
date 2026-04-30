// Core domain types for the Terraform Workspace extension.
// GitHub Environments = Terraform workspaces (1:1 mapping).
// GitHub Actions secrets/variables = Terraform variables.
// GitHub orgs (detected from git remotes) = organizations.

// ─── Organization ────────────────────────────────────────────────────────────

export interface TfOrganization {
  /** GitHub org login (e.g. "HappyPathway") */
  id: string;
  name: string;
  /** GitHub repos discovered in this org that have Terraform config */
  repoSlugs: string[];
  /** Composite action org — usually same as id, configurable */
  compositeActionOrg: string;
  /** Runner group label for GHA workflows */
  runnerGroup: string;
}

// ─── Workspace (= GitHub Environment) ────────────────────────────────────────

export interface TfWorkspace {
  id: string;
  /** GitHub Environment name — also the terraform workspace name */
  name: string;
  orgId: string;
  /** owner/repo slug */
  repoSlug: string;
  /** Branch this environment is tied to */
  branch: string;
  /** S3 bucket for caching artifacts between plan/apply jobs */
  cacheBucket?: string;
  /** S3 bucket for Terraform state */
  stateBucket?: string;
  stateRegion?: string;
  stateKeyPrefix?: string;
  stateDynamoTable?: string;
  /** Working directory within the repo containing .tf files */
  workingDirectory: string;
  /** Whether this is the active workspace in the editor context */
  isActive: boolean;
  /** URL to the GitHub Environment settings */
  htmlUrl?: string;
  lastRunId?: number;
  lastRunStatus?: RunStatus;
  updatedAt?: string;
}

// ─── Variables ───────────────────────────────────────────────────────────────

export type VariableCategory = 'terraform' | 'env';
export type VariableScope = 'environment' | 'repository' | 'organization';

export interface TfVariable {
  id: string;
  key: string;
  /** Plaintext value — only populated locally, never sent to WebView for sensitive vars */
  value?: string;
  sensitive: boolean;
  category: VariableCategory;
  scope: VariableScope;
  /** GitHub Environment name if scope=environment */
  environment?: string;
  repoSlug?: string;
  orgId?: string;
  description?: string;
  hcl?: boolean;
  updatedAt?: string;
}

// ─── Variable Sets (org-level, modeled after TF Cloud variable sets) ─────────

export interface TfVariableSet {
  id: string;
  name: string;
  description?: string;
  orgId: string;
  /** When true, automatically applied to all workspaces in the org */
  global: boolean;
  /** When true, these vars override workspace-level vars (highest priority) */
  priority: boolean;
  /** GitHub Environment names this set is applied to (when global=false) */
  workspaceNames: string[];
  variables: TfVariable[];
  updatedAt?: string;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'skipped'
  | 'pending';

export type RunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

export type RunType = 'plan' | 'apply' | 'destroy';

export interface TfRun {
  id: number;
  type: RunType;
  workspaceId: string;
  repoSlug: string;
  /** GitHub Actions workflow run ID */
  workflowRunId: number;
  /** GitHub Actions workflow run HTML URL */
  htmlUrl: string;
  status: RunStatus;
  conclusion: RunConclusion;
  /** Who triggered the run */
  triggeredBy?: string;
  /** Commit SHA that was planned/applied */
  commitSha?: string;
  /** Whether there are pending changes (from plan output) */
  pendingChanges?: boolean;
  startedAt?: string;
  completedAt?: string;
}

// ─── Bootstrap Config (for WorkflowScaffolder) ───────────────────────────────

export interface BootstrapEnvironmentConfig {
  name: string;
  branch: string;
  branchPattern?: string;
  createBranch?: boolean;
  cacheBucket: string;
  runnerGroup?: string;
  preventSelfReview?: boolean;
  waitTimer?: number;
  canAdminsBypass?: boolean;
  enforceReviewers?: boolean;
  reviewerTeams?: string[];
  reviewerUsers?: string[];
  protectedBranches?: boolean;
  enforceAdmins?: boolean;
  requiredStatusChecks?: { strict: boolean; contexts: string[] };
  requiredApprovals?: number;
  secrets?: Array<{ name: string; value: string }>;
  vars?: Array<{ name: string; value: string }>;
  stateConfig?: {
    bucket: string;
    region: string;
    dynamodbTable?: string;
    keyPrefix?: string;
    setBackend?: boolean;
  };
}

export interface BootstrapRepoConfig {
  name: string;
  repoOrg: string;
  description?: string;
  createRepo?: boolean;
  isPrivate?: boolean;
  enforePrs?: boolean;
  createCodeowners?: boolean;
  codeownersTeam?: string;
  adminTeams?: string[];
  environments: BootstrapEnvironmentConfig[];
  stateBucket?: string;
  stateRegion?: string;
  stateDynamoTable?: string;
  stateKeyPrefix?: string;
  compositeActionOrg?: string;
}

// ─── Composite Action Repos (HappyPathway defaults) ──────────────────────────

export interface CompositeActionRefs {
  checkout: string;
  awsAuth: string;
  ghAuth: string;
  setupTerraform: string;
  terraformInit: string;
  terraformPlan: string;
  terraformApply: string;
  s3Cleanup: string;
}

export const DEFAULT_COMPOSITE_ACTIONS: CompositeActionRefs = {
  checkout: 'gh-actions-checkout@main',
  awsAuth: 'aws-auth@main',
  ghAuth: 'gh-auth@main',
  setupTerraform: 'setup-terraform@main',
  terraformInit: 'terraform-init@main',
  terraformPlan: 'terraform-plan@main',
  terraformApply: 'terraform-apply@main',
  s3Cleanup: 's3-cleanup@main',
};

// ─── Workspace Config (persisted to .vscode/terraform-workspace.json) ────────
//
// This is the exact equivalent of the terraform-github-workspace module inputs,
// but stored as JSON in the VS Code workspace folder instead of in a .tf file.
// One file per VS Code workspace folder — explicitly binds a folder to a
// specific GitHub repo + set of environments.

export interface WorkspaceConfigEnvDeploymentPolicy {
  branch?: string;
  branchPattern?: string;
  createBranch?: boolean;
  createBranchProtection?: boolean;
  protectedBranches?: boolean;
  customBranchPolicies?: boolean;
  enforceAdmins?: boolean;
  restrictBranches?: boolean;
  requiredStatusChecks?: {
    strict?: boolean;
    contexts: string[];
  };
  requiredPullRequestReviews?: {
    dismissStaleReviews?: boolean;
    requireCodeOwnerReviews?: boolean;
    requiredApprovingReviewCount?: number;
  };
}

export interface WorkspaceConfigEnvReviewers {
  users?: string[];
  teams?: string[];
  enforceReviewers?: boolean;
}

export interface WorkspaceConfigEnvStateConfig {
  bucket?: string;
  keyPrefix?: string;
  region?: string;
  dynamodbTable?: string;
  setBackend?: boolean;
}

export interface WorkspaceConfigEnv {
  name: string;
  cacheBucket: string;
  runnerGroup?: string;
  preventSelfReview?: boolean;
  waitTimer?: number;
  canAdminsBypass?: boolean;
  /** Per-environment Terraform/OpenTofu version pin. Falls back to workspace `terraformVersion`, then `vars.terraform_version`. */
  terraformVersion?: string;
  /** Path (relative to repo root) of the per-env tfvars file. Defaults to `varfiles/<env>.tfvars`. */
  varfile?: string;
  reviewers?: WorkspaceConfigEnvReviewers;
  deploymentBranchPolicy?: WorkspaceConfigEnvDeploymentPolicy;
  stateConfig?: WorkspaceConfigEnvStateConfig;
  /** Non-sensitive TF vars injected as TF_VAR_* (GitHub Actions variables) */
  vars?: Array<{ name: string; value: string }>;
  /** Sensitive TF vars injected as TF_VAR_* (GitHub Actions secrets) */
  secrets?: Array<{ name: string; value: string }>;
}

export interface WorkspaceConfigRepo {
  name: string;
  repoOrg: string;
  description?: string;
  createRepo?: boolean;
  isPrivate?: boolean;
  isTemplate?: boolean;
  templateRepoOrg?: string;
  templateRepo?: string;
  enforcePrs?: boolean;
  createCodeowners?: boolean;
  codeownersTeam?: string;
  adminTeams?: string[];
  pullRequestBypassers?: string[];
  repoTopics?: string[];
  archiveOnDestroy?: boolean;
  /** Repo-level GHA variables shared across all environments */
  vars?: Array<{ name: string; value: string }>;
  /** Repo-level GHA secrets shared across all environments */
  secrets?: Array<{ name: string; value: string }>;
}

export interface WorkspaceConfigStateConfig {
  bucket?: string;
  key?: string;
  region?: string;
  dynamodbTable?: string;
  setBackend?: boolean;
  keyPrefix?: string;
}

export interface WorkspaceConfigCompositeActions {
  checkout?: string;
  awsAuth?: string;
  setupTerraform?: string;
  terraformInit?: string;
  terraformPlan?: string;
  terraformApply?: string;
  ghAuth?: string;
  s3Cleanup?: string;
}

/**
 * Root shape of `.vscode/terraform-workspace.json`.
 * Maps 1:1 to the terraform-github-workspace module variables.
 */
export interface WorkspaceConfigProxy {
  http?: string;
  https?: string;
  no?: string;
}

export interface WorkspaceConfig {
  /** Schema version — allows future migration */
  version: 1;
  /** GitHub org that owns composite action repos */
  compositeActionOrg: string;
  /** Default Terraform/OpenTofu version, used when an env doesn't override and no `terraform_version` GHA var is set. */
  terraformVersion?: string;
  /** HTTP(S) proxy passthrough — emitted as `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env vars in workflow steps. */
  proxy?: WorkspaceConfigProxy;
  repo: WorkspaceConfigRepo;
  environments: WorkspaceConfigEnv[];
  stateConfig?: WorkspaceConfigStateConfig;
  compositeActions?: WorkspaceConfigCompositeActions;
}

// ─── Pattern Library entry (HappyPathway module patterns) ────────────────────

export interface HappyPathwayModule {
  /** Terraform registry source path */
  source: string;
  /** Short description of what the module does */
  description: string;
  /** Key variables the module accepts */
  keyVars: string[];
  /** Example usage snippet */
  example?: string;
}
