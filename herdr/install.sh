#!/usr/bin/env zsh
#
# Install and update herdr, and converge herdr's plugins onto plugins.list.
#
# herdr has no declarative manifest of its own, so herdr-lazy supplies one and
# installs the rest from it. That leaves herdr-lazy the one plugin this script
# still has to install by hand. Keybindings for all of them live in config.toml.

set -e

cd "${0:A:h}"

# Only herdr's own installer supports `herdr update --handoff`.
export HERDR_INSTALL_DIR="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"
herdr_bin="$HERDR_INSTALL_DIR/herdr"

if [[ ! -x "$herdr_bin" ]]; then
  echo "› installing herdr to $HERDR_INSTALL_DIR"
  curl --fail --silent --show-error --location https://herdr.dev/install.sh | sh ||
    echo "✗ herdr install failed" >&2
fi

if [[ ! -x "$herdr_bin" ]]; then
  echo "herdr not installed; skipping update and plugin install" >&2
  exit 0
fi

# herdr refuses to update from inside its own panes. Closed stdin keeps it from
# stopping a server it can't hand off. launchd would restart a handed-off server.
# EXPIRES: 2027-01-22 every machine's herdr server has left launchd
if [[ -n "${CI:-}" ]]; then
  :
elif [[ "${HERDR_ENV:-}" == 1 ]]; then
  echo "inside herdr; leaving herdr update --handoff to the nightly upgrade" >&2
elif [[ "$(uname -s)" == Darwin ]] && launchctl print "gui/$UID/me.bendrucker.herdr" 2>/dev/null | grep -qE '^[[:space:]]*pid = '; then
  echo "✗ the herdr server still runs under launchd. Skipping herdr update. See herdr/README.md" >&2
else
  "$herdr_bin" update --handoff </dev/null || echo "✗ herdr update --handoff did not finish" >&2
fi

# Read the list from this repo rather than herdr's plugin config dir, so the
# declaration is the one under version control. herdr-lazy writes plugins.lock
# alongside it, which .gitignore drops.
export HERDR_LAZY_LIST="$PWD/plugins.list"

lazy_repo=natori-hrj/herdr-lazy

# shellcheck source=../scripts/shell/git-sync.sh
source ../scripts/shell/git-sync.sh

# herdr clones every plugin from https://github.com/<owner>/<repo>, which an
# org's insteadOf rule can send back to SSH, and SSH cannot sign while the Mac
# is locked.
github_repos=(${(f)"$(grep -vE '^[[:space:]]*(#|$)' plugins.list | sed -E 's/^[[:space:]]+//; s/[@[:space:]].*//' | cut -d/ -f1,2 | sort -u)"})
over_https() {
  (git_https_env "${github_repos[@]}" && "$@")
}

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
  over_https herdr plugin install "$lazy_repo" --yes || true
  root=$(lazy_root)
fi

# herdr-lazy is not on PATH: its directory name carries an install-specific
# hash, so the path has to come back from herdr.
lazy="$root/target/release/herdr-lazy"
if [[ -z "$root" || ! -x "$lazy" ]]; then
  echo "✗ ${lazy_repo} is not installed; leaving herdr plugins as they are" >&2
  exit 0
fi

# sync counts an unpinned entry as satisfied by whatever commit is installed, so
# update is the only thing that moves one forward, and the nightly upgrade is
# where that happens. It reinstalls every unpinned entry, missing ones included,
# which is why it comes first: sync then has only pinned entries left to place,
# instead of installing everything a second time.
#
# CI restores the plugins from a cache keyed on plugins.list and leaves moving
# them to the nightly upgrade, since update would reinstall every one of them.
if [[ -z "${CI:-}" ]]; then
  over_https "$lazy" update || echo "✗ herdr-lazy update did not run; plugins may be stale" >&2
fi

# Pinned entries, which update skips, plus anything sitting at the wrong commit.
# --prune makes the list authoritative in both directions, so dropping an entry
# uninstalls the plugin instead of leaving it behind. It removes only a github
# plugin whose owner/repo no entry claims, and reports rather than removes
# anything else: a local link, herdr-lazy itself, and a plugin whose id matches
# an entry its source does not confirm.
over_https "$lazy" sync --prune || echo "✗ herdr-lazy sync did not run; plugins may be missing or unlisted" >&2

# With this on, a plugin added to the list later installs on the next herdr
# start instead of waiting for someone to re-run this script.
"$lazy" auto-sync on || echo "✗ could not turn on auto-sync" >&2

exit 0
