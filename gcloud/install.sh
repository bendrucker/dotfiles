#!/usr/bin/env bash
#
# Update the gcloud CLI's own components. Homebrew only tracks the gcloud-cli
# cask version. Components (kubectl, alpha, beta, etc.) are gcloud's own
# package manager, and brew upgrade never touches them.
set -e

command -v gcloud >/dev/null 2>&1 || exit 0

gcloud components update --quiet
