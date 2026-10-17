# Homebrew

## Externally Managed Casks

The nightly job has no terminal, so a cask upgrade that needs sudo fails with `sudo: a terminal is required`. That leaves a real app directory in the Caskroom, and every later run fails on `It seems there is already an App at '<caskroom path>'`. Both stop once nothing attempts the upgrade.

The nightly job avoids those upgrades in two ways:

- For casks declaring `auto_updates`, `homebrew/mise.toml` exports `HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS` when `scripts/brew-leave-self-updating` says so. Key this on the `auto_updates` flag, never on a list of cask tokens. First installs ignore the variable.
- `bin/dotfiles-upgrade` holds back the casks that `scripts/brew-root-casks` names and files them for a hand run.

Never use `--adopt` or Brewfile `args:` to fix a cask upgrade. `brew bundle` already adopts on install, and its upgrade path runs `brew upgrade --cask <token>` with no arguments. `HOMEBREW_CASK_OPTS` carries only the `--*dir` options, `--language`, `--require-sha`, and `--no-binaries`.
