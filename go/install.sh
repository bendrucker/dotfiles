#!/usr/bin/env bash

packages=()
while read -r package; do
  packages+=("$package")
done < "$(dirname "$0")/packages"

echo "installing go packages:"
printf '%s\n' "${packages[@]}"

go get -u "${packages[@]}"
