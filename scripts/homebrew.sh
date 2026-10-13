#!/bin/sh
#
# Homebrew
#
# This installs some of the common dependencies needed (or at least desired)
# using Homebrew.

. "$(dirname "$0")/shell/brew-path.sh"

# Check for Homebrew
if test ! "$(command -v brew)"
then
  echo "  Installing Homebrew for you."

  # Install the correct homebrew for each OS type
  if test "$(uname)" = "Darwin"
  then
    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi

fi
brew_path

# install gum early so dotfiles-bootstrap helpers can use it before scripts/install runs brew bundle,
# and mise, which runs brew bundle
for tool in gum mise
do
  command -v "$tool" >/dev/null || brew install "$tool"
done

exit 0
