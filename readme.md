# dotfiles

> My dotfiles for configuring OS X

## Installing

```sh
git clone https://github.com/bendrucker/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
script/bootstrap
```

## Usage

The project is organized into logical "topic" folders. Scripts are organized into topic folders according to functionality (e.g. HTTP utilities in `http/`) and may be organized by type (aliases, functions, etc.) within a topic folder.

- **bin/**: Anything in `bin/` will get added to `$PATH`.
- **Brewfile**: Defines packages to install via Homebrew, including Homebrew Cask for GUIs.
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
