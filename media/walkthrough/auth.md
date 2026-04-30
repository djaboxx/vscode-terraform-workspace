# Sign in & diagnose GitHub scopes

Everything in this extension goes through GitHub:

- Reading workflow runs and logs
- Triggering `workflow_dispatch` for plan / apply
- Reading and writing **Variables** and **Secrets** at repo and environment scope
- Searching HCL across your org
- Generating new repos from template repositories

You need a token with **`repo`**, **`read:org`**, and **`workflow`** scopes.
The first time the extension calls GitHub it will prompt you to sign in via the
built-in VS Code GitHub authentication provider.

## When something returns 403

Don't guess which scope is missing. Run **Terraform: Diagnose GitHub Auth
Scopes**. It probes each API surface — repo read, workflow dispatch, org
search, environments — and prints a per-surface verdict (`all_good`,
`forbidden`, `not_found`, `rate_limited`). The output points you at exactly
the scope or org-allowlist setting that needs fixing.

## SSO orgs

If your org enforces SAML SSO, your token must be **explicitly authorized**
for that org. The diagnostic will say `forbidden` on org-scoped surfaces
when this is the issue. Open `https://github.com/settings/tokens` →
Configure SSO.
