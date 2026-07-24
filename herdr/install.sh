#!/usr/bin/env zsh
#
# Install herdr plugins.
#
# herdr has no declarative manifest for installed plugins, so this script
# installs the relevant set idempotently — anything already present is skipped.
# Keybindings for these live in config.toml. Each entry is "owner/repo <id>",
# where <id> is the plugin id from that repo's herdr-plugin.toml.
#
#   worktrunk         git worktree management via worktrunk
#   persiyanov.reviewr  code-review + diff sidebar for agents
#   herdr-file-viewer   git-aware read-only file viewer
#   herdr-navigator     fuzzy workspace / agent / session jumper

set -e

if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr not found; skipping plugin install" >&2
  exit 0
fi

plugins=(
  "devashish2203/herdr-worktrunk worktrunk"
  "persiyanov/herdr-reviewr persiyanov.reviewr"
  "smarzban/herdr-file-viewer herdr-file-viewer"
  "thanhdat77/herdr-navigator herdr-navigator"
)

installed="$(herdr plugin list --json 2>/dev/null || true)"

for entry in "${plugins[@]}"; do
  repo="${entry%% *}"
  id="${entry##* }"
  # Match the JSON-quoted id so one id can't substring-match another
  # (e.g. herdr-file-viewer inside a herdr-file-viewer-extended).
  if print -r -- "$installed" | grep -qF -- "\"${id}\""; then
    echo "✓ ${id} already installed"
    continue
  fi
  echo "› herdr plugin install ${repo}"
  herdr plugin install "${repo}" --yes
done
