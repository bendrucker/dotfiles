#!/usr/bin/env zsh

# Inside tmux, point SSH_AUTH_SOCK at the stable symlink that the client-attached
# hook keeps repointed to the connected device's forwarded agent. This keeps
# ssh-add -l and direct agent consumers in sync with the device used for signing
# (git signing here is GPG, so this does not affect it). The -S guard means local
# shells, where the link is absent or dangling, keep their default agent.
if [[ -n $TMUX && -S ~/.ssh/agent.sock ]]; then
  export SSH_AUTH_SOCK=~/.ssh/agent.sock
fi
