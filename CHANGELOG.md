# Changelog

All notable changes to the Terraform Workspace extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-04-30

### Added
- **Python developer inner-loop for Lambda images (Phase A, Docker-free)** — three new commands and three new LM tools that close the inner-loop gap left by the Lambda image scaffolder. The target environment cannot run local Docker, so all inner-loop tooling is venv-only:
  - `Lambda: Scaffold Python Dev Environment…` — layers `pyproject.toml` (auto-detects Python version from the existing `packer.pkr.hcl` base image), `Makefile`, `.devcontainer/devcontainer.json` (Codespaces-friendly, no `docker-outside-of-docker`), `.vscode/launch.json` (`Local invoke` + `pytest` debug configs), `tests/conftest.py` with a `lambda_context` fixture, `tests/test_handler.py`, `tests/events/sample.json`, and `scripts/local_invoke.py` (stdlib-only driver) onto an existing `infra/lambda-image-<fn>/` dir. Existing files are skipped, never overwritten.
  - `Lambda: Test Locally…` — invokes the handler against a sample event in a local Python interpreter (resolves `python.defaultInterpreterPath` → `<project>/.venv/bin/python` → `python3`). Streams stdout/stderr into the output channel; cancellation sends `SIGTERM`. Auto-discovers events under `tests/events/`.
  - `Lambda: Tail Function Logs…` — thin wrapper around `aws logs tail --follow` that streams into the output channel. Auto-discovers function names from `infra/lambda-image-*` dirs.
  - Three new LM tools: `terraform_scaffold_python_dev_env`, `terraform_invoke_lambda_locally`, `terraform_tail_lambda_logs`. The chat participant now exposes 31 tools (was 28).
  - Plan: `docs/plans/python-lambda-devloop.md` (Phase A shipped; Phase B IAM-from-code static analysis and Phase C Pylance MCP forwarding are deferred).
- **Scope expansion: AWS pipeline tooling beyond Terraform** — the extension now spans four pillars (Terraform on GHA, AWS CodeBuild executors, Lambda container images via packer-pipeline, and AWS Service Catalog product authoring). Commands are split across four palette categories — `Terraform:`, `CodeBuild:`, `Lambda:`, and `Service Catalog:` — so the broader surface area is easy to scan. (Command IDs are unchanged for back-compat.)
- **Lambda container image pipeline** — `Lambda: Scaffold Container Image Project…` generates `infra/lambda-image-<fn>/` (Packer + ECR repo with lifecycle + `aws_lambda_function` pinned to `var.image_digest` + `src/handler.py` skeleton). `Lambda: Build & Publish Image…` zips → S3 → runs the existing `packer-pipeline` CodeBuild project → captures the ECR digest via `aws ecr describe-images` → writes `terraform.tfvars.json`. Cancel the progress notification to call `aws codebuild stop-build` cleanly.
- **AWS Service Catalog authoring** — `Service Catalog: Scaffold Product…` generates `infra/sc-product-<slug>/product.tf` (product + initial `v1.0.0` provisioning artifact + portfolio association + LAUNCH constraint). `Service Catalog: Bump Provisioning Artifact…` writes a new `artifact-v<ver>.tf` additively (refuses to overwrite). `Service Catalog: Dry-render Product Form Inputs…` validates a sample inputs JSON against a JSON Schema (required, type, enum, pattern, min/max) before publishing. The same JSON Schema is transpilable to CloudFormation `Rules` so the constraints are also enforced at launch.
- **Five new language model tools** — `terraform_scaffold_lambda_image`, `terraform_build_lambda_image`, `terraform_scaffold_sc_product`, `terraform_bump_sc_artifact`, `terraform_dryrender_sc_product`. The `@terraform` chat participant now exposes 28 tools (was 23). Tool/Palette parity is enforced by `test/unit/toolSchemaParity.test.ts`.
- **CodeBuild executor commands re-categorised** — `Terraform: Scaffold CodeBuild Executor…` → `CodeBuild: Scaffold Executor Project…`; `Terraform: Run Plan in CodeBuild` → `CodeBuild: Run Terraform Plan…`; `Terraform: Run Apply in CodeBuild` → `CodeBuild: Run Terraform Apply…`. Underlying command IDs (`terraform.scaffoldCodebuildExecutor`, `terraform.runPlanInCodeBuild`, `terraform.runApplyInCodeBuild`) are unchanged.
- **Plan doc** — `docs/plans/lambda-sc-pipeline.md` describing the 5-phase Lambda + Service Catalog pipeline (L1 image, L2 runtime, L3 product, L4 templater, L5 trace view). L1, L3, and L4 dry-render shipped in this release; L2 and L5 are deferred.
- **Call Notes panel** — `Terraform: Open Call Notes` command (also reachable from a new status-bar button and the editor context menu) opens a WebView where meeting/call notes are captured, saved to `.callnotes/callnotes-<date>.md`, and parsed into a draft work plan. The parser extracts action items from `-`/`*` list items and `TODO`/`ACTION` markers, detects `@username` as assignee, and recognises `YYYY-MM-DD` due dates. The draft plan opens as an untitled Markdown document.
- **Flat-repo support** (`useGhaEnvironments: false`) — repos that do not use GitHub Actions Environments can now be configured without the semantic mismatch of having an `environments` key. Use the new `workspaces` key (same shape as `environments`) to declare named Terraform workspace run-configurations. When false: the generated workflow YAML omits the `environment:` job key (no GHA Environment gate), and the Variables & Secrets view skips environment-scoped API calls.
- **`workspaces` config key** — alias for `environments` intended for flat repos. `WorkspaceConfigManager.read()` normalises `workspaces` → `environments` on load so all downstream consumers (WorkflowGenerator, VariablesTreeProvider, DriftDetector, chat participant, tools) require no changes. `getWorkspaces(config)` exported from `types/index.ts` for code paths that construct `WorkspaceConfig` objects directly.
- **JSON schema updated** — `schemas/terraform-workspace.schema.json` now requires `version` + `repo` only, enforces exactly one of `environments` or `workspaces` via `oneOf`, and documents both keys with descriptions.
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
