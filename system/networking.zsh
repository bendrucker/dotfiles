# ip addresses
alias ip="dig +short myip.opendns.com @resolver1.opendns.com"
alias localip="ifconfig | grep 'inet ' | grep -v 127.0.0.1 | awk '{print $2}'"

# dns
alias flushdns="dscacheutil -flushcache"
