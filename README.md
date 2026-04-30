![Terraform Workspace](images/banner.png)

# Terraform Workspace — VS Code Extension

> AI-powered Terraform workspace manager backed by GitHub Actions and [HappyPathway](https://github.com/HappyPathway) infrastructure patterns.

[![VS Code Engine](https://img.shields.io/badge/vscode-%5E1.95.0-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![GitHub Actions](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=github-actions)](https://github.com/features/actions)

---

## Install (from clone)

This extension is not on the Marketplace. Install it directly from the repo:

```bash
git clone https://github.com/HappyPathway/vscode-terraform-workspace.git
cd vscode-terraform-workspace
npm install
npm run package
code --install-extension terraform-workspace-0.3.0.vsix --force
```

Re-run the last two lines whenever you pull updates. For day-to-day development use `npm run watch` and press `F5` from the cloned folder to launch an Extension Development Host.

**Remote-SSH / WSL / Dev Containers:** the extension is marked `extensionKind: workspace`, so VS Code will install and run it on the **remote host**, not your local UI host. Run the install command in a terminal on the same machine VS Code Server is running on.

---

## What Is This?

**Terraform Workspace** started as a VS Code bridge between your editor and GitHub Actions for Terraform plan/apply, and has grown into an AI-driven **IaC delivery cockpit** for AWS-centric teams. It now covers four pillars:

1. **Terraform on GitHub Actions** — workspace-per-environment model, S3 state, OIDC, scaffold/sync/lint/drift/run from the editor or `@terraform` chat. *No Terraform Cloud, no local `terraform apply`.*
2. **AWS CodeBuild executors** — switch any workspace from inline GHA execution to AWS CodeBuild (zip → S3 → `start-build` → tail logs → fetch plan artifacts). Trigger plan/apply directly from VS Code, no GHA round-trip.
3. **Lambda container images via packer-pipeline** — scaffold a Packer + Terraform module that builds an OCI image into ECR through an existing `packer-pipeline` CodeBuild project, then pin the image digest into a `aws_lambda_function` (`package_type = "Image"`).
4. **AWS Service Catalog product authoring** — scaffold portfolio-attached products with launch constraints, additively bump provisioning artifacts (semver), generate CloudFormation `Rules` from a JSON Schema, and dry-render sample form inputs against the schema before publishing.

The AI layer — exposed as the `@terraform` chat participant and 28 language model tools — understands these models deeply and can generate code, trigger runs, manage variables, scaffold pipelines, build images, and bootstrap repositories through natural language.

### Terraform Workspace Model

The Terraform side supports two repo models:

- **GHA-Environment repos** (`useGhaEnvironments: true`, the default) — each Terraform workspace maps 1:1 to a GitHub Environment, which gates plan/apply runs with deployment protection rules.
- **Flat repos** (`useGhaEnvironments: false`) — each workspace is a named run-configuration without a backing GitHub Environment. S3 state is still isolated per workspace; no GHA Environment gate is created.

The core concept mapping for GHA-Environment repos:

| Concept | Backed by |
|---|---|
| Terraform workspace | GitHub Environment (or named workspace for flat repos) |
| Workspace variable | GitHub Actions Variable (`TF_VAR_*`) |
| Workspace secret | GitHub Actions Encrypted Secret |
| Plan / Apply run | GitHub Actions `workflow_dispatch` (or AWS CodeBuild project, when `executor: "codebuild"`) |
| Terraform state | S3 backend (DynamoDB lock table) |
| Composite actions | [HappyPathway](https://github.com/HappyPathway) reusable action repos |

---

## Architecture

```
VS Code Editor
├── @terraform chat participant          ← natural-language interface (tool-call mode)
│   └── Auto-routes requests to the 31 `terraform_*` LM tools below.
├── Language Model Tools (31 tools)      ← Copilot agent tools
│   ├── terraform_run_plan
│   ├── terraform_run_apply
│   ├── terraform_get_state
│   ├── terraform_list_workspaces
│   ├── terraform_list_variables
│   ├── terraform_set_variable
│   ├── terraform_delete_variable
│   ├── terraform_resolve_variable
│   ├── terraform_generate_code
│   ├── terraform_bootstrap_workspace
│   ├── terraform_discover_workspace
│   ├── terraform_read_config
│   ├── terraform_update_config
│   ├── terraform_sync_workflows
│   ├── terraform_lint_workflows
│   ├── terraform_check_drift
│   ├── terraform_get_run_status
│   ├── terraform_review_deployment
│   ├── terraform_scaffold_backend
│   ├── terraform_scaffold_oidc_trust
│   ├── terraform_scaffold_from_template
│   ├── terraform_scaffold_module_repo
│   └── terraform_search_tf_code
│
├── Tree Views (Activity Bar)
│   ├── Workspaces    ← GitHub Environments
│   ├── Variables & Secrets
│   └── Run History   ← GitHub Actions runs
│
└── Workspace Config Panel              ← .vscode/terraform-workspace.json editor
    ├── Repository settings
    ├── S3 state backend config
    ├── Composite action ref overrides
    └── Per-environment configuration
            ├── Branch protection policy
            ├── Reviewer teams
            ├── State config overrides
            ├── Environment variables
            └── Environment secrets

GitHub API Layer
├── GithubActionsClient     ← workflow dispatch, run polling, log streaming
├── GithubEnvironmentsClient← environments, env/repo secrets & variables
└── GithubOrgsClient        ← org-level variable sets, teams

Auth: VS Code built-in GitHub OAuth (repo + read:org + workflow scopes)
```

---

## Features

### Call Notes

- Open `Terraform: Open Call Notes` from the Command Palette or the status bar to capture meeting or call notes.
- Notes are saved to `.callnotes/callnotes-<date>.md` in your workspace.
- The extension extracts action items (supports `-`, `TODO`, or `ACTION` markers) and detects assignees using `@username` and due dates in `YYYY-MM-DD` format. A draft work plan is generated and opened as a Markdown document for review.


### `@terraform` Chat Participant

Bring Terraform operations into GitHub Copilot Chat. The participant runs in **tool-call mode** with all 31 `terraform_*` language model tools available, so natural language requests dispatch real actions:

```
@terraform plan staging
@terraform apply production
@terraform list workspaces
@terraform what variables does the production env have?
@terraform scaffold a new repo from happypathway/template-aws-module called terraform-aws-thing
@terraform search aws_s3_bucket replication
@terraform generate an S3 bucket with versioning enabled
@terraform explain the current workspace configuration
```

The participant uses the active `.vscode/terraform-workspace.json` as context, so the AI always knows which repo and environments you're working with.

### Activity Bar — Three Views

**Workspaces view** — Lists all GitHub Environments for the active repository. Each item maps 1:1 to a Terraform workspace. Inline actions: Select, Plan, Apply, Open in GitHub.

**Variables & Secrets view** — Hierarchical view of all GitHub Actions variables and secrets grouped by scope:
- `Env: production` / `Env: staging` — environment-scoped
- `Repository` — repo-scoped
- `Org: MyOrg` — org-scoped (variable sets)

Secret *values* are never shown (GitHub doesn't return them) — only names and metadata.

**Run History view** — Recent GitHub Actions workflow runs for the active repo. Click any run to open it in GitHub. Status icons reflect live run state.

### Workspace Config Panel

A structured WebView form bound to `.vscode/terraform-workspace.json` — the single source of truth for a workspace configuration. Replaces writing raw JSON for the `terraform-github-workspace` module inputs.

Sections:
- **Repository** — name, org, PR enforcement, CODEOWNERS, admin teams, topics, repo-level vars/secrets
- **Terraform State (S3)** — bucket, region, key prefix, DynamoDB table, per-environment backend flag
- **Composite Action Refs** — pin specific versions of the HappyPathway reusable actions (checkout, aws-auth, terraform-init, terraform-plan, terraform-apply, s3-cleanup)
- **Environments / Workspaces** — collapsible cards per workspace with branch policies, reviewer teams, wait timers, per-workspace state overrides, env vars and secrets. The key is `environments` for GHA-Environment repos and `workspaces` for flat repos; the extension reads both interchangeably.

Changes save directly to `.vscode/terraform-workspace.json`. The panel reloads automatically if the file changes externally (e.g. a `git pull`).

### Language Model Tools

Thirty-one tools exposed to GitHub Copilot and any VS Code LM-aware extension:

| Tool | Description |
|---|---|
| `terraform_run_plan` | Dispatch a plan workflow for a workspace |
| `terraform_run_apply` | Dispatch an apply workflow (requires confirmation) |
| `terraform_get_state` | Summarise the last successful apply run |
| `terraform_list_workspaces` | List all GitHub Environments for the repo |
| `terraform_list_variables` | List variables/secrets at any scope |
| `terraform_set_variable` | Create or update a variable or secret |
| `terraform_delete_variable` | Delete a variable or secret (requires confirmation) |
| `terraform_resolve_variable` | Trace a variable across org/repo/env scopes |
| `terraform_generate_code` | AI-generate Terraform HCL from a description |
| `terraform_bootstrap_workspace` | Scaffold `.vscode/terraform-workspace.json` |
| `terraform_discover_workspace` | Auto-discover workspace defaults from git, .tf, workflows, and GitHub Environments |
| `terraform_read_config` | Read the current workspace config as JSON |
| `terraform_update_config` | Patch repo, state, or composite action config |
| `terraform_sync_workflows` | Write `.github/workflows/terraform-*.yml` from config |
| `terraform_lint_workflows` | Run `actionlint` over generated workflows |
| `terraform_check_drift` | Find environments whose latest plan exited with code 2 |
| `terraform_get_run_status` | Latest plan/apply run status per workspace |
| `terraform_review_deployment` | Approve or reject pending deployment(s) (requires confirmation) |
| `terraform_scaffold_backend` | Generate S3 + DynamoDB backend bootstrap HCL |
| `terraform_scaffold_oidc_trust` | Generate AWS IAM OIDC trust policy JSON |
| `terraform_scaffold_from_template` | Create a new GitHub repo from a template repository |
| `terraform_scaffold_module_repo` | Generate the standard Terraform module skeleton (`main.tf`/`variables.tf`/`outputs.tf`/`versions.tf` + `examples/` + README with terraform-docs markers) |
| `terraform_search_tf_code` | Search HCL in local workspace + GitHub org |
| `terraform_dispatch_codebuild_run` | Dispatch a plan/apply into the configured AWS CodeBuild executor |
| `terraform_scaffold_lambda_image` | Scaffold a Packer + Terraform module that builds an OCI image and deploys it as a Lambda function |
| `terraform_build_lambda_image` | Zip → S3 → `packer-pipeline` CodeBuild → capture ECR digest → write `terraform.tfvars.json` |
| `terraform_scaffold_sc_product` | Scaffold an AWS Service Catalog product, portfolio association, and LAUNCH constraint |
| `terraform_bump_sc_artifact` | Additively add a new versioned provisioning artifact to an existing product |
| `terraform_dryrender_sc_product` | Validate sample form inputs against a JSON Schema before publishing the product |
| `terraform_scaffold_python_dev_env` | Layer a Python dev loop (pyproject + pytest + ruff + mypy + Makefile + devcontainer + launch.json + local-invoke driver) onto an existing `infra/lambda-image-<fn>/` dir |
| `terraform_invoke_lambda_locally` | Run the Lambda handler in a local Python venv against a JSON event — no Docker required |
| `terraform_tail_lambda_logs` | Stream `/aws/lambda/<fn>` via `aws logs tail --follow` into the output channel |

Sensitive operations (apply, set secret) display a confirmation dialog before execution.

---

## Prerequisites

- **VS Code** `≥ 1.95`
- **GitHub Copilot Chat** (for `@terraform` and LM tools)
- A GitHub account with access to the target repository
- GitHub Actions workflows already configured (or use `/bootstrap` to scaffold them)
- **AWS CLI** in PATH and credentials available (env, profile, or helper like `awscreds`) — only required for the CodeBuild / Lambda image / Service Catalog flows

### Required repository secrets / variables

The composite actions scaffolded into `.github/actions/` (when `terraformWorkspace.useLocalActions` is enabled, the default) expect the following to be set on the repo or environment in GitHub:

> Manage these directly from the **Required Setup** view in the Terraform activity bar — each row shows whether the value is set at the right scope, click to set or update (secrets are entered via a password input and encrypted client-side before transmission). Use the checklist icon in the view title to walk through every required value in one pass via `Terraform: Set All Required Variables & Secrets…`.

| Name | Type | Used by | Purpose |
|------|------|---------|---------|
| `AWS_ROLE_TO_ASSUME` | variable or secret | `aws-auth` | IAM role ARN assumed via OIDC. The role's trust policy must allow `token.actions.githubusercontent.com` for this repo + environment. |
| `APP_ID`             | variable           | `gh-auth`  | GitHub App ID used to mint a short-lived installation token (exported as `GH_TOKEN` / `GITHUB_TOKEN`). |
| `APP_PRIVATE_KEY`    | secret             | `gh-auth`  | PEM private key for the GitHub App. |
| `TF_STATE_BUCKET`    | variable           | `terraform-init` | S3 bucket holding tfstate. |
| `TF_STATE_REGION`    | variable           | `terraform-init` / `aws-auth` | AWS region for state + default provider region. |
| `TF_STATE_DYNAMODB_TABLE` | variable      | `terraform-init` | DynamoDB table for state locking (optional). |
| `TF_STATE_KEY_PREFIX` | variable          | `terraform-init` | Prefix prepended to the state object key. Final key is `<prefix>/<owner>/<repo>/<env>/terraform.tfstate`. |
| `TF_CACHE_BUCKET`    | variable           | `terraform-init` / `terraform-plan` / `terraform-apply` / `s3-cleanup` | S3 bucket used to hand `.terraform/` and the plan binary from init → plan → apply within a single job. Cleared on job completion. |

> The composite actions are authored from scratch and shipped under `templates/actions/<name>/action.yml`. With `terraformWorkspace.useLocalActions` enabled (the default), `Terraform: Sync Workflows` copies them into `.github/actions/` so workflows reference them as `./.github/actions/<name>`. Set `useLocalActions: false` and configure `compositeActionOrg` / `compositeActions` to point at your own published action repos instead.

The repo must also have **OIDC** enabled (`id-token: write` on the workflow) and the IAM role's trust policy must accept tokens issued by `https://token.actions.githubusercontent.com` for the repo + environment.

If your organization or GitHub installation does not support Actions OIDC (for example, some enterprise installations or strict org policies), the extension supports working with GitHub Enterprise Server (GHE) and provides fallback guidance for two common alternatives:

- GitHub App: mint short-lived installation tokens and wire them into workflows (recommended for org-managed automation). The extension can scaffold guidance for App-based flows.
- Personal Access Token (PAT): use a scoped PAT or organization-managed service account for workflows that cannot use OIDC. This is less secure than OIDC or an App but commonly used when OIDC is unavailable.

For GHE, the OIDC issuer URL differs; the extension will default the provider host to `<your-ghe-host>/_services/token`. Use the `terraformWorkspace.auth.enableOidc` and `terraformWorkspace.auth.preferredAuthMethod` settings to control how the extension guides you when scaffolding trust policies.

> Secret encryption inside the extension (e.g. when you write a value via the Variables view) is handled automatically by `libsodium-wrappers` — no local crypto deps to install.

---

## Getting Started

The fastest path is the built-in walkthrough. Open **Welcome → Get Started with Terraform Workspace**, or run **Welcome: Open Walkthrough** from the command palette and pick the Terraform one. It will walk you through scaffolding from a template, signing in to GitHub, configuring your workspace, wiring OIDC + remote state, syncing workflows, linting them, and operating via chat.

If you'd rather do it manually:

### 1. Sign in

The extension uses VS Code's **built-in GitHub OAuth provider** — no PAT required. On first use, you'll be prompted to sign in with the scopes `repo`, `read:org`, and `workflow`. If anything later returns 403, run **Terraform: Diagnose GitHub Auth Scopes** to find the missing scope or SSO grant.

### 2. Either scaffold a new repo, or open an existing one

**No folder open?** Run **Terraform: Scaffold Repo From Template…** from the command palette. You'll be guided through a form (template owner/repo, new name, owner, visibility) and offered **Clone & Open** when the new repo is created.

**Already have a Terraform repo?** Just open the folder. Auto-discovery inspects your `*.tf` files, `.github/workflows/`, and existing GitHub Environments and pre-fills `.vscode/terraform-workspace.json`.

### 3. Configure the workspace

Run **Terraform: Configure Workspace** (or click the **edit** icon in the Workspaces view). This opens the config panel and creates `.vscode/terraform-workspace.json` if one doesn't exist. Fill in:

- Your GitHub org and repo name
- At least one environment (use key `environments` for GHA-Environment repos, or `workspaces` if the repo does not use GitHub Actions Environments — set `useGhaEnvironments: false` in that case)
- The S3 state bucket and region

### 4. Operate via `@terraform`

```
@terraform plan staging
@terraform what's the status of the last apply?
@terraform search aws_lambda_function with provisioned_concurrency
@terraform why is var.region resolving to us-east-2 in prod?
@terraform check drift
```

The chat participant is in **tool-call mode** — it has access to all 31 `terraform_*` language model tools and will dispatch real workflow runs, set real variables, and read real run logs.

> **Secrets**: prefer **Terraform: Add Secret** from the command palette over chat for real secret values. The command-palette path keeps the value on-device; the chat path passes it through the language model first (the response is redacted, but the value has already been seen).

For the full opinionated workflow story, see [USAGE.md](USAGE.md).

---

## `.vscode/terraform-workspace.json`

This file is the configuration contract between the extension and your infrastructure. It maps 1:1 to the inputs of the [`terraform-github-workspace`](https://github.com/HappyPathway/terraform-github-workspace) Terraform module.

```jsonc
{
  "version": 1,
  "compositeActionOrg": "HappyPathway",
  "repo": {
    "name": "my-infra-repo",
    "repoOrg": "my-org",
    "description": "Production infrastructure",
    "enforcePrs": true,
    "adminTeams": ["platform-team"],
    "repoTopics": ["terraform-managed"]
  },
  "stateConfig": {
    "bucket": "my-org-tfstate-us-east-1",
    "region": "us-east-1",
    "keyPrefix": "terraform-state-files",
    "dynamodbTable": "tf_remote_state"
  },
  "environments": [
    {
      "name": "production",
      "cacheBucket": "my-org-tf-cache-production",
      "runnerGroup": "self-hosted",
      "preventSelfReview": true,
      "reviewers": {
        "teams": ["platform-team"],
        "enforceReviewers": true
      },
      "deploymentBranchPolicy": {
        "branch": "main",
        "protectedBranches": true
      }
    },
    {
      "name": "staging",
      "cacheBucket": "my-org-tf-cache-staging",
      "runnerGroup": "self-hosted"
    }
  ],
  "compositeActions": {
    "checkout": "gh-actions-checkout@v4",
    "awsAuth": "aws-auth@main",
    "ghAuth": "gh-auth@main",
    "setupTerraform": "gh-actions-terraform@v1",
    "terraformInit": "terraform-init@main",
    "terraformPlan": "terraform-plan@main",
    "terraformApply": "terraform-apply@main",
    "s3Cleanup": "s3-cleanup@main"
  }
}
```

---

## Commands

Commands are split across four palette categories so they're easy to scan in a busy palette:

### Terraform: …

| Command | Description |
|---|---|
| `Terraform: Configure Workspace` | Open the workspace config panel |
| `Terraform: Bootstrap New Workspace` | Same — opens config panel (creates stub if needed) |
| `Terraform: Scaffold Repo From Template…` | Create a new GitHub repository from a template repo (works with no folder open) |
| `Terraform: Refresh Workspaces` | Reload all three tree views |
| `Terraform: Select Workspace` | Mark a workspace as active |
| `Terraform: Run Plan` | Dispatch a plan workflow for the selected workspace |
| `Terraform: Run Apply` | Dispatch an apply workflow (with confirmation) |
| `Terraform: Open Run Logs` | Open a run's GitHub Actions page |
| `Terraform: Add Variable` | Create a GitHub Actions variable (env / repo / org scope) |
| `Terraform: Add Secret` | Create an encrypted GitHub Actions secret |
| `Terraform: Delete Variable` | Remove a variable or secret |
| `Terraform: Open in GitHub` | Open workspace or run in browser |
| `Terraform: Configure GitHub App` | Trigger re-authentication |
| `Terraform: Diagnose GitHub Auth Scopes` | Probe each GitHub API surface and report which scopes / SSO grants are missing |
| `Terraform: Lint Workflows` | Run `actionlint` over `.github/workflows/terraform-*.yml` |
| `Terraform: Check Drift` | Report environments whose latest plan exited with drift |
| `Terraform: Generate OIDC Trust Policy` | Produce an AWS IAM trust policy JSON for GitHub OIDC |
| `Terraform: Scaffold Backend` | Produce S3 + DynamoDB backend HCL |

### CodeBuild: …

| Command | Description |
|---|---|
| `CodeBuild: Scaffold Executor Project…` | Generate an `infra/codebuild-executor-<name>/` Terraform module + buildspec |
| `CodeBuild: Run Terraform Plan…` | Dispatch a plan into the configured CodeBuild executor and stream logs locally |
| `CodeBuild: Run Terraform Apply…` | Dispatch an apply into the configured CodeBuild executor (with confirmation) |

### Lambda: …

| Command | Description |
|---|---|
| `Lambda: Scaffold Container Image Project…` | Generate `infra/lambda-image-<fn>/` (Packer + Terraform: ECR repo with lifecycle, Lambda function pinned to `var.image_digest`, `src/handler.py` skeleton) |
| `Lambda: Build & Publish Image…` | Zip the project, upload to S3, run the existing `packer-pipeline` CodeBuild project, capture the ECR digest, and write `terraform.tfvars.json` so `terraform apply` deploys the new image |
| `Lambda: Scaffold Python Dev Environment…` | Layer a Python inner-loop onto an existing `infra/lambda-image-<fn>/` dir: `pyproject.toml`, `Makefile`, `.devcontainer/`, `.vscode/launch.json`, `tests/`, and `scripts/local_invoke.py`. **Docker-free.** |
| `Lambda: Test Locally…` | Invoke the handler in a local Python venv against a sample event JSON. Auto-discovers events under `tests/events/`. Streams stdout/stderr into the output channel. |
| `Lambda: Tail Function Logs…` | `aws logs tail /aws/lambda/<fn> --follow` straight into the output channel; cancellation kills the tail process cleanly. |

### Service Catalog: …

| Command | Description |
|---|---|
| `Service Catalog: Scaffold Product…` | Generate `infra/sc-product-<slug>/product.tf` with the product, initial v1.0.0 provisioning artifact, portfolio association, and LAUNCH constraint |
| `Service Catalog: Bump Provisioning Artifact…` | Additively add a new versioned `aws_servicecatalog_provisioning_artifact` resource (kept active; old artifact disabled manually) |
| `Service Catalog: Dry-render Product Form Inputs…` | Validate a sample inputs JSON against a JSON Schema (required fields, enum, regex, min/max) before publishing — also generates CFN `Rules` so the same constraints are enforced at launch time |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `terraformWorkspace.repoOrg` | `"HappyPathway"` | Default GitHub org for new workspaces |
| `terraformWorkspace.compositeActionOrg` | `"HappyPathway"` | Org hosting composite action repos |
| `terraformWorkspace.defaultRunnerGroup` | `"self-hosted"` | Default runner group label |
| `terraformWorkspace.defaultStateRegion` | `"us-east-1"` | Default AWS region for S3 state buckets |
| `terraformWorkspace.preferOpenTofu` | `true` | Prefer OpenTofu (`tofu`) in generated workflows |
| `terraformWorkspace.aiModel` | `"gpt-4o"` | Language model family for code generation |

---

## HappyPathway Composite Actions

The extension is designed to work with HappyPathway's suite of reusable GitHub Actions:

| Action ref | Purpose |
|---|---|
| `gh-actions-checkout@v4` | Enhanced checkout with submodule support |
| `aws-auth@main` | OIDC-based AWS credential setup |
| `gh-auth@main` | GitHub App token generation for cross-repo ops |
| `gh-actions-terraform@v1` | Terraform/OpenTofu CLI setup |
| `terraform-init@main` | `terraform init` with S3 backend config |
| `terraform-plan@main` | `terraform plan` with artifact upload |
| `terraform-apply@main` | `terraform apply` with state locking |
| `s3-cleanup@main` | Plan artifact cleanup after apply |

These refs are fully overridable per-workspace via the Composite Action Refs section in the config panel.

---

## CodeBuild Executor (optional)

By default, generated GHA workflows run `terraform plan/apply` **inline on the runner**. For self-hosted GHE Server (where AWS-side webhook runners aren't an option), or when you want heavy plans isolated in AWS, you can switch any workspace to dispatch into an **AWS CodeBuild project** instead — same flow as [djaboxx/packer-pipeline](https://github.com/djaboxx/packer-pipeline): zip → S3 → `aws codebuild start-build` → tail logs → download plan artifacts.

**1. Scaffold the executor module** (creates `infra/codebuild-executor-<projectName>/{main.tf,buildspec.yml}`):

- Command Palette → **CodeBuild: Scaffold Executor Project…**, or
- Ask `@terraform` to "scaffold a codebuild executor for region us-east-1, project tf-executor-myapp, bucket tf-executor-myapp-src".

Then `cd infra/codebuild-executor-<projectName> && terraform init && terraform apply`.

**2. Wire it into your workspace config** (`.vscode/terraform-workspace.json`):

```jsonc
{
  "executor": "codebuild",
  "codebuild": {
    "project": "tf-executor-myapp",
    "sourceBucket": "tf-executor-myapp-src",
    "region": "us-east-1"
  },
  "workspaces": [{ "name": "prod", "executor": "codebuild" /* per-env override */ }]
}
```

Re-run **Terraform: Sync Workflows** so GHA workflows emit the dispatch steps instead of running terraform inline.

**3. Run from VS Code locally** (no GHA round-trip needed):

- Command Palette → **CodeBuild: Run Terraform Plan…** / **CodeBuild: Run Terraform Apply…**, or
- Ask `@terraform` to "run plan in codebuild for workspace prod".

The dispatcher uses your local AWS credentials (e.g. via `awscreds`) and explicitly sets `AWS_REGION` + `AWS_DEFAULT_REGION` from the `codebuild.region` you configured, so credential helpers that don't export region still work. Plan artifacts download to `.tf-artifacts/<workspace>/<runId>/`.

---

## Lambda Container Images (via packer-pipeline)

For teams that already run a [packer-pipeline](https://github.com/djaboxx/packer-pipeline) CodeBuild project, the extension can scaffold + drive a complete OCI-image-backed Lambda workflow without leaving VS Code.

**1. Scaffold the project** — Command Palette → **Lambda: Scaffold Container Image Project…**

Generates `infra/lambda-image-<fn>/`:

- `packer.pkr.hcl` — `source "docker"` → `docker-tag` → `docker-push` to ECR; copies `src/` into `/var/task` and runs `pip install -r requirements.txt` if present.
- `build.hcl` — `packer_pipeline { … }` block consumed by the existing packer-pipeline CodeBuild project.
- `ecr.tf` — `aws_ecr_repository` with `scan_on_push` and a lifecycle policy (keep 10 tagged, expire untagged after 14 days).
- `lambda.tf` — IAM exec role, `aws_lambda_function` with `package_type = "Image"`, image URI pinned by digest from `var.image_digest` so deploys are immutable.
- `src/handler.py` + `src/requirements.txt` — only written if missing.

**2. Build & publish** — Command Palette → **Lambda: Build & Publish Image…** (auto-discovers `infra/lambda-image-*` dirs and offers a QuickPick).

The dispatcher:

1. Zips the project (excluding `.git`/`.terraform`/`node_modules`) and uploads to `s3://<bucket>/lambda-image-src/<fn>/<runId>.zip`.
2. Runs `aws codebuild start-build --project-name <packer-pipeline>` with `IMAGE_TAG` + `ECR_REPO` env overrides.
3. Polls `batch-get-builds` every 5s and streams CloudWatch logs into the **Terraform Workspace** output channel.
4. On `SUCCEEDED`, calls `aws ecr describe-images` to capture the new `imageDigest` and writes `terraform.tfvars.json` (merged with existing) so `terraform apply` deploys the new image.

> Cancel the progress notification to call `aws codebuild stop-build` cleanly.

---

## Python Developer Inner-Loop (Lambda images, Docker-free)

The Lambda image scaffolder produces an immutable, image-digest-pinned deploy artifact, but the *inner loop* — write code, test, see logs — needs a Python environment too. **Lambda: Scaffold Python Dev Environment…** layers one onto an existing `infra/lambda-image-<fn>/` dir without requiring local Docker.

It writes (only-if-missing):

- `pyproject.toml` — `requires-python` pinned to match the Packer base image (auto-detected from `packer.pkr.hcl`); dev deps: `pytest`, `pytest-asyncio`, `moto[lambda,s3,dynamodb]`, `boto3-stubs[essential]`, `ruff`, `mypy`, `pip-tools`. Includes ruff + mypy + pytest config blocks.
- `Makefile` — `install`, `test`, `lint`, `typecheck`, `freeze` targets. `freeze` runs `pip-compile` to derive `src/requirements.txt` from `pyproject.toml` so the existing Packer `pip install -r requirements.txt` step keeps working unchanged.
- `tests/conftest.py` — adds `src/` to `sys.path` and exposes a `lambda_context` fixture.
- `tests/test_handler.py` — pytest smoke test importing the handler dotted path.
- `tests/events/sample.json` — minimal event used by the local-invoke command.
- `.python-version` — for pyenv users.
- `.devcontainer/devcontainer.json` — `mcr.microsoft.com/devcontainers/python:<ver>` with the AWS CLI feature. **No `docker-outside-of-docker` feature** — fully Codespaces / locked-down sandbox compatible.
- `.vscode/launch.json` — `Local invoke` (runs `scripts/local_invoke.py` under debugpy) + `pytest` debug configs.
- `scripts/local_invoke.py` — stdlib-only driver that imports the dotted handler, builds a `LambdaContext`-shaped object, calls `handler(event, context)`, and prints the JSON result.

**Lambda: Test Locally…** runs that driver through your venv interpreter:

1. Resolves the interpreter from `python.defaultInterpreterPath` → `<project>/.venv/bin/python` → `python3` on PATH.
2. Spawns it with `scripts/local_invoke.py --handler <dotted> --event <event.json>`.
3. Streams stdout/stderr into the output channel; cancellation sends `SIGTERM`.

> Fidelity caveat: this catches handler logic + missing-dep bugs. It does **not** exercise the AL2-based Lambda runtime (glibc/musl mismatches, baked binaries) — the remote build via **Lambda: Build & Publish Image…** remains the source of truth for deploy-time correctness.

**Lambda: Tail Function Logs…** is a thin wrapper around `aws logs tail /aws/lambda/<fn> --follow --format short --region <region>` that streams into the output channel. Auto-discovers function names from `infra/lambda-image-*` dirs (QuickPick if multiple).

---

## AWS Service Catalog Products

Author and maintain Service Catalog products (with launch constraints + form-input validation) directly from the editor.

**Scaffold** — Command Palette → **Service Catalog: Scaffold Product…**

Generates `infra/sc-product-<slug>/product.tf`:

- `aws_servicecatalog_product` + an initial `v1.0.0` provisioning artifact (CloudFormation template at `s3://<bucket>/<key>`).
- `aws_servicecatalog_product_portfolio_association` to attach to your portfolio.
- LAUNCH constraint via `data.aws_iam_role.launch` so end-users assume your role at launch time.

**Bump artifact** — Command Palette → **Service Catalog: Bump Provisioning Artifact…**

Writes a new `artifact-v<ver>.tf` next to the product (additive — refuses to overwrite). The new artifact is created `active = true`; disable old ones manually once consumers migrate.

**Dry-render form inputs** — Command Palette → **Service Catalog: Dry-render Product Form Inputs…**

Validates a sample inputs JSON against your product's JSON Schema *before* anyone hits "Launch" in the AWS console. Checks: `required`, type, `enum`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`. Results show in the output channel.

The same JSON Schema can be transpiled to CloudFormation `Rules` (via the `terraform_dryrender_sc_product` LM tool / `scTemplateConstraintsTf` helper) so the constraints are also enforced server-side at launch.

---

## Development

```bash
# Install dependencies
npm install

# Watch mode (rebuild on save)
npm run watch

# Type-check only
npm run compile

# Production bundle
npm run build

# Package .vsix
npm run package
```

The extension bundles to a single `dist/extension.js` via esbuild (target: Node 20, CJS format). Secret encryption uses `libsodium-wrappers` (sealed boxes) — included in the bundle.

---

## Security

- **Authentication**: Uses VS Code's built-in GitHub OAuth provider. No tokens are stored by the extension.
- **Secret encryption**: Secrets are encrypted client-side using libsodium sealed boxes (`libsodium-wrappers`) with the repository's GitHub-provided public key before transmission. Plaintext secret values never leave the machine over unencrypted channels.
- **No local Terraform execution**: All plan/apply runs happen in GitHub Actions runners, never locally. This keeps credentials and state out of the developer's machine.
- **WebView CSP**: The config panel enforces a strict Content Security Policy (`default-src 'none'`).

---

## Repository

- **GitHub**: [djaboxx/vscode-terraform-workspace](https://github.com/djaboxx/vscode-terraform-workspace)
- **Publisher**: HappyPathway
- **License**: MIT

