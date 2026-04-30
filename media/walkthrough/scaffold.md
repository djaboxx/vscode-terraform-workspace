# Scaffold a new repo from a template

In this workflow, **new work always starts from a template repository**.
You don't `git init`, you don't copy-paste from another repo. You generate.

Templates encode:

- Folder layout (one folder per environment, or one workspace per env)
- Standard `.github/workflows/` skeletons that this extension can then sync
- A `.vscode/terraform-workspace.json` skeleton so auto-discovery just works
- README, LICENSE, CODEOWNERS, branch-protection conventions

## How

You have two equivalent paths:

**From the command palette** (works with no folder open — perfect for a fresh
`code` window):

> **Terraform: Scaffold Repo From Template…**

You'll be prompted for the template owner, template repo, new name, optional
new owner, optional description, visibility, and whether to copy all
branches. After the repo is created, you'll get a notification with a
**Clone & Open** button that hands off to the built-in Git extension.

**From the chat participant**:

```
@terraform scaffold a new repo from happypathway/template-aws-module
called terraform-aws-thing in the happypathway org, private
```

Both paths call `POST /repos/{template_owner}/{template_repo}/generate` and
prompt for confirmation. Use whichever feels natural — the chat path is
better when you can describe what you want in one sentence; the palette
path is better when you want a guided form.

On success the chat returns the new repo's URL and clone command. Clone it,
open it in VS Code, and the rest of this walkthrough resumes from
**Configure your workspace**.

## Requirements

- The template repo must be marked as a **template** on GitHub (Settings →
  General → "Template repository").
- Your token must have `repo` scope on the **target owner** (not just the
  template owner).
