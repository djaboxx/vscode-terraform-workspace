# Testing & CI

This repo runs three layers of automated checks. All run in CI on every PR; all are runnable locally with the commands listed below.

## Layers

| Layer | Runner | Where | What it covers |
| --- | --- | --- | --- |
| **Unit** | Vitest | `test/unit/**/*.test.ts` | Pure-logic modules: scaffolders, parsers, schemas, agents. The `vscode` module is stubbed via [`test/unit/vscode.stub.ts`](../test/unit/vscode.stub.ts) so logic-only code runs without an extension host. |
| **VS Code integration** | `@vscode/test-electron` | `test/vscode/suite/**` | End-to-end activation, command registration, chat participant wiring. Spins up a real VS Code instance — slow, run on demand. |
| **Schema parity** | Vitest | [`test/unit/toolSchemaParity.test.ts`](../test/unit/toolSchemaParity.test.ts) | Asserts that every `languageModelTools[]` entry in `package.json` has a matching AJV schema in `src/schemas/toolInputs.ts`. Failures here mean an LM tool is declared without runtime validation. |

## Local commands

```bash
npm test                  # all unit tests, default reporter
npm run test:watch        # vitest watch mode (great for TDD)
npm run test:vscode       # full VS Code integration suite (slow)
npm run coverage          # unit tests + v8 coverage report
npm run coverage:open     # open the HTML coverage report in a browser
npm run lint              # eslint
npm run compile           # tsc --noEmit (type-check only)
```

`npm run coverage` writes:
- `coverage/index.html` — drill-down per file/function. Open with `npm run coverage:open`.
- `coverage/lcov.info` — for editor extensions like Coverage Gutters.
- `coverage/coverage-summary.json` — machine-readable, used by CI for the PR comment.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push + PR:

1. `npm ci --ignore-scripts`
2. `npm run lint`
3. `npm run compile`
4. `npm run coverage` — with `CI=true` so Vitest emits:
   - `coverage/junit.xml` (uploaded as a check run via `dorny/test-reporter`)
   - GitHub Actions annotations for each failure (so they show inline in the PR diff)
5. Coverage HTML + lcov uploaded as the `coverage-<sha>` artifact (14-day retention).
6. Coverage summary printed to `$GITHUB_STEP_SUMMARY` so the run page shows a table without downloading the artifact.
7. `npm run build` — production esbuild bundle.

## Diagnosing a failed CI run

| Symptom | Where to look |
| --- | --- |
| Red ❌ on a test | The PR's **Checks → Vitest** tab shows JUnit-parsed failures with file/line links. Stack traces are in the job log. |
| `Tools declared in package.json with no TS schema` | Add the matching schema to [`src/schemas/toolInputs.ts`](../src/schemas/toolInputs.ts) and register it in `TOOL_SCHEMAS` in [`test/unit/toolSchemaParity.test.ts`](../test/unit/toolSchemaParity.test.ts). |
| `Coverage for X does not meet global threshold` | Download the `coverage-<sha>` artifact, open `coverage/index.html`, find the regressed file, add a unit test. Or, if the regression is justified (e.g. you removed a test alongside dead code), lower the threshold in [`vitest.config.ts`](../vitest.config.ts). |
| Slow test warnings | Vitest highlights tests > 500 ms. Profile with `npm run test:watch` then `t` to filter. |
| `Type-check` failed but tests pass | `npm run compile` locally — same flags as CI. Pure type-only failure, not a runtime regression. |

## Coverage roadmap

Current baseline: ~37 % lines / ~36 % branches.  Goal: **70 % lines / 60 % branches.**

Thresholds in [`vitest.config.ts`](../vitest.config.ts) are set just below the current baseline so any regression fails CI. Ratchet them upward whenever a PR adds tests that bump coverage.

Highest-value untested modules (open these in `coverage/index.html` to start):

- [`src/codebuild/CodeBuildDispatcher.ts`](../src/codebuild/CodeBuildDispatcher.ts) — pure shell-out + parse logic
- [`src/lambda/LambdaImageDispatcher.ts`](../src/lambda/LambdaImageDispatcher.ts) — same shape; mostly testable
- [`src/runners/GheRunnersClient.ts`](../src/runners/GheRunnersClient.ts) — aws CLI + GitHub API; injectable
- [`src/cache/TerraformFileCache.ts`](../src/cache/TerraformFileCache.ts) — in-memory cache + LLM context
- [`src/config/WorkspaceConfigValidator.ts`](../src/config/WorkspaceConfigValidator.ts) — schema validation + diagnostics
- [`src/auth/GithubAuthProvider.ts`](../src/auth/GithubAuthProvider.ts) — retry + rate-limit logic

Excluded from coverage (intentionally — they need an extension host, not Vitest):
`src/extension.ts`, `src/services.ts`, `src/views/**`, `src/chat/TerraformChatParticipant.ts`, `src/agent/{ProactiveAgent,AgentRunner}.ts`, `src/tools/TerraformTools.ts`. These are exercised by `npm run test:vscode`.
