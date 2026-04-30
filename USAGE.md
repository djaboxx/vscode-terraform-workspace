# USAGE — opinionated workflow

This extension is opinionated. It does one thing well: **manage Terraform
infrastructure that lives in GitHub repositories and is applied by GitHub
Actions, with AI in the loop for codegen, search, and operations**.

It is *not* a generic Terraform extension. It is *not* a wrapper around
`terraform` CLI. It does not run plans on your laptop.

If your workflow doesn't match the model below, this extension will feel wrong.
That's intentional — narrow scope is the feature.

---

## The model in one paragraph

You author Terraform modules and Terraform-consuming repositories on GitHub.
Each repository represents one or more **workspaces** (dev / staging / prod).
For repos that use GitHub Actions Environments, each workspace maps 1:1 to a
**GitHub Environment** with its own variables, secrets, and deployment
protection rules (`useGhaEnvironments: true`, the default). For **flat repos**
that store state in S3 but do not use GitHub Actions Environments, set
`useGhaEnvironments: false` and declare workspaces under the `workspaces` key
instead of `environments` — the extension treats both identically at runtime.
Plans and applies are **GitHub Actions workflows** triggered via
`workflow_dispatch`, auth’d to AWS via **OIDC** (no long-lived keys). New
repositories start from **template repositories** — the scaffolding is a
`repo/generate` API call, not a `cookiecutter` clone. AI is a **first-class
operator**, not just a chat sidebar: it can search your org’s HCL, trigger
plans, set variables, diagnose drift, and lint workflows through registered
language-model tools.

---

## The recommended day-zero setup

1. **Authenticate.** Sign in to GitHub when prompted. The extension needs the
   `repo`, `read:org`, and `workflow` scopes. Run **Terraform: Diagnose GitHub
   Auth Scopes** if anything later returns 403 — it probes each API surface
   individually so you see *which* scope is missing.

2. **Open a Terraform repository** that is structured around environments
   (one folder per env, or one workspace per env). The extension auto-discovers
   workspaces from `*.tf` files, `.github/workflows/*.yml`, and existing
   GitHub Environments. You can usually skip manual configuration.

3. **Verify the workspace tree** in the **Terraform Workspace** activity-bar
   view. You should see your environments, variables, secrets, and run history.
   If anything is missing, run **Terraform: Refresh Workspaces**.

4. **Wire OIDC trust on the AWS side.** Use the
   `terraform_scaffold_oidc_trust` chat tool (or the **Scaffold OIDC Trust**
   command) to generate the IAM trust policy JSON scoped to your
   `org/repo:env:name`. Apply that policy via your AWS account-bootstrap
   process — the extension generates, it does not apply.

5. **Bootstrap S3 + DynamoDB backend** the same way using
   `terraform_scaffold_backend`. Generated HCL is paste-ready into a
   `backend.tf`.

---

## The recommended day-to-day workflow

### Authoring a new module or service

Use the **`terraform_scaffold_from_template`** chat tool, not `git init` and
not a manual UI click:

```
@terraform scaffold a new repo from happypathway/template-aws-module
called terraform-aws-thing in the happypathway org
```

This calls `POST /repos/{template_owner}/{template_repo}/generate`. The
extension returns the new repo URL and clone command. Templates are how new
work starts here — never copy-paste from another repo.

### Searching for prior art

Before writing new HCL, search what you've already built:

```
@terraform search aws_lambda_function with provisioned_concurrency
```

The chat participant runs `terraform_search_tf_code`, which queries:

1. The **local FTS5 index** of the workspace's `.tf` files
2. **GitHub code search** scoped to your org with `language:HCL`

It then asks the LM to synthesize the patterns it finds. Use this constantly.
Most "how do I configure X" questions end here.

### Running a plan

```
@terraform plan staging
```

The chat participant invokes `terraform_run_plan`, which dispatches the
`terraform-plan-staging.yml` workflow. The run URL streams back. Plan output
is fetched via `terraform_get_run_status`. **You do not run terraform
locally.** If you find yourself wanting to, the workflow probably needs
fixing instead.

### Setting variables and secrets

Variables: chat is fine. `@terraform set variable region=us-east-1 in staging`.

**Secrets: prefer the `Terraform: Add Secret` command** over chat. The chat
path works (`terraform_set_variable` with a `secret: true` flag) and the
response is redacted, but the secret value has already passed through the
language model by the time the tool is invoked. The command-palette path
keeps the value on-device. This is enforced as a warning in the tool's
confirmation dialog — read it.

### Validating workflows

After every workflow change (and the extension regenerates these for you when
you re-sync), run `terraform_lint_workflows`. It runs `actionlint` with a
15-second timeout under the hood and groups issues by file. If actionlint
isn't installed, the tool reports that cleanly — install via `brew install
actionlint`.

### Detecting drift

`@terraform check drift` runs `terraform_check_drift`, which inspects the
most recent plan run for each environment and flags any that exited with
code 2 (drift detected). Run this before standups, before deploys, and on
schedule.

---

## Where AI fits

The chat participant (`@terraform`) is given the full set of `terraform_*`
language-model tools and is instructed to use them. It will:

- Auto-discover your config before asking you for values
- Run plans and report status without you leaving the editor
- Resolve "where does this variable come from?" by walking the env hierarchy
- Lint generated workflows immediately after generating them
- Refuse to invent commands that don't exist

You can also use the tools directly from any chat agent that supports
language-model tools — they are registered globally, not gated to this
participant.

---

## Recurring patterns this extension is tuned for

These are the patterns the defaults, scaffolders, and templates were designed
around. If your work fits one of them, the path through the extension is
short. If it doesn't, you'll be fighting the defaults.

### Pattern 1 — One repository per Terraform module (`terraform-aws-<thing>`)

Modules live in their own repos, named `terraform-<provider>-<thing>`, each
with its own README, `examples/`, and CI. New modules start from a `template-`
repo via `terraform_scaffold_from_template`. The extension's `repoOrg` and
`compositeActionOrg` settings exist so you don't retype the owner; set them
once per workspace and the scaffold flow pre-fills them.

Recommended template-repo conventions (so the scaffolder produces something
useful out of the box):

- `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` at the root
- `examples/<name>/` with a runnable example per use-case
- `.github/workflows/terraform-plan.yml` + `terraform-apply-<env>.yml`
  generated by `terraform_sync_workflows` on first sync
- `.devcontainer/devcontainer.json` so CI and local dev use the same
  toolchain (the extension's own CI is devcontainer-based — mirror it)
- A `README.md` with inputs/outputs auto-generated by `terraform-docs`

### Pattern 2 — Lambda + API Gateway service repos

A common repo layout this extension fits well:

```
service-name/
  main.tf                # api gateway, lambda, iam role
  src/                   # python or node handler
  examples/dev/          # one folder per environment, all wired to the same module
  .github/workflows/     # plan-{env}.yml, apply-{env}.yml, drift-check.yml
  .vscode/terraform-workspace.json
```

The `terraform-workspace.json` declares one workspace per `examples/<env>/`
folder, each mapped to a GitHub Environment. `terraform_run_plan dev` →
dispatches `plan-dev.yml` → returns the run URL. No local `terraform plan`,
ever.

### Pattern 3 — Consumer repos that compose modules

The pure-consumer pattern: no module code, only `module "x" { source = "..." }`
blocks pinned to versioned tags. Use `terraform_search_tf_code` constantly
here — its second-pass search of the GitHub org for `language:HCL` is the
fastest way to find which module already does what you want before writing
yet another wrapper.

### Pattern 4 — Self-hosted runner support

Set `terraformWorkspace.defaultRunnerGroup` to your runner group label
(default `self-hosted`). The generated workflows will pin `runs-on` to that
group. Per-environment overrides via the workspace's `runnerGroup` field.

### Pattern 5 — Composite actions in the consuming repo (not pulled from an org)

`terraformWorkspace.useLocalActions: true` (the default) scaffolds the
composite actions (`gh-auth`, `aws-auth`, `terraform-init`, `terraform-plan`,
`terraform-apply`, `s3-cleanup`, `setup-terraform`) into the repo at
`.github/actions/*`. This trades a bit of duplication for total
reproducibility — you can pin a workflow to a commit SHA and it will keep
working forever, even if an upstream `actions/foo@v1` is yanked. Recommended.

### Pattern 6 — OpenTofu-first, Terraform-compatible

`terraformWorkspace.preferOpenTofu: true` (the default) makes generated
workflows install and call `tofu` instead of `terraform`. The HCL is
identical; only the binary differs. Flip it off only if you are pinned to
a Terraform-Cloud-only feature.

---

## "Build me a new module repo" — the recommended sequence

1. **In the chat:** `@terraform scaffold a new repo from {org}/template-aws-module called terraform-aws-<thing> in {org}` →
   the scaffold tool creates the repo on GitHub.
2. **Clone & open** when prompted — the extension does this via the built-in
   Git extension. You land in the new folder with no further setup.
3. **Open the configuration panel** (`Terraform: Configure Workspace`) and
   declare your environments. Save. The extension auto-syncs workflows.
4. **Generate the OIDC trust policy** with `terraform_scaffold_oidc_trust`
   and apply it via your AWS bootstrap process.
5. **Generate the backend config** with `terraform_scaffold_backend` and
   commit it as `backend.tf`.
6. **First plan**: `@terraform plan dev`. It will dispatch the workflow,
   stream the run URL, and report status.
7. **Iterate.** Every time you change `.vscode/terraform-workspace.json`,
   workflows regenerate (toggle off via `autoSyncWorkflows` if you prefer
   manual control).

### Pattern 7 — Flat repos without GitHub Actions Environments

Some repos store Terraform state in S3 but do not use GitHub Actions
Environments — either because the org doesn’t have them, or because the team
prefers a simpler setup without deployment gates.

Set `useGhaEnvironments: false` in `.vscode/terraform-workspace.json` and
declare workspaces under the `workspaces` key:

```json
{
  "version": 1,
  "useGhaEnvironments": false,
  "compositeActionOrg": "my-org",
  "repo": { "name": "my-repo", "repoOrg": "my-org" },
  "workspaces": [
    { "name": "dev",  "branch": "main" },
    { "name": "prod", "branch": "main" }
  ],
  "stateConfig": {
    "bucket": "my-tfstate-bucket",
    "region": "us-east-1",
    "keyPrefix": "terraform-state-files",
    "dynamodbTable": "tf_remote_state"
  }
}
```

What changes with `useGhaEnvironments: false`:

- Generated workflow YAML **omits** the `environment: <name>` job key — no GitHub Environment gate, no required reviewers, no wait timer.
- The Variables & Secrets tree view **skips** the `listEnvironmentSecrets` / `listEnvironmentVariables` API calls and shows only Repository and Org groups.
- `DriftDetector` polls the plan workflow for each workspace normally; only the GHA Environment gate is absent.
- All other tools (`terraform_run_plan`, `terraform_run_apply`, `terraform_check_drift`, `terraform_sync_workflows`, etc.) work identically.

You can still gate deploys externally — e.g. branch protection on `main`, a PR approval requirement, or a manual approval step in the workflow.

---

## Capturing call notes and work plans

Run **Terraform: Open Call Notes** from the Command Palette, the status bar,
or the editor context menu. Paste or type meeting/call notes in the panel,
then click **Save & Build Plan**.

- Notes are saved to `.callnotes/callnotes-<date>.md` in the workspace root.
- The parser scans for action items: lines starting with `-` or `*`, and lines containing `TODO` or `ACTION` markers.
- `@username` is extracted as an assignee; `YYYY-MM-DD` is extracted as a due date.
- A formatted draft work plan (Markdown checklist with metadata) opens as an untitled document for review and commit.

---

## What this extension will not do (deliberately)

- **Run terraform locally.** Plans and applies happen in Actions. Period.
- **Manage TFE/TFC workspaces.** That model conflicts with the GitHub-native
  one. If you live in TFE, this is the wrong tool.
- **Generic IaC scaffolding** (Pulumi, CDK, OpenTofu-without-GitHub).
- **Long-lived AWS keys.** OIDC is the only supported auth pattern.
- **State-file inspection or surgery.** Use the AWS console, `terraform
  state list` locally with backend config, or `tflocal`. The extension
  links to the last successful apply and stops there.

---

## Capability ↔ delivery matrix

| Workflow                          | Tool / command                          | Status |
|-----------------------------------|------------------------------------------|--------|
| New module from template          | `terraform_scaffold_from_template`       | ✅     |
| New module repo skeleton          | `terraform_scaffold_module_repo`         | ✅     |
| Org-wide HCL search               | `terraform_search_tf_code`               | ✅     |
| Local FTS5 search                 | (same, automatic)                        | ✅     |
| Plan / apply via Actions          | `terraform_run_plan` / `_run_apply`      | ✅     |
| Run status & log links            | `terraform_get_run_status`               | ✅     |
| Variables (env / repo / org)      | `terraform_set_variable` etc.            | ✅     |
| Secrets (libsodium-encrypted)     | `Terraform: Add Secret` command          | ✅     |
| OIDC trust policy generation      | `terraform_scaffold_oidc_trust`          | ✅     |
| S3+DynamoDB backend scaffold      | `terraform_scaffold_backend`             | ✅     |
| Workflow YAML generation          | `terraform_sync_workflows`               | ✅     |
| Workflow linting                  | `terraform_lint_workflows` (actionlint)  | ✅     |
| Drift detection                   | `terraform_check_drift`                  | ✅     |
| Auto-discovery from repo          | `terraform_discover_workspace`           | ✅     |
| Auth scope diagnostics            | `Terraform: Diagnose GitHub Auth Scopes` | ✅     |
| Self-hosted runner support        | `runnerGroup` per workspace              | ✅     |
| Flat repos (no GHA Environments)  | `useGhaEnvironments: false`              | ✅     |
| Call notes & work plan generation | `Terraform: Open Call Notes`             | ✅     |
| TFE / Terraform Cloud workspaces  | —                                        | ❌ out of scope |
| Local `terraform plan`            | —                                        | ❌ out of scope |
| State surgery                     | —                                        | ❌ out of scope |

---

## When to file an issue vs. live with it

**File an issue if:**
- A tool returns 403 and `Diagnose GitHub Auth Scopes` says "all_good"
- The workflow generator produces YAML actionlint flags
- Auto-discovery misses a workspace your repo clearly contains
- The chat participant ignores a `terraform_*` tool when the question
  obviously calls for it

**Live with it (or extend it):**
- You want a different cloud-provider trust pattern
- You want different runner labels per workspace
- You want a non-template-driven scaffolding flow

The opinionated parts are the point. The configurable parts are documented
in the **Settings** UI under `terraformWorkspace.*`.
