#!/usr/bin/env bash
#
# Update the gcloud CLI's own components. Homebrew only tracks the gcloud-cli
# cask version. Components (kubectl, alpha, beta, etc.) are gcloud's own
# package manager, and brew upgrade never touches them.
set -e

command -v gcloud >/dev/null 2>&1 || exit 0

# A failure here (no network, a rate limit, an interactive prompt this
# machine can't answer) must not abort the rest of scripts/install: find
# runs every topic install.sh under one set -e pipeline, and gcloud sorts
# ahead of most other topics alphabetically.
gcloud components update --quiet || echo "gcloud components update failed; will retry next run" >&2
