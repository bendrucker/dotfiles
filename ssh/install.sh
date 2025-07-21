#!/usr/bin/env bash

set -e

# Copy SSH daemon configuration to system directory
sudo cp "$(dirname "$0")/200-require-key-auth.conf" /etc/ssh/sshd_config.d/

# Reload SSH daemon
sudo launchctl kickstart -k system/com.openssh.sshd

echo "SSH configuration updated to require public key authentication"