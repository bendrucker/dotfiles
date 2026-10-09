# Git

## Commit Signing

Commits are signed with an SSH key held in Secretive, so the private half never leaves the Secure Enclave. To set up a machine, create a Secretive key named `Git Signing` with authentication turned off, then run `scripts/install`. A key that asks for Touch ID refuses every signature an agent requests, and a rebase asks once per commit.

`install-signing` finds that key (`--name` picks another) and writes it into `~/.config/git/config.local` along with the switches that turn signing on. It adds the key to `allowed_signers` and registers it with GitHub the first time it sees it. A machine without the key commits unsigned.

`bin/git-ssh-sign` is `gpg.ssh.program`. It points `ssh-keygen` at Secretive's socket, because `ssh-keygen` signs through `$SSH_AUTH_SOCK` alone, and in a herdr pane that is herdr's agent, which doesn't hold Secretive's keys. Secretive refuses to sign while the Mac is locked, so the nightly sync commits with `--no-gpg-sign`.

## Credentials

SSH through Secretive is the transport for GitHub. When HTTPS needs credentials, `gh auth git-credential` supplies them for `github.com` and `gist.github.com`, and other hosts keep the `osxkeychain` helper. `git-credential-osxkeychain` is re-signed with every Homebrew git upgrade, which drops its keychain grant and brings the access prompt back. `gh` reads the keychain through Apple's signed `security` tool, so its grant holds. The block sits after the `config.local` include so a helper set there cannot follow it.
