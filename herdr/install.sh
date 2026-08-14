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

# Detection rules herdr's own agent manifests are missing, composed onto
# whatever it last fetched. See herdr/agent-detection. This runs ahead of the
# plugin work because it does not depend on it, and every exit below is a
# plugin problem that must not take the detection rules down with it.
"$PWD/../bin/herdr-agent-detection" sync ||
  echo "✗ could not install herdr agent detection overlays" >&2

# Read the list from this repo rather than herdr's plugin config dir, so the
# declaration is the one under version control. herdr-lazy writes plugins.lock
# alongside it, which .gitignore drops.
export HERDR_LAZY_LIST="$PWD/plugins.list"

lazy_repo=natori-hrj/herdr-lazy

# This script installs herdr-lazy by hand, so nothing below would notice its
# absence from the list. `update` only moves what the list names, which would
# leave it as the one plugin frozen at whatever commit first got installed.
if ! grep -qE "^${lazy_repo}(@|\$)" plugins.list; then
  echo "plugins.list: ${lazy_repo} is missing; it would never be updated" >&2
  exit 1
fi

# Empty rather than failing when herdr has nothing to say, so a bad response
# reads as "not installed" instead of aborting the whole dotfiles install.
lazy_root() {
  herdr plugin list --json 2>/dev/null |
    jq -r '.result.plugins[]? | select(.plugin_id == "herdr-lazy") | .plugin_root' 2>/dev/null ||
    true
}

root=$(lazy_root)
if [[ -z "$root" ]]; then
  echo "› herdr plugin install ${lazy_repo}"
  # Keep a flaky third-party build from aborting the rest under `set -e`.
  herdr plugin install "$lazy_repo" --yes || true
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

# sync only installs what is absent, and an unpinned entry is satisfied by any
# commit, so without this every plugin would sit at whatever it first installed.
# This is the only thing that moves them, and the nightly upgrade runs it.
"$lazy" update || echo "✗ herdr-lazy update did not finish; some plugins may be stale" >&2

# With this on, a plugin added to the list later installs on the next herdr
# start instead of waiting for someone to re-run this script.
"$lazy" auto-sync on || echo "✗ could not turn on auto-sync" >&2
