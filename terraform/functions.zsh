#!/usr/bin/env bash

tfiles () {
  dir="."
  if [ "$#" -gt 0 ]; then
    dir="$1"
  fi

  touch "$dir"/{main,variables,outputs}.tf
}