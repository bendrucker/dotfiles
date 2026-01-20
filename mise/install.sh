#!/usr/bin/env zsh
#
# Install mise tools and activate shims for subsequent installers.

set -e

cd "$(dirname "$0")"/..

# Symlink all topic mise.toml files to conf.d
echo "› mise config"
MISE_CONFIG="$HOME/.config/mise"
CONF_D="$MISE_CONFIG/conf.d"
mkdir -p "$CONF_D"

# Remove old central config symlink (replaced by conf.d)
rm -f "$MISE_CONFIG/config.toml"

# Remove stale symlinks (topics that no longer exist)
for link in "$CONF_D"/*.toml(N); do
  [ -L "$link" ] || continue
  [[ "$(readlink "$link")" == "$PWD/"* ]] || continue
  [ -e "$link" ] || rm "$link"
done

for file in */mise.toml; do
  [ -f "$file" ] || continue
  topic="${file%/mise.toml}"
  ln -sf "$PWD/$file" "$CONF_D/$topic.toml"
  mise trust "$file" --yes 2>/dev/null
done

echo "› mise install"
mise install

# Activate mise shims so that installers can use any shell
eval "$(mise activate --shims)"
