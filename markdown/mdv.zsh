#!/usr/bin/env zsh

# mdv starts only for TERM_PROGRAM values it knows, though Rex speaks the Kitty
# graphics protocol it needs.
# TODO(posaune0423/mdv#14): drop once the terminal probe merges and the pin moves past it
if [[ $TERM_PROGRAM == rex ]]; then
  alias mdv='TERM_PROGRAM=ghostty mdv'
fi
