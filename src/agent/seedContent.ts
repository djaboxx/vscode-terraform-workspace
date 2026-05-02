/**
 * Pre-seed content for AgentMemory — gives Dave a useful starting brain
 * before the user has typed a single `/decide` or `/learn`.
 *
 * Sourced from .github/copilot-instructions.md, AGENTS.md, USAGE.md,
 * docs/commands.md, and observed code patterns. Run via the
 * `terraform.dave.seedMemory` command. Idempotent — every entry uses
 * `recordOnce` keyed on a stable seed:* dedupKey, so re-seeding never
 * duplicates anything.
 */

import type { AgentMemory } from './AgentMemory.js';

interface SeedDecision {
  slug: string;
  content: string;
}

interface SeedPlaybook {
  name: string;
  body: string;
}

interface SeedFact {
  topic: string;
  key: string; // becomes part of dedupKey
  content: string;
}

const DECISIONS: SeedDecision[] = [
  {
    slug: 'scope-discipline',
    content:
      'This extension has a deliberately narrow scope: Terraform workspaces backed by GitHub Environments + AWS, executed by GitHub Actions or CodeBuild. ' +
      'Refuse out-of-scope requests (HCL syntax, generic git, k8s, Azure/GCP-first, TFE/HCP, Docker generic, multi-repo orchestration, custom HCL parser, notebooks, cost/security scanning) ' +
      'even if the user pushes back. Redirect to the right tool. See the table in .github/copilot-instructions.md.',
  },
  {
    slug: 'paginate-everything',
    content:
      'Every GitHub list endpoint MUST use the `paginate<T>()` pattern from GithubEnvironmentsClient. ' +
      'Single-page calls silently truncate at 100 items and produce subtle missing-data bugs.',
  },
  {
    slug: 'atomic-cache-writes',
    content:
      'Any cache or memory file write must be atomic: write to a `.tmp` sibling, then `renameSync`. ' +
      'See AgentMemory.persist() and RunHistoryStore.persist(). A crash mid-write must never leave a half-written JSON the next load() would discard.',
  },
  {
    slug: 'no-await-on-activation',
    content:
      'extension.ts must reach `registerTreeDataProvider` (around line 220) without blocking awaits. ' +
      'Never use `await import(...)` on the activation hot path. Lazy imports are OK only after tree providers are registered. ' +
      'If activation blocks, all five tree views show "no data provider registered".',
  },
  {
    slug: 'tool-result-cap',
    content:
      'Every LM tool result must go through `cappedTextResult()` (60 KB cap). No exceptions. ' +
      'Oversized results crash the chat surface or get silently truncated mid-JSON.',
  },
  {
    slug: 'lm-tool-quartet',
    content:
      'Every new LM tool needs four things in lockstep: (1) defineSchema entry in src/schemas/toolInputs.ts, ' +
      '(2) class in src/tools/TerraformTools.ts or RunnerTools.ts, ' +
      '(3) contributes.languageModelTools entry in package.json, ' +
      '(4) row in test/unit/toolSchemaParity.test.ts. Skip any one and the parity test fails.',
  },
  {
    slug: 'no-new-chat-participants',
    content:
      'Only two chat participants exist: @terraform and @dave. Do not add more. New conversational surfaces should be slash commands on @dave, not new participants.',
  },
  {
    slug: 'sanitize-lm-prompts',
    content:
      'Any user-controlled value injected into an LM system prompt must have \\r\\n stripped at minimum. ' +
      'See DaveChatParticipant.handleAI. Failure to sanitize enables prompt injection.',
  },
  {
    slug: 'oidc-only-aws-auth',
    content:
      'AWS authentication from GitHub Actions uses OIDC only — no long-lived access keys. ' +
      'Use `terraform_scaffold_oidc_trust` to generate the IAM trust policy scoped to org/repo:env:name.',
  },
  {
    slug: 'no-local-terraform',
    content:
      'Plans and applies happen in GitHub Actions or CodeBuild. Never local `terraform plan`. ' +
      'If the user wants to run locally, the workflow probably needs fixing instead. State surgery is also out of scope.',
  },
  {
    slug: 'opentofu-default',
    content:
      'Generated workflows install and call `tofu` instead of `terraform` by default (terraformWorkspace.preferOpenTofu). ' +
      'HCL is identical; only the binary differs. Flip off only for TFC-only features.',
  },
  {
    slug: 'local-actions-default',
    content:
      'terraformWorkspace.useLocalActions: true is the default — composite actions scaffold into .github/actions/* in the consuming repo. ' +
      'Trades a bit of duplication for total reproducibility (workflows pinned to a SHA keep working forever).',
  },
  {
    slug: 'secrets-via-command-not-chat',
    content:
      'Secret values must be set via the `Terraform: Add Secret` command, not chat. ' +
      'The chat path works (terraform_set_variable with secret:true) but the value passes through the LM first. ' +
      'The command-palette path keeps the value on-device.',
  },
  {
    slug: 'template-driven-scaffolding',
    content:
      'New module/service repos start from `template-*` repos via `terraform_scaffold_from_template` (POST /repos/{owner}/{repo}/generate). ' +
      'Never copy-paste from another repo. Never `git init` a new module from scratch.',
  },
  {
    slug: 'fts5-then-org-search',
    content:
      'Code search is two-pass: local FTS5 index of workspace .tf files first, then GitHub code search scoped to the org with `language:HCL`. ' +
      'Use this constantly before writing new HCL — most "how do I configure X" questions end here.',
  },
  {
    slug: 'workflows-then-lint',
    content:
      'After every workflow regeneration (terraform_sync_workflows), run terraform_lint_workflows. ' +
      'It runs actionlint with a 15s timeout and groups issues by file. Catches most generation bugs immediately.',
  },
  {
    slug: 'flat-repos-supported',
    content:
      'Two workspace models: useGhaEnvironments:true (default, environments[] with GitHub Environments) and useGhaEnvironments:false (flat workspaces[] with S3 backend, no Environment gates). ' +
      'Both work identically in tools; flat repos just skip env-secret/var listing.',
  },
  {
    slug: 'memory-topic-conventions',
    content:
      'AgentMemory topics follow conventions: repo:{owner}/{name}, aws:account-{id}, lambda:{fn}, sc:{product}, runner:{env}, user:preferences, playbook:{name}, decision:{slug}, inbox. ' +
      'Stick to these so /digest and /recall_decisions surface things consistently.',
  },
  {
    slug: 'react-to-failure-not-poll',
    content:
      'RunHistoryStore.setFailureObserver fires on transition into failure/timed_out (not on every poll). ' +
      'Wired in extension.ts to record a memory entry deduped by `tfrun:{runId}` so a single failed run records exactly once.',
  },
  {
    slug: 'trust-threshold-5-good',
    content:
      'A playbook is auto-trusted (👍≥5 ∧ 👎=0). Auto-trusted playbooks execute without confirmation. ' +
      'See AgentMemory.isAutoTrusted, MatchPlaybookTool ✨ AUTO-TRUSTED tag, handlePlaybook trust-execute branch, and the EXCEPTION clause in Dave\'s system prompt. All four surfaces must agree.',
  },
  {
    slug: 'inbox-watcher-source',
    content:
      'InboxWatcher polls GitHub `is:pr is:open review-requested:@me archived:false` every 30 minutes + on focus regain. ' +
      'Each PR becomes a deduped todo under topic `inbox`. Independent of the autonomous agent; uses the VS Code GitHub session.',
  },
  {
    slug: 'digest-watcher-fingerprint',
    content:
      'DigestWatcher uses a fingerprint of (open todo count + recent failures + unrated playbook count) to avoid re-notifying for the same state. ' +
      'Fires on hourly timer + window focus regain. terraformWorkspace.dave.proactiveDigest disables it.',
  },
  {
    slug: 'capture-fail-with-why',
    content:
      'When recording a failure, include WHY it failed in the content, not just WHAT failed. ' +
      'A failure entry without a reason just means we will try the same thing again next time. The reason is the value.',
  },
  {
    slug: 'self-introspect-when-stuck',
    content:
      'When stuck or asked "why did you do X?", use terraform_self_introspect to read the extension\'s own source on main. ' +
      'Existing patterns are usually the answer. Search before authoring.',
  },
  {
    slug: 'never-persist-secret-values',
    content:
      'Secret VALUES must never touch disk. The WorkspaceConfig type carries secrets[].value at runtime so the Config panel can collect them and pushToGithub can send them to the GitHub API \u2014 ' +
      'but WorkspaceConfigManager.write() runs every config through stripSecretValues() before JSON.stringify, deleting the value field from repo.secrets[] and environments[].secrets[]. ' +
      'Secret NAMES stay (we need them to manage the GitHub-side lifecycle: detect drift, delete removed secrets). Variable values are NOT stripped \u2014 vars map to GitHub Actions Variables which are visible by design. ' +
      '`.vscode/terraform-workspace.json` is typically source-controlled; treat it as public. ' +
      'If you ever add a new on-disk persistence path for WorkspaceConfig, route it through write() or call stripSecretValues() yourself. Regression test lives in test/unit/WorkspaceConfigManager.test.ts (\"strips secret values before writing\").',
  },
  {
    slug: 'tfc-pipeline-is-aws-codepipeline',
    content:
      'The repo HappyPathway/terraform-tfc-pipeline (Terraform Registry: HappyPathway/pipeline/tfc) is the user\'s canonical way to run Terraform inside AWS — ' +
      'CodePipeline orchestrates CodeBuild stages (validate / plan / apply / destroy) sourced from CodeCommit, with KMS-encrypted S3 artifacts and a least-privilege IAM role. ' +
      'The "tfc" suffix is misleading: it stands for "terraform-CodePipeline", NOT Terraform Cloud. ' +
      'Composed of submodules: s3, kms, iam-role, codecommit, codebuild, codepipeline. ' +
      'Buildspecs (validate/plan/apply/destroy) live in templates/ and run tfsec, tflint, checkov, terraform fmt/validate. ' +
      'This is in scope: it is AWS-native CI for Terraform, the same family as our existing CodeBuild executor scaffolder. ' +
      'When the user asks about running Terraform in AWS CodePipeline, recall this module rather than improvising.',
  },
];

const PLAYBOOKS: SeedPlaybook[] = [
  {
    name: 'tfc-pipeline-bootstrap',
    body: [
      '# Playbook: tfc-pipeline-bootstrap',
      '',
      'Stand up a Terraform-in-AWS-CodePipeline validation pipeline using the user\'s own',
      '`HappyPathway/pipeline/tfc` Terraform Registry module (source repo:',
      'HappyPathway/terraform-tfc-pipeline). Use this when the workload must run inside AWS',
      '(no GitHub Actions reach), or when CodeCommit is the required SCM.',
      '',
      '## What it builds',
      '- S3 artifacts bucket (KMS-encrypted) for pipeline state',
      '- KMS CMK for artifact + secret encryption',
      '- Least-privilege IAM role for CodePipeline',
      '- CodeCommit source repo (or reuses an existing one via `create_new_repo = false`)',
      '- CodeBuild projects, one per buildspec: validate, plan, apply, destroy',
      '- CodePipeline wiring those four stages in order, with manual approvals between',
      '',
      '## Validate stage runs',
      '- `terraform fmt -check` and `terraform validate`',
      '- `tfsec`, `tflint`, `checkov`',
      '',
      '## Steps',
      '1. In a bootstrap repo, declare the module:',
      '   ```hcl',
      '   module "pipeline" {',
      '     source             = "HappyPathway/pipeline/tfc"',
      '     project_name       = "my-tf-workload"',
      '     environment        = "dev"',
      '     source_repo_name   = "my-tf-workload"',
      '     source_repo_branch = "main"',
      '     create_new_repo    = true',
      '     repo_approvers_arn = "arn:aws:iam::ACCOUNT:role/Approvers"',
      '     stage_input        = [...]   # validate / plan / apply / destroy',
      '     build_projects     = ["validate", "plan", "apply", "destroy"]',
      '   }',
      '   ```',
      '2. `terraform apply` the bootstrap. Output gives you `source_repo_clone_url_http`.',
      '3. Clone the new CodeCommit repo, copy the `templates/` folder (the four buildspec_*.yml files plus `scripts/tf_ssp_validation.sh`) from terraform-tfc-pipeline into the workload repo root, commit, push.',
      '4. First pipeline run triggers automatically on push. Validate → Plan → manual approval → Apply → manual approval → Destroy.',
      '5. The default IAM role is intentionally restrictive — extend the policy on `module.pipeline.iam_arn` (or pass `create_new_role = false` + `codepipeline_iam_role_name`) to grant whatever your `terraform apply` needs.',
      '',
      '## When NOT to use this',
      '- If GitHub Actions can reach the target AWS account, prefer the extension\'s standard GitHub-Environments + OIDC flow. It\'s less moving parts.',
      '- If you only need a Lambda container build, use `terraform_scaffold_codebuild_executor` directly — no CodePipeline needed.',
      '',
      '## Recall',
      'When the user says "run terraform in CodePipeline", "AWS-native terraform CI", "CodeCommit terraform pipeline", or references `HappyPathway/pipeline/tfc`, this is the module to point at.',
    ].join('\n'),
  },
  {
    name: 'add-new-lm-tool',
    body: [
      '# Playbook: add-new-lm-tool',
      '',
      'Add a new language-model tool to @terraform / @dave.',
      '',
      '## Steps',
      '1. Add input schema in `src/schemas/toolInputs.ts` using `defineSchema({...})`.',
      '2. Implement the tool class in `src/tools/TerraformTools.ts` or `src/tools/RunnerTools.ts`. ' +
        'Start invoke() with `validateToolInput(SCHEMAS.your_tool, options.input)`.',
      '3. Cap the result text via `cappedTextResult(text)` (60 KB).',
      '4. Add the `contributes.languageModelTools` entry in `package.json` mirroring the schema.',
      '5. Add a row in `test/unit/toolSchemaParity.test.ts` so parity test passes.',
      '6. If the tool calls a GitHub list endpoint, use `paginate<T>()` from GithubEnvironmentsClient.',
      '7. Run `npx vitest run test/unit` — must stay green. Then `make install`.',
    ].join('\n'),
  },
  {
    name: 'paginated-github-list',
    body: [
      '# Playbook: paginated-github-list',
      '',
      'Add a new method that calls a GitHub list endpoint.',
      '',
      '## Steps',
      '1. Find the right `Github*Client.ts` (Environments, Actions, Orgs, Search, Module).',
      '2. Use `await this.paginate<ItemType>(`/path?per_page=100`)` instead of a single fetch.',
      '3. The pattern lives in GithubEnvironmentsClient.paginate. It walks `Link: rel="next"` until exhausted.',
      '4. Default per_page to 100 to minimize requests.',
      '5. Single-page calls are a bug — they silently truncate at 100 items.',
    ].join('\n'),
  },
  {
    name: 'wire-new-treeview',
    body: [
      '# Playbook: wire-new-treeview',
      '',
      'Add a new TreeView to the Terraform Workspace activity bar.',
      '',
      '## Steps',
      '1. Create `src/views/<Name>TreeProvider.ts` implementing `vscode.TreeDataProvider<T>`.',
      '2. Register it in `extension.ts` BEFORE any blocking await — around line 220 with the others.',
      '3. Add the view contribution in `package.json` under `contributes.views.terraform-workspace`.',
      '4. Add a refresh command + register an EventEmitter for `onDidChangeTreeData`.',
      '5. Add an icon in `media/` if the view needs one in the activity bar.',
      '6. If activation blocks before this, the view shows "no data provider registered".',
    ].join('\n'),
  },
  {
    name: 'add-aws-service-client',
    body: [
      '# Playbook: add-aws-service-client',
      '',
      'Add a wrapper for a new AWS service.',
      '',
      '## Steps',
      '1. Mirror the style of `src/services/Telemetry.ts` (or another existing service).',
      '2. Use AWS SDK v3 modular packages (`@aws-sdk/client-<service>`).',
      '3. Construct the client lazily and cache it on the instance — do not construct at module top level.',
      '4. Catch credential errors and surface a useful message ("Run `aws sso login` or check OIDC trust").',
      '5. If the call returns a paginated response, walk it (most v3 clients have a `paginate*` helper).',
      '6. No long-lived AWS keys anywhere — assume OIDC or local SSO credentials only.',
    ].join('\n'),
  },
  {
    name: 'scaffold-new-chat-command',
    body: [
      '# Playbook: scaffold-new-chat-command',
      '',
      'Add a new `/command` to @dave.',
      '',
      '## Steps',
      '1. Add a `case \'<name>\': return DaveChatParticipant.handle<Name>(...)` in the switch in `handleRequest`.',
      '2. Implement the static method below the existing handlers, mirroring handleDigest / handleDone shape.',
      '3. Add an entry to `package.json` `contributes.chatParticipants[terraform.dave].commands` so it appears in autocomplete.',
      '4. If the command writes to memory, use `memory.recordOnce(...)` if it might be invoked repeatedly with the same input.',
      '5. Stream output with `stream.markdown(...)`; never throw out of a handler — wrap with try/catch and emit a friendly error.',
      '6. No new chat participants. New conversational surfaces are always commands on @dave.',
    ].join('\n'),
  },
  {
    name: 'bootstrap-new-workspace',
    body: [
      '# Playbook: bootstrap-new-workspace',
      '',
      'Set up a brand new Terraform repo to be managed by this extension.',
      '',
      '## Steps',
      '1. Run `@terraform scaffold a new repo from {org}/template-aws-module called terraform-aws-<thing> in {org}` — calls `terraform_scaffold_from_template`.',
      '2. Clone & open the new repo in VS Code.',
      '3. `Terraform: Configure Workspace` → declare environments. Save.',
      '4. `terraform_scaffold_oidc_trust` → generate the IAM trust policy JSON. Apply via your AWS bootstrap process.',
      '5. `terraform_scaffold_backend` → generate S3+DynamoDB backend HCL. Commit as `backend.tf`.',
      '6. `@terraform plan dev` → first plan. Watch the run URL.',
      '7. Iterate. `autoSyncWorkflows` regenerates workflow YAML on config changes.',
    ].join('\n'),
  },
  {
    name: 'diagnose-403',
    body: [
      '# Playbook: diagnose-403',
      '',
      'A GitHub API call returned 403.',
      '',
      '## Steps',
      '1. Run `Terraform: Diagnose GitHub Auth Scopes`. It probes each API surface individually so you see WHICH scope/SSO grant is missing.',
      '2. Required scopes: `repo`, `read:org`, `workflow`. Plus `admin:org` for some org-level secret/var calls.',
      '3. If scope is fine but call still 403s on an org repo: SAML/SSO grant is probably required. Visit the token settings page in GitHub and authorize the token for the org.',
      '4. If diagnose says "all_good" but the call still 403s: file an issue. That is a real bug.',
    ].join('\n'),
  },
  {
    name: 'failed-plan-triage',
    body: [
      '# Playbook: failed-plan-triage',
      '',
      'A plan workflow run failed. Triage and decide next step.',
      '',
      '## Steps',
      '1. Open the run logs (Run Logs context menu on the run, or `terraform.openRunLogs`).',
      '2. Look for the actual `tofu plan` / `terraform plan` step output — the workflow may have failed before reaching it (auth, init, lint).',
      '3. If it is an auth/OIDC failure: re-run `terraform_scaffold_oidc_trust`, verify the trust policy matches `repo:org/repo:environment:name`.',
      '4. If it is an init failure on backend: the S3 bucket / DynamoDB table is wrong or the IAM role lacks s3:* on it.',
      '5. If it is a real plan diff problem: search prior art with `terraform_search_tf_code` before writing new HCL.',
      '6. Mark the failure resolved with `@dave /done <id> <one-line-resolution>` so it stops appearing in `/digest`.',
    ].join('\n'),
  },
  {
    name: 'add-new-environment-to-workspace',
    body: [
      '# Playbook: add-new-environment-to-workspace',
      '',
      'Add a new environment (e.g. `staging`) to an existing Terraform workspace.',
      '',
      '## Steps',
      '1. `Terraform: Configure Workspace` → add the new environment to `environments[]` (or `workspaces[]` for flat repos). Save.',
      '2. Workflow YAML regenerates automatically (autoSyncWorkflows). Verify with `Terraform: Lint Workflows`.',
      '3. Update OIDC trust policy to include `repo:org/repo:environment:<newEnv>` — re-run `terraform_scaffold_oidc_trust` and re-apply on AWS.',
      '4. Add required variables/secrets via `Terraform: Add Variable` and `Terraform: Add Secret` (NOT chat — keep secrets on-device).',
      '5. `Required Setup` tree view will show what is still missing for the new env.',
      '6. First plan: `@terraform plan <newEnv>`.',
    ].join('\n'),
  },
  {
    name: 'morning-routine',
    body: [
      '# Playbook: morning-routine',
      '',
      'Start of work day. Get context loaded before doing anything.',
      '',
      '## Steps',
      '1. `@dave /digest` — see open todos, recent failures, unrated playbooks, inbox PRs.',
      '2. Triage: `@dave /done <id> [resolution]` for anything already handled, or capture as a real task in your tracker.',
      '3. Skim the top auto-trusted playbooks — these are your repeatable wins.',
      '4. If you decided something yesterday, capture it: `@dave /decide <slug> | <reasoning>`.',
      '5. State today\'s primary task in plain English to @dave; let the playbook matcher suggest what fits.',
    ].join('\n'),
  },
];

const FACTS: SeedFact[] = [
  {
    topic: 'user:preferences',
    key: 'identity',
    content:
      'User is Dave Arnold (djaboxx on GitHub, HappyPathway org). AI-first engineer. Half of IRON STATIC duo (github.com/djaboxx/iron-static). ' +
      'Treats AI as a true partner, not a tool — the Dave persona is named after them as a deliberate "shared brain" pattern.',
  },
  {
    topic: 'user:preferences',
    key: 'directness',
    content:
      'Prefers brief, direct answers. Skip preamble. Honest disagreement over hedged agreement. ' +
      'When pushed on a scope-discipline boundary, hold the line — that is what was asked for.',
  },
  {
    topic: 'user:preferences',
    key: 'work-style',
    content:
      'Works in long focused sessions. Wants AI to remember between sessions (hence AgentMemory). ' +
      'Will rate playbooks honestly — earn auto-trusted (👍≥5 👎0) and you get to skip the confirmation handshake.',
  },
];

export interface SeedReport {
  decisionsAdded: number;
  decisionsSkipped: number;
  playbooksAdded: number;
  playbooksSkipped: number;
  factsAdded: number;
  factsSkipped: number;
}

export function seedAgentMemory(memory: AgentMemory): SeedReport {
  const report: SeedReport = {
    decisionsAdded: 0,
    decisionsSkipped: 0,
    playbooksAdded: 0,
    playbooksSkipped: 0,
    factsAdded: 0,
    factsSkipped: 0,
  };

  for (const d of DECISIONS) {
    const dedupKey = `seed:decision:${d.slug}`;
    const existed = memory.hasDedupKey(dedupKey);
    memory.recordOnce(`decision:${d.slug}`, 'decision', d.content, dedupKey, { slug: d.slug, source: 'seed' });
    if (existed) report.decisionsSkipped++;
    else report.decisionsAdded++;
  }

  for (const p of PLAYBOOKS) {
    const dedupKey = `seed:playbook:${p.name}`;
    const existed = memory.hasDedupKey(dedupKey);
    memory.recordOnce(`playbook:${p.name}`, 'fact', p.body, dedupKey, { playbook: p.name, source: 'seed' });
    if (existed) report.playbooksSkipped++;
    else report.playbooksAdded++;
  }

  for (const f of FACTS) {
    const dedupKey = `seed:fact:${f.topic}:${f.key}`;
    const existed = memory.hasDedupKey(dedupKey);
    memory.recordOnce(f.topic, 'fact', f.content, dedupKey, { source: 'seed', key: f.key });
    if (existed) report.factsSkipped++;
    else report.factsAdded++;
  }

  return report;
}
