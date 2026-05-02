ou# Terraform Workspace — Command & Tool Reference

This document covers all 54 VS Code commands, all 39 language-model tools, and
the two chat participants (`@terraform` and `@dave`).

---

## Table of Contents

- [VS Code Commands](#vs-code-commands)
  - [Terraform (core)](#terraform-core)
  - [Terraform (workflows)](#terraform-workflows)
  - [Terraform (scaffolding)](#terraform-scaffolding)
  - [Terraform (variables & secrets)](#terraform-variables--secrets)
  - [Terraform (agent)](#terraform-agent)
  - [CodeBuild](#codebuild)
  - [Lambda](#lambda)
  - [Service Catalog](#service-catalog)
  - [GHE Runners](#ghe-runners)
  - [Misc / utility](#misc--utility)
- [Language Model Tools](#language-model-tools)
  - [Core Terraform tools](#core-terraform-tools)
  - [Config & discovery tools](#config--discovery-tools)
  - [Workflow tools](#workflow-tools)
  - [Variable tools](#variable-tools)
  - [Scaffolding tools](#scaffolding-tools)
  - [CodeBuild tools](#codebuild-tools)
  - [Lambda tools](#lambda-tools)
  - [Service Catalog tools](#service-catalog-tools)
  - [GHE Runner tools](#ghe-runner-tools)
- [Chat Participants](#chat-participants)
  - [@terraform](#terraform)
  - [@dave](#dave)

---

## VS Code Commands

All commands are accessible from the Command Palette (`Cmd/Ctrl+Shift+P`).
Commands marked with a category other than **Terraform** appear under that
category in the palette.

### Terraform (core)

| Command ID | Title | Description |
|---|---|---|
| `terraform.selectFolder` | Select Workspace Folder | Choose which workspace folder is active when multiple folders are open |
| `terraform.refreshWorkspaces` | Refresh Workspaces | Reload all three tree views (Workspaces, Variables & Secrets, Runs) |
| `terraform.selectWorkspace` | Select Workspace | Mark a workspace (GitHub Environment) as the active one |
| `terraform.runPlan` | Run Plan | Dispatch a `terraform-plan-<env>.yml` workflow for the selected workspace |
| `terraform.runApply` | Run Apply | Dispatch a `terraform-apply-<env>.yml` workflow with a confirmation dialog |
| `terraform.openRunLogs` | Open Run Logs | Open a run's GitHub Actions page in the browser |
| `terraform.openInGitHub` | Open in GitHub | Open the selected workspace or run in the browser |
| `terraform.configureWorkspace` | Configure Workspace | Open the workspace config panel (reads/writes `.vscode/terraform-workspace.json`) |
| `terraform.configureGithubApp` | Configure GitHub App | Trigger a re-authentication flow with the VS Code GitHub auth provider |
| `terraform.bootstrapWorkspace` | Bootstrap New Workspace | Alias for Configure Workspace — creates a stub config file if none exists |
| `terraform.diagnoseAuth` | Diagnose GitHub Auth Scopes | Probes each GitHub API surface and reports which scopes / SSO grants are missing |
| `terraform.openWalkthrough` | Open Walkthrough | Open the built-in Getting Started walkthrough (`Cmd+Shift+T W` / `Ctrl+Shift+T W`) |

### Terraform (workflows)

| Command ID | Title | Description |
|---|---|---|
| `terraform.syncWorkflows` | Sync Workflows | Regenerate `terraform-plan-*.yml` and `terraform-apply-*.yml` for every configured environment |
| `terraform.lintWorkflows` | Lint Workflows (actionlint) | Run `actionlint` over `.github/workflows/terraform-*.yml` and surface results in the Problems panel |
| `terraform.checkDrift` | Check Drift | Inspect the latest plan workflow run for each environment and report any that exited with code 2 (infrastructure differs from config) |
| `terraform.discoverDefaults` | Auto-discover Workspace Defaults | Scan git remotes, `.tf` files, and existing workflows to pre-fill reasonable config defaults |
| `terraform.pinTerraformVersion` | Pin Terraform Version… (.terraform-version) | Write a `.terraform-version` file matching the version declared in `.terraform.lock.hcl` |
| `terraform.refreshProviderDocs` | Refresh Provider Docs (from .terraform.lock.hcl) | Download and cache documentation for every provider version locked in `.terraform.lock.hcl` |
| `terraform.reviewDeployment` | Review Deployment | Approve or reject a pending GitHub Actions deployment protection rule gate |

### Terraform (scaffolding)

| Command ID | Title | Description |
|---|---|---|
| `terraform.scaffoldFromTemplate` | Scaffold Repo From Template… | Create a new GitHub repository from a template repo — no local folder required |
| `terraform.scaffoldBackend` | Scaffold S3+DynamoDB Backend | Generate Terraform HCL for the S3 state bucket and DynamoDB lock table |
| `terraform.scaffoldOidcTrust` | Generate OIDC Trust Policy | Generate an AWS IAM trust policy allowing GitHub Actions to assume a role via OIDC |
| `terraform.composeModules` | Compose Terraform Modules… | Open the module composer panel to assemble a root module from HappyPathway modules |

### Terraform (variables & secrets)

| Command ID | Title | Description |
|---|---|---|
| `terraform.addVariable` | Add Variable | Create a GitHub Actions variable at env / repo / org scope |
| `terraform.addSecret` | Add Secret | Create an encrypted GitHub Actions secret |
| `terraform.deleteVariable` | Delete Variable | Remove a variable or secret |
| `terraform.resolveVariable` | Resolve Variable Source | Trace where a variable is defined across org / repo / environment scopes and report the effective value source |
| `terraform.requiredSetup.set` | Set Required Value… | Set a single required variable or secret from the Required Setup tree view |
| `terraform.requiredSetup.setAll` | Set All Required Variables & Secrets… | Wizard that walks through every required variable and secret for the active workspace |
| `terraform.requiredSetup.refresh` | Refresh Required Setup | Reload the Required Setup tree view |

### Terraform (agent)

| Command ID | Title | Description |
|---|---|---|
| `terraform.agent.start` | Agent: Start Autonomous Loop | Start the proactive agent that polls for open GitHub Issues labelled with the trigger label and acts on them |
| `terraform.agent.stop` | Agent: Stop Autonomous Loop | Stop the running agent loop |
| `terraform.agent.runNow` | Agent: Run One Tick Now | Force the agent to run a single poll + act cycle immediately |
| `terraform.agent.showStatus` | Agent: Show Output Log | Bring the Terraform Workspace output channel into focus |
| `terraform.agent.showMemory` | Agent: Show Memory | Display the agent's persisted memory (learned patterns from previous runs) |
| `terraform.agent.learnNow` | Agent: Learn From Repos Now | Force the repo learner to scan configured repositories for patterns immediately |

### CodeBuild

| Command ID | Title | Description |
|---|---|---|
| `terraform.scaffoldCodebuildExecutor` | Scaffold Executor Project… | Generate a Terraform module under `infra/codebuild-executor-<name>/` that provisions a CodeBuild project, IAM role, and S3 source bucket |
| `terraform.runPlanInCodeBuild` | Run Terraform Plan… | Dispatch a Terraform plan run inside the CodeBuild executor configured for the active workspace |
| `terraform.runApplyInCodeBuild` | Run Terraform Apply… | Dispatch a Terraform apply run inside the CodeBuild executor (with confirmation) |

### Lambda

| Command ID | Title | Description |
|---|---|---|
| `terraform.scaffoldLambdaImage` | Scaffold Container Image Project… | Generate `infra/lambda-image-<fn>/` with a Packer HCL pipeline, Terraform infra, and ECR repository |
| `terraform.buildLambdaImage` | Build & Publish Image… | Zip the image directory, upload to S3, dispatch the packer-pipeline CodeBuild project, and tail the build |
| `terraform.scaffoldPythonDevEnv` | Scaffold Python Dev Environment… | Layer Python developer tooling (`pyproject.toml`, `.python-version`, `Makefile`, devcontainer, launch config, tests) onto an existing Lambda image directory |
| `terraform.invokeLambdaLocally` | Test Locally… | Run a Lambda handler in a plain Python interpreter against a JSON event file (no Docker required) |
| `terraform.tailLambdaLogs` | Tail Function Logs… | Stream `/aws/lambda/<fn>` CloudWatch logs via `aws logs tail --follow` into the output channel |

### Service Catalog

| Command ID | Title | Description |
|---|---|---|
| `terraform.scaffoldServiceCatalogProduct` | Scaffold Product… | Generate `infra/sc-product-<slug>/product.tf` creating an S3 bucket, portfolio, product, launch role, and constraint |
| `terraform.bumpServiceCatalogArtifact` | Bump Provisioning Artifact… | Write an additive `.tf` file that registers a new CloudFormation template version as a Service Catalog provisioning artifact |
| `terraform.dryRenderServiceCatalogProduct` | Dry-render Product Form Inputs… | Validate sample SC form input JSON against a schema without deploying anything |

### GHE Runners

| Command ID | Title | Description |
|---|---|---|
| `terraform.runners.refresh` | Refresh Runners | Reload the Runners tree view |
| `terraform.runners.refreshEnvironment` | Refresh | Reload a single runner environment in the tree view |
| `terraform.runners.forceTokenRefresh` | Force Token Refresh | Invoke the token-refresh Lambda for a runner environment to rotate the GitHub registration token |
| `terraform.runners.forceRedeploy` | Force Redeploy | Trigger a force-new-deployment of the ECS runner service, replacing all running tasks |
| `terraform.runners.scale` | Scale Runners… | Update the ECS desired task count for a runner environment |
| `terraform.runners.viewLogs` | Tail Logs… | Fetch recent CloudWatch log events from the ECS runner log group |

### Misc / utility

| Command ID | Title | Description |
|---|---|---|
| `terraform.callNotes.open` | Open Call Notes | Open the call notes notebook for the active workspace (`Cmd+Alt+N` / `Ctrl+Alt+N`) |

---

## Language Model Tools

These tools are available to both `@terraform` and `@dave`, and to any other
Copilot agent or MCP client that can call VS Code language model tools. All
tool names follow `snake_case` and are prefixed with `terraform_` or
`ghe_runner_`.

### Core Terraform tools

| Tool name | Description |
|---|---|
| `terraform_run_plan` | Trigger a Terraform plan via `workflow_dispatch` on the specified workspace (GitHub Environment). Returns the run URL. |
| `terraform_run_apply` | Trigger a Terraform apply via `workflow_dispatch`. Requires explicit confirmation. Returns the run URL. |
| `terraform_get_state` | Fetch and parse the Terraform state from the last successful run artifact. Returns a resource summary. |
| `terraform_get_run_status` | Return the most recent plan and apply workflow run statuses (status, conclusion, URL) for one or all configured workspaces. |
| `terraform_list_workspaces` | List all GitHub Environments configured for the current repository — each maps to a Terraform workspace. |

### Config & discovery tools

| Tool name | Description |
|---|---|
| `terraform_read_config` | Return the full contents of `.vscode/terraform-workspace.json` for the active workspace folder. Always call this before attempting to modify config. |
| `terraform_update_config` | Merge a partial patch into `.vscode/terraform-workspace.json`. Supports updating state config, environments, OIDC settings, and runner config. |
| `terraform_discover_workspace` | Auto-discover reasonable defaults by scanning git remotes, `.tf` files (S3 backend, providers, required_version), existing workflows, and GitHub Environments. |
| `terraform_lookup_provider_doc` | Return the official documentation for a Terraform provider resource or data source at the exact version pinned in `.terraform.lock.hcl`. |

### Workflow tools

| Tool name | Description |
|---|---|
| `terraform_sync_workflows` | Generate `terraform-plan-*.yml` and `terraform-apply-*.yml` for every environment in the workspace config and write them to `.github/workflows/`. |
| `terraform_lint_workflows` | Run `actionlint` over `.github/workflows/*.{yml,yaml}` and return structured issues (file, line, column, message). |
| `terraform_check_drift` | Inspect the latest plan workflow run for each environment and return environments whose plan exited with code 2 (infrastructure diverged from config). |
| `terraform_review_deployment` | Approve or reject pending GitHub Actions deployment gates protected by environment rules. Pass `runId` from a workflow run status. |

### Variable tools

| Tool name | Description |
|---|---|
| `terraform_list_variables` | List all GitHub Actions variables and secrets (non-sensitive names only) for the active workspace or org. |
| `terraform_set_variable` | Set a GitHub Actions variable or secret in the specified scope (org / repo / environment). Sensitive values are stored as encrypted secrets. |
| `terraform_delete_variable` | Delete a GitHub Actions variable or secret from the active repository or one of its environments. |
| `terraform_resolve_variable` | Trace where a variable is defined across org / repo / environment scopes and report the effective source (last writer wins). |

### Scaffolding tools

| Tool name | Description |
|---|---|
| `terraform_generate_code` | Generate Terraform HCL from a natural-language description using detected provider versions and HappyPathway module patterns. |
| `terraform_bootstrap_workspace` | Set up a GitHub repository with Terraform environments, GitHub Actions workflows, branch protection, and S3 backend config. |
| `terraform_scaffold_backend` | Generate Terraform HCL for an S3 state bucket and DynamoDB lock table (the one-time per-account bootstrap). |
| `terraform_scaffold_oidc_trust` | Generate an AWS IAM trust policy JSON allowing GitHub Actions in a specific org / repo / environment to call `AssumeRoleWithWebIdentity`. |
| `terraform_scaffold_from_template` | Create a new GitHub repository from a template repository via `POST /repos/{template_owner}/{template_repo}/generate`. |
| `terraform_scaffold_module_repo` | Generate the standard Terraform module repo skeleton (`main.tf`, `variables.tf`, `outputs.tf`, `README.md`, `examples/`) into the active folder. |

### CodeBuild tools

| Tool name | Description |
|---|---|
| `terraform_scaffold_codebuild_executor` | Generate a Terraform module under `infra/codebuild-executor-<name>/` that provisions a CodeBuild project, IAM execution role, and S3 source bucket. |
| `terraform_dispatch_codebuild_run` | Trigger a Terraform `plan` or `apply` for the named workspace inside the CodeBuild executor project configured under `infra/codebuild-executor-*/`. |

### Lambda tools

| Tool name | Description |
|---|---|
| `terraform_scaffold_lambda_image` | Generate `infra/lambda-image-<fn>/` with a Packer HCL pipeline, Terraform ECR + Lambda infra, and a GitHub Actions build workflow. |
| `terraform_build_lambda_image` | Zip the Lambda image directory, upload to S3, dispatch the packer-pipeline CodeBuild project, and tail CloudWatch until it completes. |
| `terraform_scaffold_python_dev_env` | Layer a Python developer environment (`pyproject.toml`, `.python-version`, `Makefile`, devcontainer, launch config, tests) onto an existing Lambda image directory. |
| `terraform_invoke_lambda_locally` | Run a Lambda handler in a plain Python interpreter against a JSON event file. No Docker required — uses `python.defaultInterpreterPath`. |
| `terraform_tail_lambda_logs` | Stream `/aws/lambda/<fn>` via `aws logs tail --follow` into the output channel. Cancellation kills the child process. |

### Service Catalog tools

| Tool name | Description |
|---|---|
| `terraform_scaffold_sc_product` | Generate `infra/sc-product-<slug>/product.tf` creating an S3 template bucket, Service Catalog portfolio, product, launch role, and launch constraint. |
| `terraform_bump_sc_artifact` | Write an additive `.tf` file into an existing SC product directory that registers a new CloudFormation template version as a provisioning artifact. |
| `terraform_dry_render_sc_product` | Validate a sample SC form inputs object against a JSON schema without deploying anything. Returns missing fields and validation errors. |

### GHE Runner tools

| Tool name | Description |
|---|---|
| `ghe_runner_get_status` | Return current health of self-hosted GitHub Actions runner environments: ECS running / desired / pending task counts, and EC2 autoscaling group state. |
| `ghe_runner_refresh_token` | Invoke the token-refresh Lambda for a runner environment to write a fresh GitHub registration token into SSM Parameter Store. |
| `ghe_runner_force_redeploy` | Trigger a force-new-deployment of the ECS runner service. All running tasks are replaced with fresh ones that pick up the latest token. |
| `ghe_runner_scale` | Update the ECS desired task count for a runner environment. Use to scale up when the workflow queue is backed up, or scale down after a burst. |
| `ghe_runner_get_logs` | Fetch recent CloudWatch log events from the ECS runner log group (default: last 30 minutes). Useful for diagnosing registration failures or task crashes. |

---

## Chat Participants

### @terraform

**Participant ID:** `terraform.assistant`  
**Usage:** `@terraform <freeform prompt>` or `@terraform /<command> <args>`

The `@terraform` participant is the standard AI operator for this extension. It
runs in **tool-call mode**: on every freeform message it receives the full list
of registered language model tools and dispatches whichever ones are relevant
before composing a final response. All 39 tools above are available.

#### Commands

| Command | Usage | What it does |
|---|---|---|
| `/generate` | `@terraform /generate <description>` | Generate new Terraform HCL from a description |
| `/modify` | `@terraform /modify <instructions>` | Modify existing Terraform files via diff preview |
| `/plan` | `@terraform /plan [workspace]` | Trigger a plan workflow for the specified (or active) workspace |
| `/apply` | `@terraform /apply [workspace]` | Trigger an apply workflow with a confirmation dialog |
| `/explain` | `@terraform /explain` | Explain the current Terraform configuration in the active folder |
| `/workspace` | `@terraform /workspace` | List all GitHub Environments / workspaces for the active repo |
| `/bootstrap` | `@terraform /bootstrap` | Open the workspace config panel and guide through initial setup |
| `/varset` | `@terraform /varset [org]` | List org-level variable sets for the specified org (defaults to `repoOrg`) |
| `/search` | `@terraform /search <query>` | Search all repositories in the configured GitHub org for matching Terraform code |

#### Example prompts

```
@terraform plan staging
@terraform apply production
@terraform what variables does the production env have?
@terraform scaffold a new repo from happypathway/template-aws-module called terraform-aws-thing
@terraform search aws_s3_bucket replication
@terraform generate an S3 bucket with versioning enabled
@terraform why is var.region resolving to us-east-2 in prod?
@terraform check drift
@terraform review the pending deployment on run 12345
```

---

### @dave

**Participant ID:** `terraform.dave`  
**Usage:** `@dave <freeform prompt>` or `@dave /<command> <args>`

Dave is a second chat participant backed by the same tools as `@terraform` but
with a distinct system prompt: confident, occasionally cocky, always technically
correct. His freeform handler reads `vscode.lm.tools` **dynamically on every
request**, so he automatically gains access to any newly registered tools —
including Copilot built-ins, MCP server tools, and tools from other extensions
— without requiring a window reload.

Dave's tool access: **all 39 tools listed above, plus any other tools registered
in the VS Code language model registry at request time.**

#### Commands

Dave supports the same nine slash commands as `@terraform`:

| Command | Usage | What it does |
|---|---|---|
| `/generate` | `@dave /generate <description>` | Generate Terraform HCL from a description |
| `/modify` | `@dave /modify <instructions>` | Modify existing Terraform files via diff preview |
| `/plan` | `@dave /plan [workspace]` | Trigger a plan workflow |
| `/apply` | `@dave /apply [workspace]` | Trigger an apply workflow (requires confirmation) |
| `/explain` | `@dave /explain` | Explain the current Terraform configuration |
| `/workspace` | `@dave /workspace` | List all workspaces for the active repo |
| `/bootstrap` | `@dave /bootstrap` | Guide through initial workspace setup |
| `/varset` | `@dave /varset [org]` | List org-level variable sets |
| `/search` | `@dave /search <query>` | Search org repos for matching Terraform code |

#### Freeform AI (tool-call mode)

Any message that doesn't match a slash command enters freeform AI mode. Dave
selects a language model, injects:

1. His system prompt (domain expertise + tool-selection guidance)
2. Current repo / environment context from `terraform-workspace.json`
3. All `.tf` file content from the SQLite-backed `TerraformFileCache`
4. Full conversation history
5. All registered `vscode.lm.tools` as available tools

He then runs a tool-call loop (up to 5 rounds) and streams the result. Each
tool invocation is announced inline: `🔧 Dave is invoking \`<tool_name\>`…`.

#### Tool-selection guidance baked into Dave's system prompt

- Before asking the user for config values, call `terraform_discover_workspace`.
- For "where does this variable come from?" → `terraform_resolve_variable`.
- For "is anything out of sync?" → `terraform_check_drift`.
- Always run `terraform_lint_workflows` after `terraform_sync_workflows`.
- When scaffolding Service Catalog products, follow the lambda-template-repo-generator pattern: separate `deploy/` and `deploy_product/` directories, snake_case CFN properties, `!Sub` for account/region.

#### Example prompts

```
@dave plan staging
@dave apply production
@dave /search aws_lambda_function with provisioned_concurrency
@dave why is var.region resolving to us-east-2 in prod?
@dave scale my runners up to 5 in the production environment
@dave scaffold a python dev env for infra/lambda-image-processor
@dave bump the service catalog artifact in infra/sc-product-data-platform to 1.2.0
@dave tail logs for the processor function in us-east-1
```
