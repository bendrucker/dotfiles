# moshi

Mac-side config for `moshi-hook`, the daemon that pushes Claude Code events to the Moshi iOS app. The formula is in `claude/Brewfile`. `config.json` and `host.json` hold pairing state and stay unmanaged.

- `config.toml` is linked into `$XDG_CONFIG_HOME/moshi/`. `suppress_push_while_unlocked` sends pushes only while the Mac is locked, about 5 minutes after you leave with the current screensaver and lock settings.
- `reload.ts` restarts the daemon when `config.toml` or the installed version changed since its last restart. The daemon reads both only at startup.
- `claude-hooks.ts` runs `moshi-hook install --target claude`. `bin/claude-sync` calls it after each pull of the claude repo.

Approval prompts may bypass suppression (`extApprovalBypassesUnlocked` in the binary), and whether suppressed pushes are logged is unconfirmed.

To verify, check that `moshi-hook set suppress-push-while-unlocked` prints `on`. Then finish a Claude Code turn while unlocked and expect no push. Lock with ⌃⌘Q during a `sleep 30` turn and expect one.
