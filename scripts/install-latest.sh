#!/usr/bin/env bash
# install-latest.sh — download and install the latest terraform-workspace .vsix
#
# Usage:
#   ./scripts/install-latest.sh              # installs latest release tag
#   ./scripts/install-latest.sh --pre        # installs latest branch build (no tag required)
#
# Requirements: gh CLI authenticated to the repo's GitHub host

set -euo pipefail

REPO="djaboxx/vscode-terraform-workspace"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mode="${1:-}"

if [[ "$mode" == "--pre" ]]; then
  echo "⬇  Downloading latest branch build artifact from $REPO …"
  # Download the most recent workflow artifact named 'terraform-workspace-latest'
  gh run download \
    --repo "$REPO" \
    --name "terraform-workspace-latest" \
    --dir "$TMPDIR" \
    "$(gh run list --repo "$REPO" --workflow release.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
else
  echo "⬇  Downloading latest release .vsix from $REPO …"
  gh release download \
    --repo "$REPO" \
    --pattern "*.vsix" \
    --dir "$TMPDIR"
fi

VSIX="$(ls "$TMPDIR"/*.vsix | head -1)"

if [[ -z "$VSIX" ]]; then
  echo "❌  No .vsix found. Check that a release or artifact exists."
  exit 1
fi

echo "📦  Installing $(basename "$VSIX") …"
code --install-extension "$VSIX" --force

echo "✅  Done. Reload VS Code to activate the updated extension."
