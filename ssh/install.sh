#!/usr/bin/env bash

set -e

# SSH config requires sudo, skip in non-interactive mode
if [[ "${DOTFILES_INTERACTIVE:-1}" != "1" ]]; then
  exit 0
fi

# Copy SSH daemon configuration to system directory
sudo cp "$(dirname "$0")/200-require-key-auth.conf" /etc/ssh/sshd_config.d/

# Reload SSH daemon based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    sudo launchctl kickstart -k system/com.openssh.sshd
else
    sudo systemctl reload sshd
fi

echo "SSH configuration updated to require public key authentication"