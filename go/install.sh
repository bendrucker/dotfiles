#!/usr/bin/env bash

while read -r package; do
  go install "$package@latest"
done < "$(dirname "$0")/packages"
