#!/usr/bin/env zsh

# Check if we're in an SSH or Mosh session
#
# SSH environment variables (set by OpenSSH):
# - SSH_CLIENT: client IP, client port, server port (space-separated)
# - SSH_CONNECTION: client IP, client port, server IP, server port (space-separated)
# - SSH_TTY: path to the tty device associated with the current session
# See: https://linux.die.net/man/1/ssh
#
# Mosh detection:
# - MOSH_SERVER environment variables are used for server configuration
# - LC_IDENTIFICATION may contain mosh-related information in some configurations
# - Mosh runs over SSH initially, so SSH variables may also be present
# See: https://github.com/mobile-shell/mosh/issues/738
is_remote_session() {
  # SSH detection - any of these indicate an SSH session
  [ -n "${SSH_CLIENT:-}" ] || [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_TTY:-}" ] || \
  # Mosh detection - less standardized, but these are commonly present
  [ -n "${MOSH:-}" ] || [ -n "${MOSH_SERVER:-}" ] || \
  # Additional Mosh detection via locale variable
  [[ "${LC_IDENTIFICATION:-}" == *mosh* ]]
}