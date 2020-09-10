#!/usr/bin/env sh

curl --silent --fail --location \
  --output ~/.local/share/nvim/site/autoload/plug.vim --create-dirs \
  https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

pip3 install --user pynvim

config="$HOME/.config/nvim/init.vim"
dir="$(dirname "$(readlink "$0")")"

if [ ! -f "$config" ]; then
  mkdir -p "$(dirname "$config")"
  ln --symbolic "$dir/init.vim" "$config"
fi