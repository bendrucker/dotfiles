#!/usr/bin/env bash

if [ -z "$CI" ]; then
  sudo softwareupdate -i -a
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done