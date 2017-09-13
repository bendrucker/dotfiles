# Use `hub` as our git wrapper:
# http://defunkt.github.com/hub/

hub_path=$(which hub)
if (( $+commands[hub] ))
then
  alias git=$hub_path
fi

alias g='git'

alias gb='git branch'
alias gc='git commit'
alias gco='git checkout'
alias gp='git push'
alias gr='git rebase'
alias gs='git status'

alias pr='git pull-request'