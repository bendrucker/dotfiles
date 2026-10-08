# Git

## Commit Signing

Commits are signed with an SSH key held in Secretive, so the private half never leaves the Secure Enclave. Each machine has its own key, so the key and the switch that turns signing on live in `~/.config/git/config.local` (template in `config.local.example`). A machine without one commits unsigned.

1. In Secretive, create a key named `Git Signing` with authentication turned off. A key that asks for Touch ID refuses every signature an agent requests, and a rebase asks once per commit.
2. Print its public half. macOS blocks reading Secretive's exported `.pub` files from outside its container, so ask the agent:

   ```sh
   SSH_AUTH_SOCK=~/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh ssh-add -L | grep Git-Signing
   ```

3. In `config.local`, set `user.signingkey` to `key::` followed by that line, and turn on `commit.gpgsign` and `tag.gpgSign`.
4. Write `~/.config/git/allowed_signers` as your email followed by the same key, which is what `git log --show-signature` checks against.
5. Add the key to GitHub as a **Signing Key** at <https://github.com/settings/ssh/new>.

`gpg.ssh.program` is `bin/git-ssh-sign`, which points `ssh-keygen` at Secretive's socket whenever Secretive is running. `ssh-keygen` signs through `$SSH_AUTH_SOCK` alone, and in a herdr pane that is herdr's agent, which holds none of Secretive's keys.

Secretive refuses to sign while the Mac is locked, whatever the key's authentication setting. The nightly sync commits with `--no-gpg-sign` for that reason.
