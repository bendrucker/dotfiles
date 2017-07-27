utail () {
  ssh "$@" 'sudo tail -f /var/log/user-data.log'
}