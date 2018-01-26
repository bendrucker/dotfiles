#!/usr/bin/env sh

# ip addresses
alias ip="dig +short myip.opendns.com @resolver1.opendns.com"
alias localip="ipconfig getifaddr en0"

# dns
alias flushdns="dscacheutil -flushcache"
