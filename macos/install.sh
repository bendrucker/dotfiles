#!/usr/bin/env bash

sudo softwareupdate -i -a

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done
