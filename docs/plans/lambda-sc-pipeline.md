# Plan: Service Catalog → Lambda → CodeBuild → Repo Tooling

## Context

Users build Service Catalog products that present a form. SC fires a custom Lambda
(packaged as a container image, built via packer-pipeline, runs Python). The Lambda
triggers a CodeBuild job that takes the captured parameters, parses arbitrary template
files, and pushes a freshly templated repo into GitHub.

Three asset classes the user must manage:

1. The Lambda container image (Python + handler) built via packer-pipeline.
2. The Service Catalog product + portfolio + launch constraints.
3. The CodeBuild templater (the job that renders templates → repo).

Plus the runtime concerns: drift between deployed Lambda config and Terraform,
replaying failed invocations, and end-to-end traceability when a provisioning
record fails.

## Goals

- Make the "I changed the form, now what?" loop a sub-minute, in-editor flow.
- Pin Lambda image deploys by digest, never by tag, automatically.
- Let authors render the templated repo locally before SC users hit submit.
- Give support engineers a single trace from SC record → Lambda → CodeBuild → repo.

## Non-goals (for now)

- Running Service Catalog itself locally (no LocalStack hard dep).
- Replacing the existing packer-pipeline tool — we *call* it, not replace it.
- AppConfig / Lambda Powertools integration. Out of scope.

## Phases

### L1 — Lambda container image scaffold + dispatch (start here)

Mirrors the existing `codebuildExecutorTf` / `CodeBuildDispatcher` pair.

**Scaffolder** (`src/lambda/LambdaImageScaffolder.ts`):
- Emits `infra/lambda-image-<fn>/`:
  - `packer.pkr.hcl` — amazon-ecr source, Python base, copies `src/` into `/var/task`.
  - `build.hcl` — `packer_pipeline { ... }` block consumed by the existing packer-pipeline CLI.
  - `ecr.tf` — `aws_ecr_repository` with lifecycle policy (keep last 10 untagged, expire after 30d).
  - `lambda.tf` — `aws_lambda_function` with `package_type = "Image"`, `image_uri` referencing a `var.image_digest` so each apply pins by digest.
  - `variables.tf`, `outputs.tf`.
  - `src/handler.py` skeleton (only if missing).

**Dispatcher** (`src/lambda/LambdaImageDispatcher.ts`):
- `buildAndPublish(inputs, token)`:
  - Zip the lambda dir, upload to S3, kick `packer-pipeline` CodeBuild project (reuses `CodeBuildDispatcher` plumbing — extract a shared `dispatchCodeBuild` helper).
  - Tail logs.
  - Parse the build's `imageDetails` (or pull `aws ecr describe-images --image-ids imageTag=<sha>`) to capture the immutable digest.
  - Write the digest back into `terraform.tfvars.json` next to `lambda.tf` so the next `terraform apply` pins it.

**Commands**:
- `terraform.scaffoldLambdaImage`
- `terraform.buildAndPublishLambdaImage`

**LM tools**:
- `terraform_scaffold_lambda_image`
- `terraform_build_lambda_image`

**Tests**: snapshot of generated packer/Terraform files; tfvars-write round-trip.

### L2 — Lambda runtime (deferred until L1 lands)

- `lambda_tail_logs` — `aws logs tail` wrapped in an output channel; QuickPick last 10 request IDs from recent failed invocations.
- `lambda_diff_config` — read deployed `aws lambda get-function-configuration` → diff vs. Terraform's `aws_lambda_function` resource. Reuse `DriftDetector` patterns.
- `lambda_replay_event` — fetch event from CW Logs JSON line / DLQ / SQS by request ID, write to `events/replay-<ts>.json`, optionally re-invoke (`aws lambda invoke`).
- `lambda_promote_alias` — list versions with digest + creation time, one-click point alias `prod` → `:N`.

### L3 — Service Catalog product + portfolio (highest user-value alongside L1)

**Scaffolder** (`src/servicecatalog/SCProductScaffolder.ts`):
- Inputs: `portfolioId`, `productName`, `owner`, `supportEmail`, `launchRoleName`, `templateBucket`, `templateKey`, optional `parametersSchema` (JSON schema describing the form).
- Emits `infra/sc-product-<name>/`:
  - `product.tf` — `aws_servicecatalog_product` + initial `aws_servicecatalog_provisioning_artifact` (v1.0.0) + `aws_servicecatalog_product_portfolio_association` + `aws_servicecatalog_constraint` (launch role).
  - `template-constraints.tf` — generated from `parametersSchema` (Rules block with `AssertDescription` per field). This is the killer feature.
  - `variables.tf`, `outputs.tf`.

**Provisioning-artifact bumper** (`src/servicecatalog/SCArtifactBumper.ts`):
- `bump(input)`:
  - Reads current product.
  - Uploads new template to S3 with versioned key.
  - Writes a new `aws_servicecatalog_provisioning_artifact` Terraform resource block, marking the previous as `active = false`.
  - Opens a diff so the user sees what changed before applying.

**Dry-render command** (lives in L4 but exposed here too):
- Given a `parametersSchema` + sample inputs JSON, render what SC will pass to the Lambda + what the Lambda will pass to CodeBuild + what the templater will produce. All locally, no AWS calls.

**Commands**:
- `terraform.scaffoldServiceCatalogProduct`
- `terraform.bumpServiceCatalogArtifact`
- `terraform.dryRenderServiceCatalogProduct`

**LM tools**:
- `terraform_scaffold_sc_product`
- `terraform_bump_sc_artifact`
- `terraform_dry_render_sc_product`

### L4 — CodeBuild templater authoring

- **Template lint**: walk a templater repo, find Jinja2/Go/whatever templates, parse them, and confirm every variable reference appears in the inputs schema. Surface as Diagnostics.
- **Local render**: given a templater repo + sample inputs JSON, render the output repo into `/tmp/rendered-<ts>/` and open in a new VS Code window.
- **Post-creation validation hook** (optional, in the templater itself, not the extension): emit a `validate.sh` that runs `terraform validate` / `tflint` / `actionlint` on the rendered output.

### L5 — Cross-cutting trace view

- Given an SC provisioning record ID:
  - `aws servicecatalog describe-record` → grab Lambda invocation request ID from outputs.
  - Pull Lambda CW Logs for that request ID (start time → start time + Lambda timeout).
  - Extract CodeBuild build ID from the Lambda log output.
  - Pull CodeBuild logs + status.
  - If repo URL is in CodeBuild output, link to it.
- Render as a tree view in the activity bar; each node is a clickable surface (open in browser, copy ID, etc.).

## Implementation order

1. Refactor `CodeBuildDispatcher` → extract a shared `dispatchToCodeBuild(projectName, sourceLocation, envOverrides, output, token)` helper. **No behavior change**, just makes L1 reuse cheap.
2. **L1 scaffolder + dispatcher + commands + LM tools.** End-to-end round-trip test.
3. **L3 product scaffolder + artifact bumper.** TemplateConstraint generator from JSON schema.
4. **L4 dry-render** (small, useful, isolated).
5. L2 runtime tools (smaller, can be added piecemeal).
6. L5 trace view (depends on everything above being in place).

## Out of scope this PR

L2, L4 lint pass, L5 trace view. These are noted in `/memories/repo/backlog.md`.

## Open questions

- Should the Lambda image scaffolder assume the user already has the packer-pipeline
  CodeBuild project provisioned? **Decision: yes** — same assumption as the Terraform
  CodeBuild executor. We optionally emit a `infra/packer-pipeline-project/main.tf`
  later if users ask.
- Should we generate the SC parameters schema by introspecting the Lambda handler's
  type hints? **Defer** — too magical for v1; user supplies the schema.
