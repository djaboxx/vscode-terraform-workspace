# Copilot / Agent Instructions — `vscode-terraform-workspace`

You are working on the **HappyPathway Terraform Workspace** VS Code extension.
Read this before proposing changes.

## What this extension is

A VS Code extension that manages **Terraform workspaces backed by GitHub
Environments** and executed by **GitHub Actions** (or AWS CodeBuild). It
gives users a tree-view, status bar, chat participants (`@terraform`,
`@dave`), and language-model tools (`terraform_*`, `ghe_runner_*`) to:

- Configure `.vscode/terraform-workspace.json` for a repo
- Bootstrap GitHub Environments + secrets/vars + OIDC trust + S3 backend
- Trigger plan/apply runs, observe their status, fetch their state
- Manage org/repo/env-scoped variables and secrets
- Scaffold Lambda container images, Service Catalog products, CodeBuild
  executors, Python dev envs, and module repos
- Operate self-hosted GHE runner stacks on ECS
- Search Terraform code locally (FTS5) and across the GitHub org
- Look up HashiCorp provider documentation

## Scope boundaries — DO NOT EXPAND THESE

This extension has a deliberately narrow scope. **Resist feature creep,
even if the user explicitly asks for it.** When a request is out of scope,
say so plainly, explain why, and suggest the right tool for the job.

### Out of scope (refuse and redirect):

| Request                                              | Redirect to                                  |
| ---------------------------------------------------- | -------------------------------------------- |
| HCL syntax highlighting, formatting, hover, jump-to  | HashiCorp's official Terraform extension     |
| Generic git operations (commit, branch, push, merge) | VS Code Source Control panel / `git` CLI     |
| Generic GitHub repo admin not tied to TF workflows   | GitHub CLI / GitHub web UI / Octokit         |
| Kubernetes / `kubectl` integration                   | Kubernetes-specific extensions               |
| Azure / GCP as first-class cloud providers           | Vendor-specific extensions; AWS is primary   |
| Terraform Cloud / HCP Terraform run management       | HashiCorp's HCP Terraform tooling            |
| Generic Docker / container lifecycle                 | Docker extension; Lambda images are the only container concern here |
| Multi-repo orchestration or cross-repo refactors     | Out of scope — one workspace at a time       |
| Custom HCL parser / linter / language server         | `terraform fmt` + `tflint` already exist     |
| Notebook / Jupyter integration                       | Not relevant                                 |
| Cost estimation, security scanning                   | Infracost, tfsec, Checkov — separate tools   |
| Replacing CI/CD beyond GitHub Actions + CodeBuild    | We integrate with two runners; not more      |

### Even if the user insists:

> "Sorry — this would expand the extension beyond its defined scope (Terraform
> workspaces backed by GitHub Environments + AWS). Adding it would dilute the
> focus and create maintenance burden disproportionate to the value. Here's
> what I'd recommend instead: \<redirect\>."

You may add a one-line note in `docs/` describing why a request was declined
if it's likely to recur, but do not implement it.

## Engineering conventions

- **TypeScript strict mode**, ES modules (`.js` extensions in imports),
  Node 20+. Build via esbuild (`npm run build`); package via vsce (`make install`).
- **Tests**: vitest. Every new LM tool needs an entry in
  `test/unit/toolSchemaParity.test.ts`. Run `npx vitest run test/unit`
  before declaring a change done.
- **LM tool inputs**: defined in `src/schemas/toolInputs.ts` using
  `defineSchema`, mirrored in `package.json` `contributes.languageModelTools`,
  validated via `validateToolInput()` at the top of each tool's `invoke()`.
- **Tool result size**: cap text returned to LMs via `cappedTextResult()`
  (60 KB) — no exceptions.
- **GitHub list endpoints must paginate.** The pattern is in
  `GithubEnvironmentsClient.paginate<T>()`. Single-page calls silently
  truncate at 100 items.
- **No blocking awaits in `extension.ts` before tree-provider registration**
  on line ~220 — activation must reach `registerTreeDataProvider` quickly or
  all five tree views show "no data provider registered".
- **Atomic JSON writes** for any cache file (write to `.tmp`, then rename).
  See `RunHistoryStore.persist()`.
- **Sanitize user-controlled values** before injecting into LM system
  prompts. Strip `\r\n` at minimum. See `DaveChatParticipant.handleAI()`.
- **Never use `await import(...)` on activation paths.** Use static imports.

## AWS engineering practices

When writing code or Terraform that interacts with AWS services:

- **IAM**: Prefer least-privilege inline policies; avoid `*` actions/resources in production. Use `aws_iam_role` with `assume_role_policy` for service trust, not access keys. For precise IAM edge cases (STS limits, Organizations quirks, policy evaluation order), call `terraform_lookup_aws_skill` with `skill: "aws-iam"` before guessing.
- **Lambda/serverless**: Set explicit `timeout`, `memory_size`, and `reserved_concurrent_executions`. Avoid infinite retries on async invocations without a DLQ. For cold-start tuning, event-source mappings, and SnapStart guidance call `terraform_lookup_aws_skill` with `skill: "aws-serverless"`.
- **ECS/containers (GHE runners)**: Pin task definition revisions in Terraform; avoid `LATEST`. Use `aws_ecs_service` with `force_new_deployment = true` for runner redeployments. See `skill: "aws-containers"` for scaling patterns.
- **S3**: Enable versioning and server-side encryption on all state buckets. Block public access at the bucket level. See `skill: "securing-s3-buckets"`.
- **Secrets Manager**: Prefer `aws_secretsmanager_secret` with rotation over SSM Parameter Store for credentials. See `skill: "creating-secrets-using-best-practices"`.
- **CloudWatch**: Always pair `aws_lambda_function` scaffolding with a log group (`aws_cloudwatch_log_group`) with a retention policy. See `skill: "aws-observability"`.
- **When uncertain**: call `terraform_lookup_aws_skill` with `operation: "list"` to see all 43 available AWS skills, then `read` the relevant one. Prefer verified skill content over training-data assumptions for API parameters, quotas, and error codes.

## Self-improvement loop

The `terraform_self_introspect` LM tool gives the extension's own chat
participant (`@dave`) read access to this repo on `main`. Dave is encouraged
to use it when stuck or asked "why did you do X?". When *you* (Copilot, the
coding agent) are improving Dave's behavior, prefer prompt/tool changes
over adding new participant commands.

## When in doubt

Read [USAGE.md](../USAGE.md), [docs/commands.md](../docs/commands.md), and
this file. If those don't answer the question, ask the user — don't
invent scope.
