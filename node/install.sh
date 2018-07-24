#!/usr/bin/env zsh

set -e

[ -f "$HOME/.npmrc" ] || (echo 'npm login:' && npm login)
npm install --global $(cat "${0:a:h}/globals.txt" | tr '\n' ' ')