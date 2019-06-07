#!/usr/bin/env sh

version="$(rbenv install -l | grep -v - | tail -1 | tr -d " ")"
rbenv install "$version"
rbenv global "$version"

gem install travis
