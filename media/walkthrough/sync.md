# Sync workflows

`Terraform: Sync Workflows` regenerates `.github/workflows/terraform-plan-<name>.yml` and `terraform-apply-<name>.yml` for every workspace in your config.

Each workflow:

1. Authenticates to AWS via OIDC (`aws-auth`)
2. Authenticates to GitHub as a GitHub App (`gh-auth`)
3. Sets up Terraform / OpenTofu (`setup-terraform`)
4. Runs `terraform init` against your S3+DynamoDB backend (`terraform-init`)
5. Runs `terraform plan -detailed-exitcode` (`terraform-plan`) and posts a sticky PR comment
6. (Apply only) Runs `terraform apply` if `pending_changes == true` (`terraform-apply`)
7. Cleans the S3 plan cache (`s3-cleanup`)

For **GHA-Environment repos** (`useGhaEnvironments: true`, the default), each job includes an `environment: <name>` key that gates execution on deployment protection rules.

For **flat repos** (`useGhaEnvironments: false`), the `environment:` key is omitted — runs trigger immediately with no GitHub Environment gate.

Re-run after every config change — or set `terraformWorkspace.autoSyncWorkflows` to `true` to do it automatically.
