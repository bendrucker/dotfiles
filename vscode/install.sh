#!/usr/bin/env zsh

xargs -L 1 code --install-extension < "${0:a:h}/extensions.txt"