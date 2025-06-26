#!/usr/bin/env bash

shopt -s extglob

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if [ -z "$CI" ]; then
  sudo softwareupdate -i -a
fi

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done