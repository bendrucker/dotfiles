# dotfiles [![Build Status](https://travis-ci.org/bendrucker/dotfiles.svg?branch=master)](https://travis-ci.org/bendrucker/dotfiles)

> My dotfiles for configuring macOS

Linux friendly, outside of [`macos/`](macos/) and a [`Brewfile`](Brewfile) for dependency management. I use this repo for both home and work.

Highlights include:

* zsh with the minimal [pure](https://github.com/sindresorhus/pure) prompt
* Sane defaults for programming languages I use

## Installing

```sh
git clone https://github.com/bendrucker/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
scripts/bootstrap
```

## Usage

The project is organized into logical "topic" folders. Scripts are organized into topic folders according to functionality (e.g. HTTP utilities in `http/`) and may be organized by type (aliases, functions, etc.) within a topic folder.

- **bin/**: Anything in `bin/` will get added to `$PATH`.
- **./\**/Brewfile**: Defines packages to install via Homebrew, including Homebrew Cask for GUIs.
- **\*/\*.zsh**: Any files ending in `.zsh` are loaded.
- **\*/path.zsh**: Any file named `path.zsh` is loaded first and is
  expected to setup `$PATH` or similar.
- **\*/completion.zsh**: Any file named `completion.zsh` is loaded
  last and is expected to setup autocomplete.
- **\*/\*.symlink**: Any files ending in `*.symlink` get symlinked into `$HOME` by `script/bootstrap`.

## Prior Art

* [holman](https://github.com/holman/dotfiles): Boostrap/install scripts, initial ZSH config, colorization

## License

[MIT](license)
