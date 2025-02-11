#!/usr/bin/env bash

echo $PATH

while read -r package; do
  go install "$package@latest"
done < "$(dirname "$0")/packages"
