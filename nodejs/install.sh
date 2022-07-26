#!/usr/bin/env zsh

set -euf

if [[ ! -d ~/.nvm ]]; then
    mkdir ~/.nvm
fi

nvm install node --latest-npm
