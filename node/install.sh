#!/usr/bin/env zsh

set -e

sudo mkdir -p /usr/local/n
sudo chown -R "$(whoami)" /usr/local/n
sudo chown -R "$(whoami)" /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share

n latest

[ -f "$HOME/.npmrc" ] || (echo 'npm login:' && npm login)
npm install --global $(cat "${0:a:h}/globals.txt" | tr '\n' ' ')

npm config set package-lock false
