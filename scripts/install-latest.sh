#!/usr/bin/env bash
# install-latest.sh — download and install the latest terraform-workspace .vsix
#
# Usage:
#   ./scripts/install-latest.sh              # installs latest release tag
#   ./scripts/install-latest.sh --pre        # installs latest branch build (no tag required)
#
# If the repo has multiple git remotes the script will prompt you to pick one.
# The gh --hostname flag is derived automatically from the chosen remote's URL.
#
# Requirements: gh CLI authenticated to the target host

set -euo pipefail

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

mode="${1:-}"

# ── Discover git remotes and let the user pick ─────────────────────────────────

# Collect unique remote names (fetch only, deduplicated)
mapfile -t REMOTE_NAMES < <(git remote)

if [[ ${#REMOTE_NAMES[@]} -eq 0 ]]; then
  echo "❌  No git remotes found. Run this script from inside the repo." >&2
  exit 1
fi

if [[ ${#REMOTE_NAMES[@]} -eq 1 ]]; then
  CHOSEN_REMOTE="${REMOTE_NAMES[0]}"
else
  echo "Multiple remotes found:"
  for i in "${!REMOTE_NAMES[@]}"; do
    url="$(git remote get-url "${REMOTE_NAMES[$i]}")"
    printf "  [%d] %s  (%s)\n" "$((i+1))" "${REMOTE_NAMES[$i]}" "$url"
  done
  printf "Pick a remote [1-%d]: " "${#REMOTE_NAMES[@]}"
  read -r choice
  idx=$(( choice - 1 ))
  if [[ $idx -lt 0 || $idx -ge ${#REMOTE_NAMES[@]} ]]; then
    echo "❌  Invalid choice." >&2
    exit 1
  fi
  CHOSEN_REMOTE="${REMOTE_NAMES[$idx]}"
fi

REMOTE_URL="$(git remote get-url "$CHOSEN_REMOTE")"
echo "→  Using remote: $CHOSEN_REMOTE  ($REMOTE_URL)"

# ── Derive hostname and OWNER/REPO from the remote URL ────────────────────────
# Handles:
#   https://github.com/owner/repo.git
#   https://github.example.com/owner/repo.git
#   git@github.example.com:owner/repo.git

if [[ "$REMOTE_URL" =~ ^https?://([^/]+)/([^/]+/[^/]+?)(\.git)?$ ]]; then
  GH_HOST="${BASH_REMATCH[1]}"
  REPO="${BASH_REMATCH[2]}"
elif [[ "$REMOTE_URL" =~ ^git@([^:]+):([^/]+/[^/]+?)(\.git)?$ ]]; then
  GH_HOST="${BASH_REMATCH[1]}"
  REPO="${BASH_REMATCH[2]}"
else
  echo "❌  Could not parse remote URL: $REMOTE_URL" >&2
  exit 1
fi

# gh treats github.com as the default; only pass --hostname for GHE instances
GH_HOST_FLAG=()
if [[ "$GH_HOST" != "github.com" ]]; then
  GH_HOST_FLAG=(--hostname "$GH_HOST")
fi

echo "→  Host: $GH_HOST  |  Repo: $REPO"

# ── Download ───────────────────────────────────────────────────────────────────

if [[ "$mode" == "--pre" ]]; then
  echo "⬇  Downloading latest branch build artifact …"
  RUN_ID="$(gh run list "${GH_HOST_FLAG[@]}" \
    --repo "$REPO" \
    --workflow release.yml \
    --branch main \
    --status success \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')"

  if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
    echo "❌  No successful release workflow run found on main." >&2
    exit 1
  fi

  gh run download "${GH_HOST_FLAG[@]}" \
    --repo "$REPO" \
    --name "terraform-workspace-latest" \
    --dir "$TMPDIR_WORK" \
    "$RUN_ID"
else
  echo "⬇  Downloading latest release .vsix …"
  gh release download "${GH_HOST_FLAG[@]}" \
    --repo "$REPO" \
    --pattern "*.vsix" \
    --dir "$TMPDIR_WORK"
fi

# ── Install ────────────────────────────────────────────────────────────────────

VSIX="$(ls "$TMPDIR_WORK"/*.vsix 2>/dev/null | head -1)"

if [[ -z "$VSIX" ]]; then
  echo "❌  No .vsix found. Check that a release or artifact exists." >&2
  exit 1
fi

echo "📦  Installing $(basename "$VSIX") …"
code --install-extension "$VSIX" --force

echo "✅  Done. Reload VS Code to activate the updated extension."
