#!/bin/bash
#
# Turns a bare ubuntu:24.04 container into what the CI Linux runner starts
# from: a sudoer named runner, zsh, and Homebrew under /home/linuxbrew.
# Homebrew refuses to run as root, which is why the install runs as runner.
#
# Usage (as root): ubuntu.sh

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update --quiet
apt-get install --yes --quiet --no-install-recommends \
  build-essential ca-certificates curl file git locales openssh-client procps sudo zsh
# The runner image has it, and postgresql's initdb fails without it.
locale-gen en_US.UTF-8

id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
echo 'runner ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/runner
# The Homebrew cache volume is mounted before the user exists, so its parents
# arrive owned by root.
chown -R runner: /home/runner

if [ ! -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  sudo -u runner --set-home NONINTERACTIVE=1 \
    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
