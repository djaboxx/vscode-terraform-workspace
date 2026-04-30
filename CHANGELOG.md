# Changelog

All notable changes to the Terraform Workspace extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-04-30

### Added
- **Module-repo scaffolder** — new `terraform_scaffold_module_repo` language
  model tool that materialises USAGE.md Pattern 1 in one shot: writes
  `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` (with provider-aware
  `required_providers`), one or more `examples/<name>/` roots, a `README.md`
  with `<!-- BEGIN_TF_DOCS -->`/`<!-- END_TF_DOCS -->` injection markers, a
  `.terraform-docs.yml` that targets those markers, a Terraform `.gitignore`,
  and (optionally) a `.devcontainer/devcontainer.json`. Existing files are
  reported as skipped unless `overwrite: true` is supplied. Complements
  `terraform_scaffold_from_template` (which creates a *repo on GitHub*) by
  filling in the *contents* of an empty module repo.
- **Repo scaffolding from a template** — new `terraform_scaffold_from_template`
  language model tool and `terraform.scaffoldFromTemplate` command. The
  command-palette path runs as a guided form (input boxes + quick picks +
  progress notification) and works with **no folder open**, then offers a
  **Clone & Open** action that hands off to the built-in Git extension.
  Calls `POST /repos/{template_owner}/{template_repo}/generate` under the
  hood.
- **Expanded walkthrough** (8 steps): scaffold-from-template (step 1) →
  diagnose auth → configure → OIDC + backend → sync → lint → chat →
  drift. Featured (`featuredFor`) on `*.tf`, Terraform workflow YAML, and
  `.vscode/terraform-workspace.json`.
- **Chat participant tool-call mode** — `@terraform` now passes all 22
  `terraform_*` tools to the language model and runs a bounded tool-call
  loop, so natural-language requests dispatch real workflow runs, set
  variables, fetch run status, etc., instead of just describing what the
  user could do.
- **`USAGE.md`** — prescriptive workflow document covering the opinionated
  GitHub-Actions/OIDC/template-driven model, day-zero setup, day-to-day
  usage, security defaults, and explicit non-goals.
- **Marketplace metadata** — `license`, `bugs`, `homepage`, `qna`, and
  `galleryBanner` fields in `package.json`.

### Changed
- **Tool-result truncation cap** (`TOOL_RESULT_CHAR_CAP = 60_000`) and
  `cancelledResult()` helpers wired into long-running tools
  (`terraform_search_tf_code`, `terraform_check_drift`,
  `terraform_lint_workflows`) so cancellation is honored and very large
  responses don't blow the chat token budget.
- **SQLite migration ladder** in `RunHistoryStore` now handles three
  cases explicitly: schema from a future version (drop + rebuild),
  forward migrations in transactions, and try/catch fallback to rebuild on
  any migration failure. Run history is reconstructible from the GitHub
  API, so rebuild is safe.
- **Redaction** (`util/redact.ts`) — the `value` field is no longer
  unconditionally redacted; opt in via the `sensitive=true` parameter so
  legitimate non-secret values aren't masked.
- README rewritten around the walkthrough and tool-call mode; trailing
  duplicate headings removed; `tweetsodium` reference corrected to
  `libsodium-wrappers`.

### Fixed
- Two SQLite-corruption-recovery test failures and one redaction test
  failure surfaced by the hardening pass.
- Chat participant could mention tool names in the system prompt without
  actually being able to call them; the `tools: []` parameter was missing
  from `model.sendRequest`.

## [0.2.0] - 2026-04-29

### Added
- **Workspace auto-discovery** (`terraform.discoverDefaults` command and
  `terraform_discover_workspace` LM tool). Inspects the workspace's git
  remote, root `*.tf` files, existing GitHub Actions workflows, and GitHub
  Environments to pre-fill `terraform-workspace.json` defaults. Bootstrap
  flow now offers auto-discovery when no config exists.
- **Eight new Language Model tools** brought to twenty-one total:
  - `terraform_discover_workspace` — auto-fill workspace config from repo signals.
  - `terraform_delete_variable` — confirm-and-remove a repo or environment variable.
  - `terraform_resolve_variable` — report which scope (org/repo/env) currently
    supplies a given variable's value.
  - `terraform_review_deployment` — approve or reject a pending GitHub
    deployment review (gated on confirmation).
  - `terraform_lint_workflows` — run `actionlint` against `.github/workflows`
    and surface structured issues.
  - `terraform_check_drift` — invoke the local drift detector and report
    out-of-sync resources.
  - `terraform_scaffold_backend` — generate an S3 + DynamoDB backend
    bootstrap Terraform file for the active workspace.
  - `terraform_scaffold_oidc_trust` — generate an AWS IAM trust policy that
    federates a specific GitHub Actions repo via OIDC.
- **Tool-selection guidance** in the chat participant system prompt so the
  model picks `terraform_discover_workspace` before pestering for config,
  and reaches for `terraform_resolve_variable` / `terraform_check_drift` /
  `terraform_lint_workflows` at the right moments.
- **Schema-drift integration test** (`test/unit/toolSchemaParity.test.ts`)
  that locks `package.json` `languageModelTools[].inputSchema` against each
  TS-side `XxxInputSchema`, asserting property-name parity, required-field
  parity, `type=object`, and per-property typing for every declared tool.
- **Auto-discovery unit tests** (`test/unit/WorkspaceAutoDiscovery.test.ts`)
  covering backend/provider parsing, branch hints, config building, and the
  human-readable summary.

### Changed
- `ActionlintRunner.run()` now returns `Promise<ActionlintIssue[]>` and
  accepts an optional `{ silent?: boolean }` flag so LM tool callers can
  invoke linting without surfacing VS Code notifications.
- `ExtensionServices` exposes optional `actionlint` and `drift` handles
  (post-attached during `activate` to keep construction order acyclic).
- README updated to reflect twenty-one tools and the auto-discovery flow.

### Fixed
- Three empty `catch` blocks in `extension.ts` now carry intent comments and
  no longer trip ESLint.
- Removed several unused imports and prefixed unused parameters with `_`
  across `WorkspaceConfigPanel`, `RunsTreeProvider`, `GithubOrgsClient`,
  `WorkspaceConfigManager`, and `GitRemoteParser`.

## [0.1.0] - Initial release

- Thirteen Language Model tools wrapping plan/apply/state/variable
  management against GitHub Actions-backed Terraform workspaces.
- Activity Bar views for workspaces, runs, and variables.
- Webview-based workspace config editor.
- AJV-validated tool inputs at the boundary.
