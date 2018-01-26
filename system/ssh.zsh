alias keygen="ssh-keygen -t rsa -b 4096 -N '' -f"

local default="$HOME/.ssh/id_rsa"

if [ ! -f "$default" ]
then
  mkdir -p "$(dirname $default)"
  keygen "$default" -C "$(git config --get user.email)"
  ssh-add "$default"
fi