![Terraform Workspace](images/banner.png)

# Terraform Workspace — VS Code Extension

> AI-powered Terraform workspace manager backed by GitHub Actions and [HappyPathway](https://github.com/HappyPathway) infrastructure patterns.

[![VS Code Engine](https://img.shields.io/badge/vscode-%5E1.95.0-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![GitHub Actions](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=github-actions)](https://github.com/features/actions)

---

## What Is This?

**Terraform Workspace** bridges your VS Code editor with GitHub Actions as the sole execution engine for your Terraform infrastructure. No Terraform Cloud. No local `terraform apply`. Just **GitHub Environments as workspaces**, **GitHub Actions for plan/apply**, and **GitHub Secrets/Variables for configuration** — all managed without leaving your editor.

The extension is built around a core mental model:

| Concept | Backed by |
|---|---|
| Terraform workspace | GitHub Environment |
| Workspace variable | GitHub Actions Variable (`TF_VAR_*`) |
| Workspace secret | GitHub Actions Encrypted Secret |
| Plan / Apply run | GitHub Actions `workflow_dispatch` |
| Terraform state | S3 backend (DynamoDB lock table) |
| Composite actions | [HappyPathway](https://github.com/HappyPathway) reusable action repos |

The AI layer — exposed as the `@terraform` chat participant and 22 language model tools — understands this model deeply and can generate code, trigger runs, manage variables, and bootstrap new repositories through natural language.

---

## Architecture

```
VS Code Editor
├── @terraform chat participant          ← natural-language interface (tool-call mode)
│   └── Auto-routes requests to the 22 `terraform_*` LM tools below.
├── Language Model Tools (22 tools)      ← Copilot agent tools
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

### `@terraform` Chat Participant

Bring Terraform operations into GitHub Copilot Chat. The participant runs in **tool-call mode** with all 23 `terraform_*` language model tools available, so natural language requests dispatch real actions:

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
- **Environments** — collapsible cards per environment with branch policies, reviewer teams, wait timers, per-env state overrides, env vars and secrets

Changes save directly to `.vscode/terraform-workspace.json`. The panel reloads automatically if the file changes externally (e.g. a `git pull`).

### Language Model Tools

Twenty-three tools exposed to GitHub Copilot and any VS Code LM-aware extension:

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

Sensitive operations (apply, set secret) display a confirmation dialog before execution.

---

## Prerequisites

- **VS Code** `≥ 1.95`
- **GitHub Copilot Chat** (for `@terraform` and LM tools)
- A GitHub account with access to the target repository
- GitHub Actions workflows already configured (or use `/bootstrap` to scaffold them)

### Required repository secrets / variables

The composite actions scaffolded into `.github/actions/` (when `terraformWorkspace.useLocalActions` is enabled, the default) expect the following to be set on the repo or environment in GitHub:

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
- At least one environment (e.g. `production`, `staging`)
- The S3 state bucket and region

### 4. Operate via `@terraform`

```
@terraform plan staging
@terraform what's the status of the last apply?
@terraform search aws_lambda_function with provisioned_concurrency
@terraform why is var.region resolving to us-east-2 in prod?
@terraform check drift
```

The chat participant is in **tool-call mode** — it has access to all 22 `terraform_*` language model tools and will dispatch real workflow runs, set real variables, and read real run logs.

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

