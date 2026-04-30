/**
 * Generators for the Python developer inner-loop layered onto an existing
 * `infra/lambda-image-<fn>/` directory produced by `LambdaImageScaffolder`.
 *
 * Pure string generation — no I/O. Caller writes files (only-if-missing) via
 * `vscode.workspace.fs`.
 */

export interface PythonDevScaffoldInputs {
  /** Logical function name (matches the lambda image dir suffix). */
  functionName: string;
  /** Python version to pin, e.g. "3.12". Derived from the Lambda base image. */
  pythonVersion: string;
  /** Handler dotted path, e.g. "handler.lambda_handler". Used by the test event + sample. */
  handler: string;
  /** AWS region — only baked into the devcontainer post-create env. */
  region?: string;
}

const DEFAULT_PYTHON_VERSION = '3.12';

function pyVersion(inputs: PythonDevScaffoldInputs): string {
  return inputs.pythonVersion || DEFAULT_PYTHON_VERSION;
}

function pyVersionUpperBound(version: string): string {
  // "3.12" → "3.13" so requires-python = ">=3.12,<3.13"
  const [major, minor] = version.split('.').map(Number);
  if (Number.isFinite(major) && Number.isFinite(minor)) {
    return `${major}.${minor + 1}`;
  }
  return version;
}

export function pythonPyprojectToml(inputs: PythonDevScaffoldInputs): string {
  const py = pyVersion(inputs);
  const upper = pyVersionUpperBound(py);
  return `[project]
name = "${inputs.functionName}"
version = "0.1.0"
description = "AWS Lambda function: ${inputs.functionName}"
requires-python = ">=${py},<${upper}"
dependencies = []

[project.optional-dependencies]
dev = [
  "pytest>=8",
  "pytest-asyncio>=0.23",
  "moto[lambda,s3,dynamodb]>=5",
  "boto3>=1.34",
  "boto3-stubs[essential]>=1.34",
  "ruff>=0.5",
  "mypy>=1.10",
  "pip-tools>=7",
]

[tool.ruff]
line-length = 100
target-version = "py${py.replace('.', '')}"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "N", "S"]
ignore = ["S101"]  # allow assert in tests

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S"]

[tool.mypy]
python_version = "${py}"
strict = true
warn_unused_ignores = true
mypy_path = "src"

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra -q"
`;
}

export function pythonConftest(): string {
  return `"""Make src/ importable from tests/ without packaging the handler."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class _LambdaContext:
    function_name = "local"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:us-east-1:000000000000:function:local"
    memory_limit_in_mb = 512
    aws_request_id = "00000000-0000-0000-0000-000000000000"
    log_group_name = "/aws/lambda/local"
    log_stream_name = "local"

    def get_remaining_time_in_millis(self) -> int:
        return 30_000


@pytest.fixture()
def lambda_context() -> _LambdaContext:
    return _LambdaContext()
`;
}

export function pythonTestHandler(inputs: PythonDevScaffoldInputs): string {
  const [moduleName, funcName] = inputs.handler.includes('.')
    ? inputs.handler.split(/\.(.+)/)
    : ['handler', inputs.handler];
  return `"""Smoke test for ${inputs.functionName}.

Replace the body once your handler does real work. The fixture in
conftest.py provides a Lambda-context-shaped object.
"""
from __future__ import annotations

from ${moduleName} import ${funcName}


def test_handler_smoke(lambda_context) -> None:
    event = {"hello": "world"}
    result = ${funcName}(event, lambda_context)
    assert result is not None
`;
}

export function pythonSampleEvent(): string {
  return `{
  "hello": "world"
}
`;
}

export function pythonVersionFile(inputs: PythonDevScaffoldInputs): string {
  return `${pyVersion(inputs)}\n`;
}

export function pythonDevcontainer(inputs: PythonDevScaffoldInputs): string {
  const py = pyVersion(inputs);
  return `{
  "name": "${inputs.functionName}",
  "image": "mcr.microsoft.com/devcontainers/python:${py}",
  "features": {
    "ghcr.io/devcontainers/features/aws-cli:1": {}
  },
  "postCreateCommand": "pip install -e '.[dev]'",
  "customizations": {
    "vscode": {
      "extensions": [
        "ms-python.python",
        "ms-python.vscode-pylance",
        "charliermarsh.ruff",
        "hashicorp.terraform",
        "amazonwebservices.aws-toolkit-vscode"
      ],
      "settings": {
        "python.defaultInterpreterPath": "/usr/local/bin/python",
        "[python]": {
          "editor.defaultFormatter": "charliermarsh.ruff",
          "editor.formatOnSave": true
        }
      }
    }
  }${inputs.region ? `,\n  "remoteEnv": { "AWS_REGION": "${inputs.region}", "AWS_DEFAULT_REGION": "${inputs.region}" }` : ''}
}
`;
}

export function pythonMakefile(inputs: PythonDevScaffoldInputs): string {
  return `# ${inputs.functionName} — Lambda dev loop
PY ?= python
PIP ?= pip

.PHONY: install test lint typecheck freeze clean

install:
\t$(PIP) install -e '.[dev]'

test:
\tpytest

lint:
\truff check src tests
\truff format --check src tests

typecheck:
\tmypy src

freeze:
\tpip-compile --quiet --resolver=backtracking --output-file=src/requirements.txt pyproject.toml

clean:
\trm -rf .pytest_cache .ruff_cache .mypy_cache build dist *.egg-info
`;
}

export function pythonLaunchJson(inputs: PythonDevScaffoldInputs): string {
  return `{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Local invoke: ${inputs.functionName}",
      "type": "debugpy",
      "request": "launch",
      "program": "\${workspaceFolder}/scripts/local_invoke.py",
      "args": ["--handler", "${inputs.handler}", "--event", "tests/events/sample.json"],
      "cwd": "\${workspaceFolder}",
      "console": "integratedTerminal",
      "justMyCode": false
    },
    {
      "name": "pytest: ${inputs.functionName}",
      "type": "debugpy",
      "request": "launch",
      "module": "pytest",
      "args": ["-q"],
      "cwd": "\${workspaceFolder}",
      "console": "integratedTerminal"
    }
  ]
}
`;
}

/** Heuristic: pull the python tag out of `public.ecr.aws/lambda/python:3.12`-style refs. */
export function detectPythonVersionFromBaseImage(baseImage: string | undefined): string {
  if (!baseImage) return DEFAULT_PYTHON_VERSION;
  const m = baseImage.match(/python:(\d+\.\d+)/i);
  return m ? m[1] : DEFAULT_PYTHON_VERSION;
}

/**
 * Standalone driver script that imports a dotted handler and invokes it
 * against an event JSON file. Used by both `Lambda: Test Locally…` and the
 * scaffolded `launch.json` "Local invoke" debug configuration. Lives at
 * `scripts/local_invoke.py` inside the lambda image dir so a developer can
 * run it directly: `python scripts/local_invoke.py --handler handler.lambda_handler --event tests/events/sample.json`.
 *
 * Uses only the Python stdlib so it runs in any venv with the handler's
 * runtime deps installed.
 */
export function pythonLocalInvokeScript(): string {
  return `#!/usr/bin/env python
"""Invoke a Lambda handler locally without a container runtime.

Resolves SRC/ on sys.path, imports the dotted handler, builds a
LambdaContext-shaped object, calls handler(event, context), prints the
JSON-serialised result to stdout.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
import uuid
from pathlib import Path


class LambdaContext:
    def __init__(self, function_name: str, timeout_ms: int = 30_000) -> None:
        self.function_name = function_name
        self.function_version = "$LATEST"
        self.invoked_function_arn = (
            f"arn:aws:lambda:us-east-1:000000000000:function:{function_name}"
        )
        self.memory_limit_in_mb = 512
        self.aws_request_id = str(uuid.uuid4())
        self.log_group_name = f"/aws/lambda/{function_name}"
        self.log_stream_name = time.strftime("%Y/%m/%d/[$LATEST]") + uuid.uuid4().hex
        self._deadline = time.monotonic() + timeout_ms / 1000.0

    def get_remaining_time_in_millis(self) -> int:
        return max(0, int((self._deadline - time.monotonic()) * 1000))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--handler", required=True, help="dotted handler, e.g. handler.lambda_handler")
    parser.add_argument("--event", required=True, help="path to a JSON event file")
    parser.add_argument("--src", default="src", help="directory holding the handler module (default: src)")
    parser.add_argument("--function-name", default="local")
    args = parser.parse_args()

    src = Path(args.src).resolve()
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))

    module_name, _, func_name = args.handler.rpartition(".")
    if not module_name or not func_name:
        print(f"--handler must be dotted, got: {args.handler}", file=sys.stderr)
        return 2

    event_path = Path(args.event)
    if not event_path.exists():
        print(f"event file not found: {event_path}", file=sys.stderr)
        return 2
    event = json.loads(event_path.read_text(encoding="utf-8"))

    module = importlib.import_module(module_name)
    handler = getattr(module, func_name, None)
    if handler is None:
        print(f"{module_name} has no attribute {func_name}", file=sys.stderr)
        return 2

    ctx = LambdaContext(args.function_name)
    started = time.perf_counter()
    try:
        result = handler(event, ctx)
    except Exception as exc:  # noqa: BLE001 — Lambda runtime catches all
        elapsed_ms = (time.perf_counter() - started) * 1000
        print(f"\\nHANDLER RAISED after {elapsed_ms:.1f}ms: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise

    elapsed_ms = (time.perf_counter() - started) * 1000
    print(f"\\nHANDLER OK in {elapsed_ms:.1f}ms")
    try:
        print(json.dumps(result, indent=2, default=str))
    except (TypeError, ValueError):
        print(repr(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
