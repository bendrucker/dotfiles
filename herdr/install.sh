#!/usr/bin/env zsh
#
# Converge herdr's plugins onto plugins.list.
#
# herdr has no declarative manifest of its own, so herdr-lazy supplies one and
# installs the rest from it. That leaves herdr-lazy the one plugin this script
# still has to install by hand. Keybindings for all of them live in config.toml.

set -e

cd "${0:A:h}"

if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr not found; skipping plugin install" >&2
  exit 0
fi

# Read the list from this repo rather than herdr's plugin config dir, so the
# declaration is the one under version control. herdr-lazy writes plugins.lock
# alongside it, which .gitignore drops.
export HERDR_LAZY_LIST="$PWD/plugins.list"

lazy_repo=natori-hrj/herdr-lazy

# Take the bootstrap ref from the list itself. A second copy of the SHA here
# would disagree with it the first time Renovate bumps one of them.
lazy_ref=$(sed -n "s|^${lazy_repo}@||p" plugins.list | head -1)
if [[ -z "$lazy_ref" ]]; then
  echo "plugins.list: ${lazy_repo} is missing or unpinned; nothing to bootstrap from" >&2
  exit 1
fi

lazy_root() {
  herdr plugin list --json 2>/dev/null |
    jq -r '.result.plugins[]? | select(.plugin_id == "herdr-lazy") | .plugin_root'
}

root=$(lazy_root)
if [[ -z "$root" ]]; then
  echo "› herdr plugin install ${lazy_repo}@${lazy_ref}"
  # Keep a flaky third-party build from aborting the rest under `set -e`.
  herdr plugin install "$lazy_repo" --ref "$lazy_ref" --yes || true
  root=$(lazy_root)
fi

# herdr-lazy is not on PATH: its directory name carries an install-specific
# hash, so the path has to come back from herdr.
lazy="$root/target/release/herdr-lazy"
if [[ -z "$root" || ! -x "$lazy" ]]; then
  echo "✗ ${lazy_repo} is not installed; leaving herdr plugins as they are" >&2
  exit 0
fi

"$lazy" sync || echo "✗ herdr-lazy sync did not finish; some plugins may be missing" >&2

# With this on, a plugin added to the list later installs on the next herdr
# start instead of waiting for someone to re-run this script.
"$lazy" auto-sync on
