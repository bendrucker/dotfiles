converge () {
  local ENVIRONMENT="$1-$2"
  echo "converging $ENVIRONMENT"
  knife ssh "chef_environment:$ENVIRONMENT" "sudo chef-client"
}