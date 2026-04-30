# Operate via the chat participant

`@terraform` is a first-class operator, not a chat sidebar. It has access
to **22 language-model tools** and is instructed to use them. You can drive
the entire day-to-day workflow through it.

## What to ask

| You say | It runs |
|---|---|
| `@terraform plan staging` | `terraform_run_plan` → dispatches the workflow, returns the run URL |
| `@terraform what's the status of the last apply?` | `terraform_get_run_status` |
| `@terraform search aws_lambda_function with provisioned_concurrency` | `terraform_search_tf_code` (local FTS5 + GitHub org code search) |
| `@terraform why is var.region resolving to us-east-2 in prod?` | `terraform_resolve_variable` (walks env → repo → org) |
| `@terraform set variable region=us-east-1 in staging` | `terraform_set_variable` |
| `@terraform check drift` | `terraform_check_drift` |
| `@terraform lint the workflows` | `terraform_lint_workflows` (actionlint) |
| `@terraform scaffold a repo from <template>` | `terraform_scaffold_from_template` |

## Secrets — prefer the command palette

Setting a secret via chat works (the response is redacted) but the secret
value still passes through the language model. For real secrets, use
**Terraform: Add Secret** from the command palette — the value stays
on-device and is libsodium-encrypted before it leaves.

## What it won't do

It will not invent commands. It will not run `terraform` locally. It will
not edit your state file. If you ask for those, it will tell you why and
offer the supported alternative.
