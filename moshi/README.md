# moshi

`moshi-hook` is the Mac side of the Moshi iOS client. Claude Code hooks feed it, and it pushes notifications and approval prompts to the phone. The formula and its launchd service are declared in `claude/Brewfile`. This topic links its settings file, `config.toml`, into `$XDG_CONFIG_HOME/moshi/`.

The same directory holds `config.json` and `host.json`. Those carry pairing and host state, so they stay unmanaged.

## Settings

`config.toml` uses the TOML keys under `[gateway]`. `moshi-hook set` lists each one by its dashed name (`suppress-push-while-unlocked` is `suppress_push_while_unlocked`). `set` edits the file through the symlink, so a setting changed from the CLI shows up as a diff here.

The daemon reads booleans at startup. After a change lands, restart it:

```sh
moshi-hook service restart
```

`install.sh` and `reload.sh` don't run that restart. A restart drops the daemon's WebSocket and any approval in flight, and the nightly upgrade must not take live work down. A change takes effect at the next restart or login.

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
