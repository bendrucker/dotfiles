#!/usr/bin/env zsh

set -e

sudo mkdir -p /usr/local/n
sudo chown -R "$(whoami)" /usr/local/n

n latest

[ -f "$HOME/.npmrc" ] || [ -n "$CI" ] || (echo 'npm login:' && npm login)
