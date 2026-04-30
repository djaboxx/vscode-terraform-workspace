# Plan — Python developer inner-loop for Lambda container images

Status: **Phase A in progress** (2026-04-30).
Owner: extension team.
Sibling plan: [`lambda-sc-pipeline.md`](./lambda-sc-pipeline.md) (L1 image / L3 SC product / L4 templater).

## Constraints

- **No local Docker.** The target environment cannot run `docker build` /
  `docker run`. All inner-loop tooling must work with a plain Python
  interpreter + pip. Image building still happens remotely via the existing
  `packer-pipeline` CodeBuild project (already implemented in
  `LambdaImageDispatcher`); local-invoke and tests run against a venv.

The Lambda image scaffolder (L1) drops a `src/handler.py` into the workspace
with no surrounding Python ergonomics. This plan closes the inner-loop gap so a
developer can scaffold → write code → test locally → ship → tail logs without
leaving VS Code.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **A** | Scaffold dev env • Local invoke (Docker RIE + Python fallback) • Tail logs | In progress |
| **B** | IAM-from-code static analysis (boto3 calls → `aws_iam_policy_document`) | Planned |
| **C** | Forward Pylance MCP tools into the `@terraform` chat participant when a `pyproject.toml` is detected in any `infra/lambda-image-*` dir | Planned |

## Phase A — design

### A1. Scaffold dev env (`Lambda: Scaffold Python Dev Environment…`)

For an existing `infra/lambda-image-<fn>/` dir, write (only-if-missing):

- `pyproject.toml` — pins `requires-python` to match the base image
  (`python:3.12` → `>=3.12,<3.13`); `[project.optional-dependencies] dev =
  ["pytest", "pytest-asyncio", "moto[lambda,s3]", "boto3", "boto3-stubs[essential]",
  "ruff", "mypy"]`; ruff + mypy config blocks.
- `tests/test_handler.py` — pytest with a `lambda_context` fixture and a
  `moto`-mocked happy-path example for the synthesized handler.
- `tests/conftest.py` — adds `src/` to `sys.path` so the handler is importable
  without a package layout.
- `tests/events/sample.json` — minimal event the local-invoke command can use.
- `.python-version` — for pyenv users.
- `.devcontainer/devcontainer.json` — `mcr.microsoft.com/devcontainers/python:3.12`
  with the AWS CLI feature.
- `Makefile` — `install`, `test`, `lint`, `typecheck`, `freeze` targets.
  `freeze` runs `pip-compile` to derive `src/requirements.txt` from
  `pyproject.toml` so the Packer `pip install -r requirements.txt` step is
  unchanged.
- `.vscode/launch.json` — "Local invoke" config that runs `scripts/local_invoke.py`
  under debugpy with `tests/events/sample.json`, plus a "pytest" config.
- `scripts/local_invoke.py` — stdlib-only driver that imports the dotted
  handler, builds a `LambdaContext`-shaped object, calls
  `handler(event, context)`, and prints the JSON result.

Pure functions live in `src/lambda/PythonDevScaffolder.ts`; the Tool/Command
wrappers are thin and write via `vscode.workspace.fs`.

### A2. Local invoke (`Lambda: Test Locally…`)

**Venv-only — no Docker dependency.**

1. Resolve interpreter: `python.defaultInterpreterPath` setting →
   `<project>/.venv/bin/python` → `python3` on PATH. Surface a clear error if
   none of these resolve.
2. Spawn that interpreter with `scripts/local_invoke.py --handler <dotted>
   --event <event.json>`. The driver synthesizes a `LambdaContext`-shaped
   namespace object and calls `handler(event, context)`.
3. Stream stdout/stderr + the JSON return value into the output channel.

UI flow: file picker for the event JSON (defaults to `tests/events/*.json`),
QuickPick of `infra/lambda-image-*` dirs if multiple, withProgress(cancellable
— cancellation kills the Python child process).

> Fidelity caveat: this runs against the host Python, not
> `public.ecr.aws/lambda/python:<ver>`. Catches handler logic bugs, missing
> deps, IAM-not-needed code paths. Does **not** catch glibc/musl mismatches or
> issues that only show up in the AL2-based Lambda runtime. The remote build
> via `Lambda: Build & Publish Image…` remains the source of truth for
> deploy-time correctness.

### A3. Tail logs (`Lambda: Tail Function Logs`)

Thin wrapper around `aws logs tail /aws/lambda/<fn> --follow --format short
--region <region>` with cancellation that kills the child process. Auto-detects
function name from the dir (`infra/lambda-image-<fn>` → `<fn>`); QuickPick if
ambiguous; manual entry as fallback. Streams into a dedicated output channel
named `Lambda Logs: <fn>` so multiple tails can run concurrently.

## Phase B — IAM-from-code (sketch)

Walk the handler module's AST, collect `boto3.client("…")` /
`boto3.resource("…")` literal arguments, map service → minimal-action
allowlist (e.g. `s3` → `s3:GetObject`/`PutObject`, `dynamodb` →
`dynamodb:GetItem`/`PutItem`/`Query`), emit
`data "aws_iam_policy_document" "fn_inferred"` + attach to the existing exec
role next to `AWSLambdaBasicExecutionRole`. Heuristic — doc the limitations
(non-literal args, dynamic dispatch) and leave the manual override path open.

## Phase C — Pylance MCP forwarding (sketch)

When `TerraformChatParticipant` constructs its tool list, additionally include
the deferred `mcp_pylance_*` tools if Pylance is installed AND a
`pyproject.toml` is present in any `infra/lambda-image-*` dir. Lets users ask
`@terraform why does my handler import boto3 fail typecheck?` and get a real
answer.

## Non-goals

- Generic Python project scaffolding not tied to a Lambda image dir
  (`uv init` / `cookiecutter` win there).
- Bundling `pip` / running `pip install` from the extension
  (Python ext + the Makefile `install` target handle this).
- A custom debugger UI (the scaffolded `launch.json` runs the local-invoke
  driver under debugpy — that's enough).
- Any reliance on local Docker. See *Constraints* above.
