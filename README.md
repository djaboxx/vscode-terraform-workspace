![Terraform Workspace](images/banner.png)

# Terraform Workspace — VS Code Extension

> AI-powered Terraform workspace manager backed by GitHub Actions and [HappyPathway](https://github.com/HappyPathway) infrastructure patterns.

[![VS Code Engine](https://img.shields.io/badge/vscode-%5E1.90.0-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
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

The AI layer — exposed as the `@terraform` chat participant and 8 language model tools — understands this model deeply and can generate code, trigger runs, manage variables, and bootstrap new repositories through natural language.

---

## Architecture

```
VS Code Editor
├── @terraform chat participant          ← natural language interface
│   ├── /workspace  — list environments
│   ├── /plan       — trigger plan workflow
│   ├── /apply      — trigger apply workflow
│   ├── /bootstrap  — scaffold new workspace
│   ├── /varset     — inspect org variable sets
│   ├── /generate   — AI Terraform code generation
│   └── /explain    — AI config explanation
│
├── Language Model Tools (8 tools)      ← Copilot agent tools
│   ├── terraform_run_plan
│   ├── terraform_run_apply
│   ├── terraform_get_state
│   ├── terraform_list_workspaces
│   ├── terraform_list_variables
│   ├── terraform_set_variable
│   ├── terraform_generate_code
│   └── terraform_bootstrap_workspace
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

Bring Terraform operations into GitHub Copilot Chat:

```
@terraform /plan production
@terraform /apply staging
@terraform /workspace
@terraform /varset my-org
@terraform /bootstrap
@terraform generate an S3 bucket with versioning enabled using the HappyPathway module
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

Eight tools exposed to GitHub Copilot and any VS Code LM-aware extension:

| Tool | Description |
|---|---|
| `terraform_run_plan` | Dispatch a plan workflow for a workspace |
| `terraform_run_apply` | Dispatch an apply workflow (requires confirmation) |
| `terraform_get_state` | Summarise the last successful apply run |
| `terraform_list_workspaces` | List all GitHub Environments for the repo |
| `terraform_list_variables` | List variables/secrets at any scope |
| `terraform_set_variable` | Create or update a variable or secret |
| `terraform_generate_code` | AI-generate Terraform HCL from a description |
| `terraform_bootstrap_workspace` | Scaffold `.vscode/terraform-workspace.json` |

Sensitive operations (apply, set secret) display a confirmation dialog before execution.

---

## Prerequisites

- **VS Code** `≥ 1.90`
- **GitHub Copilot Chat** (for `@terraform` and LM tools)
- A GitHub account with access to the target repository
- GitHub Actions workflows already configured (or use `/bootstrap` to scaffold them)
- For secret encryption: the extension handles libsodium sealed-box encryption automatically via `tweetsodium` — no local dependencies needed

---

## Getting Started

### 1. Authenticate

The extension uses VS Code's **built-in GitHub OAuth provider** — no PAT required. On first use, you'll be prompted to sign in with the scopes `repo`, `read:org`, and `workflow`.

### 2. Open your Terraform repository

Open the folder containing your `.tf` files in VS Code.

### 3. Configure the workspace

Run the command:

```
Terraform: Configure Workspace
```

Or click the **edit** icon in the Workspaces view toolbar. This opens the config panel and creates `.vscode/terraform-workspace.json` if one doesn't exist.

Fill in:
- Your GitHub org and repo name
- At least one environment (e.g. `production`, `staging`)
- The S3 state bucket and region

### 4. Start using `@terraform`

```
@terraform /workspace
@terraform /plan staging
@terraform generate a VPC with public and private subnets using the HappyPathway network module
```

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

The extension bundles to a single `dist/extension.js` via esbuild (target: Node 20, CJS format). `tweetsodium` is the only runtime dependency — included in the bundle for secret encryption.

---

## Security

- **Authentication**: Uses VS Code's built-in GitHub OAuth provider. No tokens are stored by the extension.
- **Secret encryption**: Secrets are encrypted client-side using libsodium sealed boxes (`tweetsodium`) with the repository's GitHub-provided public key before transmission. Plaintext secret values never leave the machine over unencrypted channels.
- **No local Terraform execution**: All plan/apply runs happen in GitHub Actions runners, never locally. This keeps credentials and state out of the developer's machine.
- **WebView CSP**: The config panel enforces a strict Content Security Policy (`default-src 'none'`).

---

## Repository

- **GitHub**: [djaboxx/vscode-terraform-workspace](https://github.com/djaboxx/vscode-terraform-workspace)
- **Publisher**: HappyPathway
- **License**: MIT
# vscode-terraform-workspace
# vscode-terraform-workspace
# vscode-terraform-workspace
