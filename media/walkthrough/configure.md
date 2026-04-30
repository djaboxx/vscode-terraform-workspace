# Configure your workspace

The configuration panel writes `.vscode/terraform-workspace.json` — the single source of truth for everything this extension does.

You'll need:

- **Repo slug** — `org/repo` of the Terraform repo
- **Composite action org** — where the bundled `aws-auth`, `gh-auth`, `terraform-init`, `terraform-plan`, `terraform-apply`, `s3-cleanup` actions are scaffolded (defaults to your repo via `useLocalActions`)
- **Workspaces / Environments** — one entry per `dev`/`stage`/`prod` etc., with the cache bucket and runner group
  - Use the `environments` key if your repo uses **GitHub Actions Environments** (`useGhaEnvironments: true`, the default)
  - Use the `workspaces` key for **flat repos** that do not have GHA Environments (`useGhaEnvironments: false`)

The schema is validated live as you type — diagnostics appear inline if anything is off.
