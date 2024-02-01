#!/usr/bin/env bash

if ! asdf plugin list --urls | grep github.com/asdf-vm/asdf-golang ; then
  asdf plugin add golang https://github.com/asdf-vm/asdf-golang.git
else
  asdf plugin update golang
fi

asdf install golang

while read -r package; do
  go install "$package@latest"
done < "$(dirname "$0")/packages"
