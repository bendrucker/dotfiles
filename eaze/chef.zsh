eaze-converge () {
  local ENVIRONMENT="$1-$2"
  echo "converging $ENVIRONMENT"
  knife ssh "chef_environment:$ENVIRONMENT" "sudo chef-client"
}

eaze-restart () {
  local ENVIRONMENT="$1-$2"
  echo "restarting $ENVIRONMENT"
  knife ssh "chef_environment:$ENVIRONMENT" "sudo supervisorctl restart all"
}