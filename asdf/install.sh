#!/usr/bin/env bash

set -ef -o pipefail

# Read the desired plugins from .tool-versions into an array
# Handle missing trailing newline
desired=()
while IFS= read -r line || [ "$line" ]; do
  desired+=("${line%% *}")
done < .tool-versions

# Read the actual installed plugins into an array
installed=()
while IFS= read -r line; do
  installed+=("${line}")
done < <(asdf plugin list)

# Diff the arrays to find any missing plugins
missing=()
for plugin in "${desired[@]}"; do
  if [[ ! " ${installed[*]} " =~ ${plugin} ]]; then
    missing+=("$plugin")
  fi
done

# Print desired, installed stderr
{
  echo "Desired plugins: ${desired[*]}"
  echo "Installed plugins: ${installed[*]}"
} >&2

# Install any missing plugins
if [ ${#missing[@]} -eq 0 ]; then
  echo "All plugins are installed" >&2
else
  echo "Installing missing plugins: ${missing[*]}" >&2

  for plugin in "${missing[@]}"; do
    asdf plugin add "$plugin"
  done
fi

# Update all plugins
asdf plugin update --all

# Install
asdf install

# Reshim in case any installs were restored from cache
asdf reshim
