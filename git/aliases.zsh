# Use `hub` as our git wrapper:
# http://defunkt.github.com/hub/

hub_path=$(which hub)
if (( $+commands[hub] ))
then
  alias git=$hub_path
fi

alias gc='git commit'
alias gco='git checkout'
alias gb='git branch'
