#!/bin/bash
#
# Points the guest's checkouts at the commit under test. scripts/setup clones
# ~/.dotfiles from the origin of the checkout it runs from, so a bare seed
# whose main is that commit stands in for GitHub. A second call with a newer
# commit moves both checkouts forward, which is what an upgrade run tests.
#
# Usage: seed.sh <shared git dir> <commit>

set -euo pipefail

share=$1
commit=$2
seed=$HOME/dotfiles.git
dev=$HOME/src/dotfiles

# A local clone copies the whole object store, so a commit no branch points at
# still arrives. The share belongs to the host's user, which git refuses. The
# upload-pack the clone spawns drops -c settings, so the exception goes in a
# global config of its own, leaving the guest's for the installer to manage.
trust=$(mktemp)
git config --file "$trust" safe.directory '*'
rm -rf "$seed"
GIT_CONFIG_GLOBAL=$trust git clone --bare --quiet "$share" "$seed"
rm -f "$trust"
git -C "$seed" update-ref refs/heads/main "$commit"
git -C "$seed" symbolic-ref HEAD refs/heads/main

for checkout in "$dev" "$HOME/.dotfiles"; do
  [ -d "$checkout/.git" ] || continue
  git -C "$checkout" fetch --quiet origin
  git -C "$checkout" checkout --quiet --force -B main origin/main
done

[ -d "$dev/.git" ] || git clone --quiet "$seed" "$dev"
git -C "$dev" log -1 --format='seeded %h %s'
