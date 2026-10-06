# moshi

`moshi-hook` is the Mac side of the Moshi iOS client. Claude Code hooks feed it, and it pushes notifications and approval prompts to the phone. The formula and its launchd service are declared in `claude/Brewfile`. This topic links its settings file, `config.toml`, into `$XDG_CONFIG_HOME/moshi/`.

The same directory holds `config.json` and `host.json`. Those carry pairing and host state, so they stay unmanaged.

## Settings

`config.toml` uses the TOML keys under `[gateway]`. `moshi-hook set` lists each one by its dashed name (`suppress-push-while-unlocked` is `suppress_push_while_unlocked`). `set` edits the file through the symlink, so a setting changed from the CLI shows up as a diff here.

The daemon reads its settings only at startup, and a Homebrew upgrade leaves the old binary running. `reload.sh` restarts it with `moshi-hook service restart` when either changed since the last restart it applied. It compares `moshi-hook version` and a hash of `config.toml` against the fingerprint stored in `$XDG_STATE_HOME/dotfiles/moshi-hook.applied`.

`bin/dotfiles-reload` runs it from `scripts/install`, the nightly upgrade, and any `dotfiles sync` that moved the tree. `scripts/install` runs `brew bundle` first, so the nightly upgrade restarts the daemon onto a new release in the same run. A `brew upgrade` by hand applies at the next install. Each run logs the restart, or the skip and why. A failed restart leaves the fingerprint unwritten and retries on the next run. A stopped daemon gets no restart, since it reads both when it next starts.

A restart drops any approval in flight through moshi-hook. One in flight during the nightly upgrade is unlikely, and a setting or upgrade that never applies is the worse failure. This is the one `reload.sh` in the repo that restarts a server.

## Claude Code Hooks

`claude-hooks.ts` runs `moshi-hook install --target claude`, which writes moshi's entries into the claude repo's `user/settings.json`. `bin/claude-sync` calls it after each pull, because the pull rewrites that file, and after herdr's install so the discard of herdr's edit leaves moshi's entries in place. A diff it leaves there is a moshi upgrade to commit to the claude repo.

## Push Suppression

`suppress_push_while_unlocked` sends agent pushes only while the macOS console is locked. The daemon reads the lock state from `IOConsoleLocked` in the IORegistry. This Mac starts the screensaver after 300 seconds idle and locks immediately when it does, so pushes resume about 5 minutes after you walk away. Locking by hand starts them right away.

Known gaps:

- Approval prompts may still push while unlocked. The binary has an `extApprovalBypassesUnlocked` check alongside the suppressor, and the docs don't say which approvals it exempts.
- Per-decision logging is unconfirmed. The binary contains the message `agent-event push silenced while Mac is unlocked`, but the setting has never been on here, so whether `moshi-hook logs` shows it at the default level is unknown. Until it does, a suppressed push and one that was never sent look the same.

## Verification

1. `moshi-hook set suppress-push-while-unlocked` prints `on`.
2. `ioreg -n Root -d1 -a | grep -A1 IOConsoleLocked` prints `<false/>` while you're at the Mac.
3. While unlocked, finish a Claude Code turn. The phone stays silent.
4. Ask Claude Code to run `sleep 30`, then lock with ⌃⌘Q before it finishes. The completion push arrives on the phone.
