#!/usr/bin/env bash

set -e

# SSH config requires sudo, skip in non-interactive mode
if [[ -n "${NONINTERACTIVE-}" ]]; then
  exit 0
fi

# Copy SSH daemon configuration to system directory
sudo cp "$(dirname "$0")"/*.conf /etc/ssh/sshd_config.d/

# Reload SSH daemon based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    sudo launchctl kickstart -k system/com.openssh.sshd
else
    sudo systemctl reload sshd
fi

echo "SSH daemon configuration updated"
