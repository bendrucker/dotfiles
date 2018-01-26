#!/usr/bin/env sh

# print project contributors by name

contributors () {
  git shortlog -s -n
}
