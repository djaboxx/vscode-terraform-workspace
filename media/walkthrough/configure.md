# Configure your workspace

The configuration panel writes `.vscode/terraform-workspace.json` — the single source of truth for everything this extension does.

You'll need:

- **Repo slug** — `org/repo` of the Terraform repo
- **Composite action org** — where the bundled `aws-auth`, `gh-auth`, `terraform-init`, `terraform-plan`, `terraform-apply`, `s3-cleanup` actions are scaffolded (defaults to your repo via `useLocalActions`)
- **Environments** — one entry per `dev`/`stage`/`prod` etc., with the cache bucket and runner group

The schema is validated live as you type — diagnostics appear inline if anything is off.
